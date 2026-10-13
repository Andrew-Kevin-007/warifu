// `pnpm verify-receipt <file|hash>`: the logic, with every side effect injected (CliIo) so it is fully testable.
// The only process-edge code is node-io.ts (fs, fetch, RPC) and bin/verify-receipt.mjs (argv, exit code).
//
// What the output may contain: our own fixed text, hex values and addresses, enumerations and numbers that passed the
// strict schemas. It never prints receipt prose (check details, explanations, invoice text), and it prints nothing taken
// from a receipt that did not verify except the hash recomputed from its bytes.
import type { RawLog } from "@symbolon/chain";
import {
  eip712DomainSeparator,
  symbolonDomain,
  type Address,
  type Eip712Domain,
  type Hex32,
  type ISODateTime,
  type Receipt,
  type ReasonCode,
  type Verdict,
} from "@symbolon/schemas";
import { checkReleasedAnchor } from "../anchor";
import { MAX_RECEIPT_FILE_BYTES } from "../json";
import { verifyReceiptJson, type AnchorOutcome, type VerifyOptions, type VerifyReport } from "../verify";
import { USAGE, parseCliArgs, type CliChain, type CliOptions } from "./args";

export const EXIT_VERIFIED = 0;
export const EXIT_NOT_VERIFIED = 1;
export const EXIT_USAGE = 2;

/** Upper bound on eth_getLogs requests one run may make (a tiny --log-range over a long history must not hammer an RPC). */
export const MAX_LOG_REQUESTS = 2_000n;

/** The read-only chain edge. Real implementation: node-io.ts (viem over HTTP). Tests inject a fake JSON-RPC server. */
export interface ChainReader {
  chainId(): Promise<number>;
  kernelSigner(vault: Address): Promise<Address>;
  tokenDecimals(vault: Address): Promise<number>;
  domainSeparator(vault: Address): Promise<Hex32>;
  latestBlock(): Promise<bigint>;
  /** Raw logs of the vault's `Released` event for `intentId` in [fromBlock, toBlock]. */
  releasedLogs(vault: Address, intentId: Hex32, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
}

export interface CliIo {
  readFile(path: string, maxBytes: number): Promise<Uint8Array>;
  fetchText(url: string, maxBytes: number): Promise<string>;
  chain(rpcUrl: string): ChainReader;
  stdout(text: string): void;
  stderr(text: string): void;
}

type Guarded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

/** A short, injection-safe label for an exception from the I/O edge (never its message: it may echo paths or URLs). */
function label(e: unknown): string {
  const code = typeof e === "object" && e !== null && "code" in e ? (e as { code: unknown }).code : undefined;
  const raw = typeof code === "string" ? code : e instanceof Error ? e.name : "error";
  return raw.replace(/[^A-Za-z0-9_-]/g, "?").slice(0, 40);
}

async function guarded<T>(what: string, fn: () => Promise<T>): Promise<Guarded<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, message: `${what} failed (${label(e)})` };
  }
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.kind === "help") {
    io.stdout(`${USAGE}\n`);
    return EXIT_VERIFIED;
  }
  if (parsed.kind === "usage-error") {
    io.stderr(`verify-receipt: ${parsed.message}\n\n${USAGE}\n`);
    return EXIT_USAGE;
  }
  try {
    return await execute(parsed.options, io);
  } catch {
    io.stderr("verify-receipt: unexpected error; nothing was verified\n");
    return EXIT_USAGE;
  }
}

/** What the chain edge (or its absence) contributes to the verification. */
interface Plan {
  readonly domain: Eip712Domain;
  readonly expectedSigner: Address | undefined;
  readonly checkAnchor: VerifyOptions["checkAnchor"];
}

async function buildDomain(chainId: number, vault: Address): Promise<Guarded<Eip712Domain>> {
  return guarded("building the EIP-712 domain", async () => symbolonDomain(chainId, vault));
}

/** Offline: the domain comes from --chain-id and --vault; nothing is read from a chain. */
async function planOffline(o: CliOptions, chainId: number, io: CliIo): Promise<Plan | number> {
  const built = await buildDomain(chainId, o.vault);
  if (!built.ok) return fail(io, built.message);
  return { domain: built.value, expectedSigner: o.signer, checkAnchor: undefined };
}

/** With --rpc: chain id, domain separator, kernel signer and token decimals are READ; the Released event is searched. */
async function planRpc(o: CliOptions, chain: Extract<CliChain, { kind: "rpc" }>, io: CliIo): Promise<Plan | number> {
  const reader = io.chain(chain.rpc);
  const rpcChainId = await guarded("RPC eth_chainId", () => reader.chainId());
  if (!rpcChainId.ok) return fail(io, rpcChainId.message);
  if (chain.chainId !== undefined && chain.chainId !== rpcChainId.value) return fail(io, "--chain-id does not match the RPC's chain id");
  const built = await buildDomain(rpcChainId.value, o.vault);
  if (!built.ok) return fail(io, built.message);
  const domain = built.value;

  const separator = await guarded("RPC domainSeparator()", () => reader.domainSeparator(o.vault));
  if (!separator.ok) return fail(io, separator.message);
  if (separator.value !== eip712DomainSeparator(domain)) {
    return finishEarly(o, io, "DOMAIN_MISMATCH", "the vault's EIP-712 domain separator differs from (name, version, chain id, --vault)");
  }
  let expectedSigner = o.signer;
  if (expectedSigner === undefined) {
    const signer = await guarded("RPC kernelSigner()", () => reader.kernelSigner(o.vault));
    if (!signer.ok) return fail(io, signer.message);
    expectedSigner = signer.value;
  }
  const tokenDecimals = await guarded("RPC tokenDecimals()", () => reader.tokenDecimals(o.vault));
  if (!tokenDecimals.ok) return fail(io, tokenDecimals.message);
  const decimals = tokenDecimals.value;

  const checkAnchor = async (receipt: Receipt, receiptHash: Hex32): Promise<AnchorOutcome> => {
    const logs = await fetchReleasedLogs(reader, o.vault, receipt.decision.intentId, chain.fromBlock, chain.logRange);
    return typeof logs === "string" ? { status: "FAIL", detail: logs } : checkReleasedAnchor(receipt, receiptHash, logs, { vault: o.vault, decimals });
  };
  return { domain, expectedSigner, checkAnchor };
}

