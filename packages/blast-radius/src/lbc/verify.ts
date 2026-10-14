// Verify a Loss Bound Certificate by recomputation (docs/16 §5). The result is a pure function of the document and of
// what the supplied ChainReader answers; our signature, our server and our word are never consulted (RT-20).
//
// Outcomes (severity MISMATCH > UNVERIFIED > STALE > VALID; exit codes 0 / 30 / 20 / 10):
//   MISMATCH    recomputation at the stated block differs from the document, or its certHash/publisher signature does
//               not hold: forged or buggy. Field-level diff included.
//   UNVERIFIED  we could not establish the facts: wrong chain, block hash differs (wrong chain / reorg), any RPC call
//               failed or returned nothing, the vault has no code, the code does not match the validated build.
//               Fail closed: never VALID (docs/16 §1.2).
//   STALE       the document was right at its block but something that could make the bound too small has changed
//               since (config, engagements, a balance that was binding, freshness). Diff included.
//   VALID       recomputed at the stated block and nothing relevant changed.
//
// Time: `now = max(nowSeconds, latest block timestamp)`, so a skewed or rewound verifier clock can only make a
// certificate look OLDER, never fresher.
import { LossBoundCertificateSchema, computeCertHash } from "@symbolon/schemas";
import type { Address, Hex32, LossBoundCertificate } from "@symbolon/schemas";
import { getAddress, recoverMessageAddress } from "viem";
import type { LoadedPolicy } from "@symbolon/policy";
import { boundAlarmed } from "../bounds";
import type { BoundInputs, Term } from "../bounds";
import { assertVaultState, computeBody, computeBounds } from "./body";
import type { Body } from "./body";
import { matchArtifact } from "./code-match";
import type { ParsedArtifact } from "./code-match";
import { ALGORITHM_ID, ALGORITHM_VERSION, DEFAULT_FRESHNESS_SECONDS } from "./texts";
import type { ParsedTerms } from "./terms";
import { ChainReadError, LbcError } from "./types";
import type { BlockHeader, ChainReader, VaultState } from "./types";

type Cert = LossBoundCertificate;

export type VerifyOutcome = "VALID" | "STALE" | "UNVERIFIED" | "MISMATCH";
export const EXIT_CODES = Object.freeze({ VALID: 0, STALE: 10, UNVERIFIED: 20, MISMATCH: 30, USAGE: 2 } as const);

/** The schema's validity reasons plus the ones only the verifier reports. */
export type VerifyReason =
  | Cert["validity"]["reasons"][number]
  | "CERT_HASH_MISMATCH"
  | "FIELD_MISMATCH"
  | "PUBLISHER_SIG_INVALID"
  | "SCHEMA_INVALID"
  | "ALGORITHM_UNSUPPORTED"
  | "CONFIG_HASH_INCONSISTENT";

export interface FieldDiff {
  readonly path: string;
  /** what the document says */
  readonly document: string;
  /** what the verifier computed / read */
  readonly recomputed: string;
}

export interface VerifyOptions {
  readonly nowSeconds: bigint;
  readonly freshnessSeconds?: number;
  /** compare staleness against this block instead of `latest` (reproducible diffs) */
  readonly latestBlock?: bigint;
  readonly terms?: readonly ParsedTerms[];
  readonly policy?: LoadedPolicy;
  readonly artifact?: ParsedArtifact;
  /** refuse the latest-with-digest-equality fallback (default false) */
  readonly requireArchive?: boolean;
}

export type VerifyMode = "at-block" | "latest-with-digest-equality";

export interface LatestSummary {
  readonly blockNumber: string;
  readonly blockHash: Hex32;
  readonly timestamp: string;
  readonly configHash: Hex32;
  readonly engagementsDigest: Hex32;
  readonly balanceBaseUnits: string;
  readonly sumRemainingBaseUnits: string;
  readonly activeEngagements: number;
  readonly paused: boolean;
  /** what the bounds would be if the certificate were rebuilt now */
  readonly horizons: Cert["bounds"]["T3c"]["horizons"];
}

