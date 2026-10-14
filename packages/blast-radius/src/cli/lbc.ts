// `pnpm lbc build|verify|explain` (docs/16 §5.1). The edge of the library: reads files and the clock, talks to the RPC the
// USER names (their own endpoint is the point of verification), prints, and exits. All logic lives in src/lbc.
//   pnpm lbc build  <vault> --rpc <url> [--block N|finalized|latest] [--terms <dir>] [--policy <file>] [--validation <file>]
//                          [--artifact <foundry-artifact.json>] [--out cert.json] [--git-sha <sha>]
//   pnpm lbc verify <vault | cert.json> --rpc <url> [--block N] [--artifact <file>] [--terms <dir>] [--policy <file>]
//                          [--api <base-url>] [--require-archive] [--json]
//   pnpm lbc explain cert.json
// Exit codes: 0 VALID, 10 STALE, 20 UNVERIFIED, 30 MISMATCH, 2 usage/build error. The RPC URL is never printed or logged
// (it may carry an API key).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LossBoundCertificateSchema } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import { loadPolicy } from "@symbolon/policy";
import type { LoadedPolicy } from "@symbolon/policy";
import { createPublicClient, http, isAddress } from "viem";
import { buildFromReader, parseArtifact, parseTermsDocument, verifyCertificate, certificateView, EXIT_CODES, LbcError } from "../lbc/index";
import type { ParsedArtifact, ParsedTerms, VerifyResult } from "../lbc/index";
import { viemChainReader } from "../lbc/viem-reader";

const MAX_FILE = 32 * 1024 * 1024;
const MAX_TERMS_FILES = 256;
const MAX_TERMS_BYTES = 512 * 1024;
const MAX_API_BYTES = 2 * 1024 * 1024;

class Usage extends Error {}

interface Args {
  readonly positional: string[];
  readonly flags: Map<string, string | true>;
}
const VALUE_FLAGS = new Set(["rpc", "block", "terms", "policy", "validation", "artifact", "out", "git-sha", "api", "detection-seconds", "freshness-seconds"]);
const BOOL_FLAGS = new Set(["json", "require-archive"]);

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (BOOL_FLAGS.has(name)) flags.set(name, true);
    else if (VALUE_FLAGS.has(name)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Usage(`--${name} needs a value`);
      flags.set(name, v);
    } else throw new Usage(`unknown option --${name}`);
  }
  return { positional, flags };
}
const flag = (a: Args, n: string): string | undefined => {
  const v = a.flags.get(n);
  return typeof v === "string" ? v : undefined;
};

function readBounded(path: string, max = MAX_FILE): string {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Usage(`not a file: ${path}`);
  if (statSync(path).size > max) throw new Usage(`file too large: ${path}`);
  return readFileSync(path, "utf8");
}
function readJson(path: string, max = MAX_FILE): unknown {
  try {
    return JSON.parse(readBounded(path, max));
  } catch (e) {
    if (e instanceof Usage) throw e;
    throw new Usage(`not valid JSON: ${path}`);
  }
}