function fail(io: CliIo, message: string): number {
  io.stderr(`verify-receipt: ${message}
`);
  return EXIT_USAGE;
}

async function execute(o: CliOptions, io: CliIo): Promise<number> {
  const input = o.input;

  // --- 1. the receipt bytes -----------------------------------------------------------------------------------
  const source =
    input.kind === "file"
      ? await guarded(`reading ${JSON.stringify(input.path)}`, () => io.readFile(input.path, MAX_RECEIPT_FILE_BYTES))
      : await guarded("fetching the receipt", () => io.fetchText(`${input.baseUrl}/api/public/receipt/${input.hash}`, MAX_RECEIPT_FILE_BYTES));
  if (!source.ok) return fail(io, source.message);

  // --- 2. the chain edge (optional) ---------------------------------------------------------------------------
  const plan = o.chain.kind === "offline" ? await planOffline(o, o.chain.chainId, io) : await planRpc(o, o.chain, io);
  if (typeof plan === "number") return plan;

  // --- 3. verify ----------------------------------------------------------------------------------------------
  const options: VerifyOptions = {
    domain: plan.domain,
    allowUnpinnedSigner: o.allowUnpinnedSigner,
    ...(plan.expectedSigner === undefined ? {} : { expectedSigner: plan.expectedSigner }),
    ...(input.kind === "hash" ? { expectedReceiptHash: input.hash } : {}),
    ...(plan.checkAnchor === undefined ? {} : { checkAnchor: plan.checkAnchor }),
  };
  const report = await verifyReceiptJson(source.value, options);
  io.stdout(o.json ? `${JSON.stringify(jsonReport(report), null, 2)}
` : humanReport(report));
  return report.ok ? EXIT_VERIFIED : EXIT_NOT_VERIFIED;
}

function finishEarly(o: CliOptions, io: CliIo, code: string, detail: string): number {
  io.stdout(o.json ? `${JSON.stringify({ ok: false, error: code, detail }, null, 2)}\n` : `RESULT: NOT VERIFIED\n  ${code}: ${detail}\n`);
  return EXIT_NOT_VERIFIED;
}

/** The intent's `Released` logs in [from, latest], in chunks when a range is given. A string is a refusal reason. */
async function fetchReleasedLogs(reader: ChainReader, vault: Address, intentId: Hex32, from: bigint, range: bigint | undefined): Promise<RawLog[] | string> {
  const latest = await reader.latestBlock();
  if (range === undefined) return reader.releasedLogs(vault, intentId, from, latest);
  if (latest >= from && (latest - from) / range >= MAX_LOG_REQUESTS) return `the search would need more than ${MAX_LOG_REQUESTS.toString()} eth_getLogs requests; raise --log-range or --from-block`;
  const logs: RawLog[] = [];
  for (let start = from; start <= latest; start += range) {
    const end = start + range - 1n < latest ? start + range - 1n : latest;
    logs.push(...(await reader.releasedLogs(vault, intentId, start, end)));
  }
  return logs;
}

interface Facts {
  readonly verdict: Verdict;
  readonly reasons: readonly ReasonCode[];
  readonly intentId: Hex32;
  readonly policyHash: Hex32;
  readonly issuedAt: ISODateTime;
  readonly payee: Address | null;
  readonly releaseAmountBaseUnits: string | null;
}

function facts(report: VerifyReport): Facts | null {
  const r = report.receipt;
  if (r === null) return null;
  const d = r.decision;
  return {
    verdict: d.verdict,
    reasons: d.reasons,
    intentId: d.intentId,
    policyHash: d.policyHash,
    issuedAt: r.issuedAt,
    payee: d.payee,
    releaseAmountBaseUnits: d.releaseAmountBaseUnits,
  };
}

function jsonReport(report: VerifyReport): unknown {
  return { ok: report.ok, receiptHash: report.receiptHash, signer: report.signer, signerPinned: report.signerPinned, checks: report.checks, facts: facts(report) };
}

function humanReport(report: VerifyReport): string {
  const lines = [`verify-receipt: ${report.receiptHash ?? "(not a receipt)"}`];
  for (const c of report.checks) lines.push(`  ${c.status.padEnd(4)}  ${c.id.padEnd(9)}  ${c.detail}`);
  lines.push(`RESULT: ${report.ok ? "VERIFIED" : "NOT VERIFIED"}`);
  const f = facts(report);
  if (f !== null) {
    lines.push(`  verdict ${f.verdict}  reasons ${f.reasons.length > 0 ? f.reasons.join(",") : "none"}  intent ${f.intentId}`);
    lines.push(`  policy ${f.policyHash}  issued ${f.issuedAt}`);
  }
  if (report.ok && !report.signerPinned) {
    lines.push(`WARNING: the signer was not pinned. This proves only that the key behind ${report.signer ?? "?"} signed these exact bytes, not that it is the vault's kernel signer.`);
  }
  return `${lines.join("\n")}\n`;
}