export interface VerifyResult {
  readonly outcome: VerifyOutcome;
  readonly exitCode: number;
  readonly reasons: readonly VerifyReason[];
  readonly diffs: readonly FieldDiff[];
  readonly mode: VerifyMode | null;
  /** human-readable lines, each a fixed template (no untrusted text) */
  readonly findings: readonly string[];
  readonly latest: LatestSummary | null;
  readonly codeMatch: { readonly status: "MATCH" | "NOT_CHECKED" | "MISMATCH"; readonly artifactCodeHash: string | null };
  readonly publisher: "ABSENT" | "VALID" | "INVALID";
  readonly certHashRecomputed: Hex32 | null;
}

const SEVERITY: Record<VerifyOutcome, number> = { VALID: 0, STALE: 1, UNVERIFIED: 2, MISMATCH: 3 };

class Collector {
  outcome: VerifyOutcome = "VALID";
  readonly reasons: VerifyReason[] = [];
  readonly diffs: FieldDiff[] = [];
  readonly findings: string[] = [];
  mode: VerifyMode | null = null;
  latest: LatestSummary | null = null;
  codeMatch: VerifyResult["codeMatch"] = { status: "NOT_CHECKED", artifactCodeHash: null };
  publisher: VerifyResult["publisher"] = "ABSENT";
  certHashRecomputed: Hex32 | null = null;

  raise(outcome: VerifyOutcome, reason: VerifyReason | null, finding: string): void {
    if (SEVERITY[outcome] > SEVERITY[this.outcome]) this.outcome = outcome;
    if (reason !== null && !this.reasons.includes(reason)) this.reasons.push(reason);
    this.findings.push(`${outcome}${reason === null ? "" : `: ${reason}`}: ${finding}`);
  }
  diff(path: string, document: string, recomputed: string): void {
    this.diffs.push({ path, document, recomputed });
  }
  finish(): VerifyResult {
    return Object.freeze({
      outcome: this.outcome,
      exitCode: EXIT_CODES[this.outcome],
      reasons: [...this.reasons],
      diffs: [...this.diffs],
      mode: this.mode,
      findings: [...this.findings],
      latest: this.latest,
      codeMatch: this.codeMatch,
      publisher: this.publisher,
      certHashRecomputed: this.certHashRecomputed,
    });
  }
}

/** Describes an error without echoing node-supplied text (untrusted): only our own codes and class names. */
function describeError(e: unknown): string {
  if (e instanceof ChainReadError || e instanceof LbcError) return e.code;
  return e instanceof Error ? e.name : "unknown";
}

/** Field-level diff of two plain JSON values; paths like `bounds.T3c.horizons[3].value`. */
export function diffJson(path: string, a: unknown, b: unknown, out: FieldDiff[]): void {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      if (i >= a.length) out.push({ path: `${path}[${String(i)}]`, document: "(absent)", recomputed: JSON.stringify(b[i]) });
      else if (i >= b.length) out.push({ path: `${path}[${String(i)}]`, document: JSON.stringify(a[i]), recomputed: "(absent)" });
      else diffJson(`${path}[${String(i)}]`, a[i], b[i], out);
    }
    return;
  }
  if (isObj(a) && isObj(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) {
      const p = path === "" ? k : `${path}.${k}`;
      if (!(k in a)) out.push({ path: p, document: "(absent)", recomputed: JSON.stringify(b[k]) });
      else if (!(k in b)) out.push({ path: p, document: JSON.stringify(a[k]), recomputed: "(absent)" });
      else diffJson(p, a[k], b[k], out);
    }
    return;
  }
  if (a !== b) out.push({ path, document: JSON.stringify(a), recomputed: JSON.stringify(b) });
}
function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function major(v: string): string {
  return v.split(".")[0] ?? "";
}