function loadTerms(dir: string): ParsedTerms[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Usage(`--terms must be a directory: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  if (files.length > MAX_TERMS_FILES) throw new Usage(`more than ${String(MAX_TERMS_FILES)} terms files`);
  const out: ParsedTerms[] = [];
  for (const f of files) {
    try {
      const t = parseTermsDocument(readJson(join(dir, f), MAX_TERMS_BYTES));
      if (t === null) console.error(`warning: ${f} is not an engagement terms document; ignored (its engagement counts as TERMS_UNVERIFIED)`);
      else out.push(t);
    } catch (e) {
      console.error(`warning: ${f} ignored (${e instanceof Usage ? e.message : "unreadable"})`);
    }
  }
  return out;
}

function loadPolicyFile(path: string): LoadedPolicy {
  try {
    return loadPolicy(readBounded(path, 128 * 1024));
  } catch (e) {
    if (e instanceof Usage) throw e;
    throw new Usage(`policy rejected: ${e instanceof Error ? e.name : "error"}`);
  }
}

function loadArtifactFile(path: string): ParsedArtifact {
  try {
    return parseArtifact(readJson(path));
  } catch (e) {
    if (e instanceof LbcError) throw new Usage(e.message);
    throw e;
  }
}

function gitSha(a: Args): string {
  const given = flag(a, "git-sha");
  if (given !== undefined) {
    if (!/^[0-9a-f]{7,40}$/.test(given)) throw new Usage("--git-sha must be 7-40 lowercase hex characters");
    return given;
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    /* fall through */
  }
  throw new Usage("could not read the git revision; pass --git-sha");
}

function reader(a: Args) {
  const rpc = flag(a, "rpc") ?? process.env["LBC_RPC_URL"];
  if (rpc === undefined) throw new Usage("--rpc <url> is required (use your own endpoint; the URL is never printed)");
  let url: URL;
  try {
    url = new URL(rpc);
  } catch {
    throw new Usage("--rpc is not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Usage("--rpc must be http(s)");
  return viemChainReader(createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 1 }) }));
}

function intFlag(a: Args, n: string): number | undefined {
  const v = flag(a, n);
  if (v === undefined) return undefined;
  if (!/^\d{1,9}$/.test(v)) throw new Usage(`--${n} must be a non-negative integer`);
  return Number(v);
}

const nowSeconds = (): bigint => BigInt(Math.floor(Date.now() / 1000));

async function cmdBuild(a: Args): Promise<number> {
  const vault = a.positional[1];
  if (vault === undefined || !isAddress(vault)) throw new Usage("build needs a vault address");
  const blockFlag = flag(a, "block");
  const block = blockFlag === undefined || blockFlag === "finalized" ? "finalized" : blockFlag === "latest" ? "latest" : /^\d{1,15}$/.test(blockFlag) ? BigInt(blockFlag) : null;
  if (block === null) throw new Usage("--block must be a number, finalized or latest");
  const terms = flag(a, "terms");
  const policy = flag(a, "policy");
  const validation = flag(a, "validation");
  const artifact = flag(a, "artifact");
  const detection = intFlag(a, "detection-seconds");
  const freshness = intFlag(a, "freshness-seconds");
  const { cert } = await buildFromReader(reader(a), vault, {
    block,
    gitSha: gitSha(a),
    nowSeconds: nowSeconds(),
    ...(detection === undefined ? {} : { detectionLatencySeconds: detection }),
    ...(freshness === undefined ? {} : { freshnessSeconds: freshness }),
    ...(terms === undefined ? {} : { terms: loadTerms(terms) }),
    ...(policy === undefined ? {} : { policy: loadPolicyFile(policy) }),
    ...(validation === undefined ? {} : { validationResults: readJson(validation) }),
    ...(artifact === undefined ? {} : { artifact: loadArtifactFile(artifact) }),
  });
  const text = `${JSON.stringify(cert, null, 2)}\n`;
  const out = flag(a, "out");
  if (out === undefined) process.stdout.write(text);
  else {
    writeFileSync(out, text);
    console.error(`certificate ${cert.certHash} written (${cert.validity.status}).`);
  }
  console.error(certificateView(cert).headline);
  return 0;
}

async function fetchPublished(api: string, vault: string): Promise<unknown> {
  const u = new URL(`/v1/certificates/${vault}`, api);
  const loopback = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Usage("--api must be https (or loopback http)");
  const auth = process.env["LBC_API_AUTH"];
  const res = await fetch(u, { headers: auth === undefined ? {} : { authorization: auth }, redirect: "error" });
  if (!res.ok) throw new Usage(`the API answered ${String(res.status)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > MAX_API_BYTES) throw new Usage("the API response is too large");
  const body = JSON.parse(new TextDecoder().decode(buf)) as { certificate?: unknown };
  // The server's own `validity`/`verification` are ignored: we recompute everything from the document.
  return body.certificate ?? body;
}

function printVerify(r: VerifyResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
    return;
  }
  console.log(`RESULT ${r.outcome} (exit ${String(r.exitCode)})${r.mode === null ? "" : `  MODE=${r.mode}`}`);
  for (const f of r.findings) console.log(`  ${f}`);
  if (r.diffs.length > 0) {
    console.log("  diff (document -> recomputed):");
    for (const d of r.diffs) console.log(`    ${d.path}: ${d.document} -> ${d.recomputed}`);
  }
  console.log(`  code match: ${r.codeMatch.status}${r.codeMatch.status === "NOT_CHECKED" ? " (pass --artifact to check the on-chain code)" : ""}`);
  if (r.publisher !== "ABSENT") console.log(`  publisher signature: ${r.publisher} (a convenience, never the evidence)`);
}