function docBoundInputs(doc: Cert, balance: bigint = BigInt(doc.inputs.balanceBaseUnits)): BoundInputs {
  return {
    B: balance,
    P: BigInt(doc.inputs.limits.perTxCap),
    D: BigInt(doc.inputs.limits.dailyCap),
    H: BigInt(doc.inputs.limits.humanThreshold),
    hc: BigInt(doc.inputs.limits.hourlyCap),
    N: BigInt(doc.inputs.limits.ringSize),
    sumRemaining: BigInt(doc.inputs.sumRemainingBaseUnits),
  };
}

function summarizeLatest(state: VaultState, header: BlockHeader, body: Body | null): LatestSummary {
  return {
    blockNumber: header.number.toString(),
    blockHash: header.hash,
    timestamp: header.timestamp.toString(),
    configHash: state.configHash.toLowerCase() as Hex32,
    engagementsDigest: (body?.inputs.engagementsDigest ?? "0x") as Hex32,
    balanceBaseUnits: state.balance.toString(),
    sumRemainingBaseUnits: body?.inputs.sumRemainingBaseUnits ?? "0",
    activeEngagements: body?.inputs.activeEngagements ?? 0,
    paused: state.paused,
    horizons: body?.bounds.T3c.horizons ?? [],
  };
}

/** Pure recomputation of the document's computed part from state: used for `at-block` comparison. */
function compareAtBlock(doc: Cert, body: Body, o: VerifyOptions, c: Collector): void {
  const d: FieldDiff[] = [];
  diffJson("subject", doc.subject, body.subject, d);
  diffJson("asOf", doc.asOf, body.asOf, d);
  const { policyHash: docPolicy, ...docInputs } = doc.inputs;
  const { policyHash: _p, ...bodyInputs } = body.inputs;
  diffJson("inputs", docInputs, bodyInputs, d);
  if (o.policy !== undefined && docPolicy !== o.policy.policyHash) d.push({ path: "inputs.policyHash", document: JSON.stringify(docPolicy), recomputed: JSON.stringify(o.policy.policyHash) });
  // T1 weak-evidence exposure is recomputed only when terms were supplied and the document claims a number.
  const docWeak = doc.bounds.T1.weakEvidenceExposure;
  const skipWeak = o.terms === undefined || docWeak === "NOT_COMPUTED";
  const docBounds = skipWeak ? { ...doc.bounds, T1: { ...doc.bounds.T1, weakEvidenceExposure: "SKIPPED" } } : doc.bounds;
  const recBounds = skipWeak ? { ...body.bounds, T1: { ...body.bounds.T1, weakEvidenceExposure: "SKIPPED" } } : body.bounds;
  diffJson("bounds", docBounds, recBounds, d);
  if (skipWeak && docWeak !== "NOT_COMPUTED") c.findings.push("INFO: T1 weakEvidenceExposure was not recomputed (no --terms supplied).");
  for (const x of d) c.diff(x.path, x.document, x.recomputed);
  if (d.length > 0) c.raise("MISMATCH", "FIELD_MISMATCH", `${String(d.length)} field(s) differ from the recomputation at block ${String(doc.asOf.blockNumber)}`);
}

export async function verifyCertificate(input: unknown, reader: ChainReader, o: VerifyOptions): Promise<VerifyResult> {
  const c = new Collector();

  // --- 0. the document itself ------------------------------------------------------------------------------------
  const parsed = LossBoundCertificateSchema.safeParse(input);
  if (!parsed.success) {
    c.raise("UNVERIFIED", "SCHEMA_INVALID", `the document is not a valid lbc/1 certificate (${String(parsed.error.issues.length)} issue(s))`);
    return c.finish();
  }
  const doc = parsed.data;
  if (doc.algorithm.id !== ALGORITHM_ID || major(doc.algorithm.version) !== major(ALGORITHM_VERSION)) {
    c.raise("UNVERIFIED", "ALGORITHM_UNSUPPORTED", "this verifier implements a different algorithm version than the document names");
    return c.finish();
  }
  let vault: Address;
  try {
    vault = getAddress(doc.subject.vault) as Address;
  } catch {
    c.raise("UNVERIFIED", "SCHEMA_INVALID", "the vault address is not valid");
    return c.finish();
  }
  const recomputedHash = computeCertHash(doc);
  c.certHashRecomputed = recomputedHash;
  if (recomputedHash !== doc.certHash) {
    c.diff("certHash", doc.certHash, recomputedHash);
    c.raise("MISMATCH", "CERT_HASH_MISMATCH", "certHash does not equal the hash of the document's content");
  }
  if (doc.publisher !== undefined) {
    try {
      const signer = await recoverMessageAddress({ message: { raw: doc.certHash }, signature: doc.publisher.sig as `0x${string}` });
      c.publisher = signer.toLowerCase() === doc.publisher.address.toLowerCase() ? "VALID" : "INVALID";
    } catch {
      c.publisher = "INVALID";
    }
    if (c.publisher === "INVALID") c.raise("MISMATCH", "PUBLISHER_SIG_INVALID", "the publisher signature does not verify (it is a convenience only, but a false one means the document was altered)");
  }

  // --- 1. provenance -----------------------------------------------------------------------------------------------
  const N = BigInt(doc.asOf.blockNumber);
  let statedHeader: BlockHeader | null;
  try {
    const chainId = await reader.chainId();
    if (chainId !== BigInt(doc.subject.chainId)) {
      c.diff("subject.chainId", String(doc.subject.chainId), chainId.toString());
      c.raise("UNVERIFIED", "BLOCK_HASH_MISMATCH", "the RPC endpoint is on a different chain than the document");
      return c.finish();
    }
    statedHeader = await reader.header(N);
  } catch (e) {
    c.raise("UNVERIFIED", "RPC_ERROR", `provenance reads failed (${describeError(e)})`);
    return c.finish();
  }
  if (statedHeader === null || statedHeader.hash !== doc.asOf.blockHash) {
    c.diff("asOf.blockHash", doc.asOf.blockHash, statedHeader?.hash ?? "(unknown block)");
    c.raise("UNVERIFIED", "BLOCK_HASH_MISMATCH", "the stated block is not on this chain's canonical history (wrong chain, or a reorganization)");
    return c.finish();
  }

  // --- latest ------------------------------------------------------------------------------------------------------
  let latestHeader: BlockHeader | null;
  let stateL: VaultState;
  let codeL: `0x${string}`;
  try {
    latestHeader = await reader.header(o.latestBlock ?? "latest");
    if (latestHeader === null) throw new LbcError("BLOCK_UNAVAILABLE", "no latest block");
    if (latestHeader.number < N) throw new LbcError("BLOCK_UNAVAILABLE", "the node is behind the certificate's block");
    stateL = await reader.vaultState(vault, latestHeader.number);
    codeL = await reader.code(vault, latestHeader.number);
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(codeL)) throw new LbcError("INVALID_STATE", "the vault address has no code at the latest block");
    assertVaultState(stateL, latestHeader);
  } catch (e) {
    c.raise("UNVERIFIED", e instanceof LbcError && e.code === "CONFIG_HASH_INCONSISTENT" ? "CONFIG_HASH_INCONSISTENT" : "RPC_ERROR", `latest-block reads failed or returned an impossible vault (${describeError(e)})`);
    return c.finish();
  }

  // --- 2. recompute at the stated block ---------------------------------------------------------------------------
  const detection = doc.algorithm.detectionLatencySeconds;
  let stateN: VaultState | null = null;
  if (latestHeader.number === N) {
    stateN = stateL;
  } else {
    try {
      stateN = await reader.vaultState(vault, N);
    } catch (e) {
      if (e instanceof ChainReadError && e.code === "STATE_UNAVAILABLE" && o.requireArchive !== true) {
        stateN = null;
      } else {
        c.raise("UNVERIFIED", "RPC_ERROR", `reading the vault at the stated block failed (${describeError(e)})`);
        return c.finish();
      }
    }
  }

  const bodyOpts = { vault, chainId: BigInt(doc.subject.chainId), detectionLatencySeconds: detection, terms: o.terms } as const;
  let bodyL: Body | null = null;
  try {
    bodyL = computeBody(stateL, latestHeader, bodyOpts);
  } catch (e) {
    c.raise("UNVERIFIED", "RPC_ERROR", `the latest vault state is not one the closed form accepts (${describeError(e)})`);
    return c.finish();
  }
  c.latest = summarizeLatest(stateL, latestHeader, bodyL);

  if (stateN !== null) {
    c.mode = "at-block";
    try {
      const bodyN = computeBody(stateN, statedHeader, bodyOpts);
      compareAtBlock(doc, bodyN, o, c);
    } catch (e) {
      c.raise("UNVERIFIED", e instanceof LbcError && e.code === "CONFIG_HASH_INCONSISTENT" ? "CONFIG_HASH_INCONSISTENT" : "RPC_ERROR", `the vault state at the stated block is not one the closed form accepts (${describeError(e)})`);
      return c.finish();
    }
  } else {
    // Archive state is not available: recompute from latest and require the digests to be equal (docs/16 §5.2 step 2).
    c.mode = "latest-with-digest-equality";
    c.findings.push("INFO: MODE=latest-with-digest-equality (the node has no state at the stated block); balance and sumRemaining at that block cannot be re-read.");
    if (stateL.configHash.toLowerCase() === doc.inputs.configHash && bodyL.inputs.engagementsDigest === doc.inputs.engagementsDigest) {
      const d: FieldDiff[] = [];
      diffJson("subject", { ...doc.subject }, { ...bodyL.subject }, d);
      diffJson("inputs.limits", doc.inputs.limits, bodyL.inputs.limits, d);
      // The bounds are fully determined by (limits, balance, sumRemaining); take the last two from the document.
      try {
        const { bounds } = computeBounds(docBoundInputs(doc), detection, doc.bounds.T1.weakEvidenceExposure);
        diffJson("bounds", doc.bounds, bounds, d);
      } catch (e) {
        c.raise("UNVERIFIED", "RPC_ERROR", `the document's inputs are not ones the closed form accepts (${describeError(e)})`);
        return c.finish();
      }
      for (const x of d) c.diff(x.path, x.document, x.recomputed);
      if (d.length > 0) c.raise("MISMATCH", "FIELD_MISMATCH", `${String(d.length)} field(s) differ from the recomputation`);
    }
  }

  // --- 3. staleness at latest (docs/16 §5.2 table) ----------------------------------------------------------------
  const sameConfig = stateL.configHash.toLowerCase() === doc.inputs.configHash;
  if (!sameConfig) {
    c.diff("inputs.configHash", doc.inputs.configHash, stateL.configHash.toLowerCase());
    const lim = bodyL.inputs.limits;
    for (const k of ["perTxCap", "dailyCap", "hourlyCap", "humanThreshold"] as const) if (doc.inputs.limits[k] !== lim[k]) c.diff(`inputs.limits.${k}`, doc.inputs.limits[k], lim[k]);
    if (doc.inputs.limits.ringSize !== lim.ringSize) c.diff("inputs.limits.ringSize", String(doc.inputs.limits.ringSize), String(lim.ringSize));
    c.raise("STALE", "CONFIG_CHANGED", "the vault configuration changed since the certificate's block (owner, kernel signer, guardian, limits or delays); the certificate does not cover the new configuration");
  }
  const sameEngagements = bodyL.inputs.engagementsDigest === doc.inputs.engagementsDigest;
  if (!sameEngagements) {
    c.diff("inputs.engagementsDigest", doc.inputs.engagementsDigest, bodyL.inputs.engagementsDigest);
    c.diff("inputs.activeEngagements", String(doc.inputs.activeEngagements), String(bodyL.inputs.activeEngagements));
    c.diff("inputs.sumRemainingBaseUnits", doc.inputs.sumRemainingBaseUnits, bodyL.inputs.sumRemainingBaseUnits);
    c.raise("STALE", "ENGAGEMENTS_CHANGED", "an engagement was registered, closed, re-paid, re-windowed or its terms changed since the certificate's block");
  }
  const docB = BigInt(doc.inputs.balanceBaseUnits);
  if (stateL.balance > docB) {
    let balanceBinds = false;
    try {
      const inputs = docBoundInputs(doc);
      const alarmedBinding: readonly Term[] = boundAlarmed(inputs, BigInt(detection)).binding;
      balanceBinds = doc.bounds.T3c.horizons.some((h) => h.binding.includes("balance")) || alarmedBinding.includes("balance");
    } catch {
      balanceBinds = true; // fail closed: if we cannot tell, the balance counts as binding
    }
    if (balanceBinds) {
      c.diff("inputs.balanceBaseUnits", doc.inputs.balanceBaseUnits, stateL.balance.toString());
      c.raise("STALE", "BALANCE_INCREASED", "the vault balance increased and the balance is a binding term in at least one stated bound");
    } else {
      c.findings.push("INFO: the balance increased but is not binding in any stated bound (the minimum is set by another term): still valid.");
    }
  }
  if (sameConfig && sameEngagements && BigInt(bodyL.inputs.sumRemainingBaseUnits) > BigInt(doc.inputs.sumRemainingBaseUnits)) {
    // With identical engagements, remaining capacity can only fall (payments, time). A rise means the document understated it.
    c.diff("inputs.sumRemainingBaseUnits", doc.inputs.sumRemainingBaseUnits, bodyL.inputs.sumRemainingBaseUnits);
    c.raise("MISMATCH", "FIELD_MISMATCH", "remaining engagement capacity is larger now than the document states although the engagements are unchanged");
  }
  const now = o.nowSeconds > latestHeader.timestamp ? o.nowSeconds : latestHeader.timestamp;
  const freshness = BigInt(o.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS);
  if (now - BigInt(doc.asOf.timestamp) > freshness) {
    c.raise("STALE", "FRESHNESS_EXCEEDED", "the certificate is older than its freshness window; rebuild it");
  }

  // --- 4. code match (docs/16 §5.3) --------------------------------------------------------------------------------
  if (o.artifact !== undefined) {
    const m = matchArtifact(codeL, o.artifact);
    c.codeMatch = { status: m.status === "MATCH" ? "MATCH" : "MISMATCH", artifactCodeHash: o.artifact.codeHash };
    if (m.status !== "MATCH") c.raise("UNVERIFIED", "CODE_NOT_VALIDATED", "the vault's runtime code does not equal the supplied build (immutables zeroed)");
    else if (doc.validation !== null && doc.validation.codeMatch.validatedCodeHash.toLowerCase() !== o.artifact.codeHash.toLowerCase()) {
      c.codeMatch = { status: "MISMATCH", artifactCodeHash: o.artifact.codeHash };
      c.raise("UNVERIFIED", "CODE_NOT_VALIDATED", "the validation results in the certificate were produced against different bytecode than this build");
    }
  }
  if (doc.validation !== null && doc.validation.codeMatch.status === "MISMATCH") {
    c.raise("UNVERIFIED", "CODE_NOT_VALIDATED", "the certificate itself records that its validation results do not match the deployed code");
  }
  return c.finish();
}

/** The schema's `validity` block from a verification result (MISMATCH is recorded as UNVERIFIED: the schema has no fourth state). */
export function toValidity(v: VerifyResult, checkedAt: number, freshnessSeconds: number): Cert["validity"] {
  const allowed = new Set<string>(["BLOCK_HASH_MISMATCH", "CONFIG_CHANGED", "ENGAGEMENTS_CHANGED", "BALANCE_INCREASED", "FRESHNESS_EXCEEDED", "RPC_ERROR", "CODE_NOT_VALIDATED"]);
  const reasons = v.reasons.filter((r): r is Cert["validity"]["reasons"][number] => allowed.has(r));
  const status = v.outcome === "VALID" ? "VALID" : v.outcome === "STALE" ? "STALE" : "UNVERIFIED";
  return { status, reasons, checkedAt, freshnessSeconds };
}