async function cmdVerify(a: Args): Promise<number> {
  const target = a.positional[1];
  if (target === undefined) throw new Usage("verify needs a vault address or a certificate file");
  let doc: unknown;
  if (isAddress(target)) {
    const api = flag(a, "api");
    if (api === undefined) throw new Usage("verify <vault> fetches the published certificate: pass --api <base-url>, or verify a cert.json file");
    doc = await fetchPublished(api, target);
  } else doc = readJson(target);
  const terms = flag(a, "terms");
  const policy = flag(a, "policy");
  const artifact = flag(a, "artifact");
  const blockFlag = flag(a, "block");
  if (blockFlag !== undefined && !/^\d{1,15}$/.test(blockFlag)) throw new Usage("--block must be a number");
  const freshness = intFlag(a, "freshness-seconds");
  const r = await verifyCertificate(doc, reader(a), {
    nowSeconds: nowSeconds(),
    ...(blockFlag === undefined ? {} : { latestBlock: BigInt(blockFlag) }),
    ...(freshness === undefined ? {} : { freshnessSeconds: freshness }),
    ...(terms === undefined ? {} : { terms: loadTerms(terms) }),
    ...(policy === undefined ? {} : { policy: loadPolicyFile(policy) }),
    ...(artifact === undefined ? {} : { artifact: loadArtifactFile(artifact) }),
    ...(a.flags.get("require-archive") === true ? { requireArchive: true } : {}),
  });
  printVerify(r, a.flags.get("json") === true);
  return r.exitCode;
}

function cmdExplain(a: Args): number {
  const file = a.positional[1];
  if (file === undefined) throw new Usage("explain needs a certificate file");
  const p = LossBoundCertificateSchema.safeParse(readJson(file));
  if (!p.success) throw new Usage("not a valid lbc/1 certificate");
  const cert: LossBoundCertificate = p.data;
  const v = certificateView(cert);
  console.log("EXCLUSIONS (read these first)");
  for (const x of v.exclusions) console.log(`  ${x.id}: ${x.text}`);
  console.log(`\n${v.headline}`);
  console.log(v.alarmed);
  console.log(`\nstatus recorded in the file: ${cert.validity.status} (re-run verify; this is not evidence)`);
  console.log("\nhorizon      bound           binding");
  for (const h of v.horizons) console.log(`  ${h.label.padEnd(5)} ${h.valueDisplay.padStart(16)}  ${h.binding.join(",")}`);
  console.log("\nASSUMPTIONS");
  for (const x of cert.assumptions) console.log(`  ${x.id}: ${x.text}`);
  for (const n of cert.notes) console.log(`NOTE ${n}`);
  console.log(`\n${v.validation.sentence}`);
  console.log(`\nverify it yourself:\n  ${v.verifyCommand}`);
  return 0;
}

async function main(): Promise<number> {
  try {
    const a = parseArgs(process.argv.slice(2));
    switch (a.positional[0]) {
      case "build":
        return await cmdBuild(a);
      case "verify":
        return await cmdVerify(a);
      case "explain":
        return cmdExplain(a);
      default:
        throw new Usage("usage: pnpm lbc build|verify|explain ... (see docs/16 section 5.1)");
    }
  } catch (e) {
    if (e instanceof Usage || e instanceof LbcError) {
      console.error(`error: ${e.message}`);
      return EXIT_CODES.USAGE;
    }
    // Never print node-supplied text or the RPC URL: class name only.
    console.error(`error: ${e instanceof Error ? e.name : "unexpected failure"}`);
    return EXIT_CODES.USAGE;
  }
}

process.exitCode = await main();
