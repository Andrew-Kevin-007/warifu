// Build a `lbc/1` Loss Bound Certificate (docs/16 §2, §3). `assembleCertificate` is pure (state in, document out);
// `buildFromReader` adds the chain reads and, last, runs the verifier on its own output so `validity` is a measured
// result, not an assumption (a certificate built at an old block is already STALE and says so).
//
// What this never does: read a clock (the caller passes `nowSeconds`), read a file (the CLI/API pass parsed JSON),
// hold a key (a publisher signature is attached by a caller-supplied signing function), or lower a bound because
// an optional input said so (docs/16 §2.3).
import { computeCertHash } from "@symbolon/schemas";
import type { Address, Hex32, LossBoundCertificate } from "@symbolon/schemas";
import { getAddress } from "viem";
import type { LoadedPolicy } from "@symbolon/policy";
import { checkPolicyWithinVault, makeVaultConfig } from "@symbolon/policy";
import { computeBody } from "./body";
import type { Body } from "./body";
import { matchArtifact } from "./code-match";
import type { ParsedArtifact } from "./code-match";
import { ALGORITHM_ID, ALGORITHM_VERSION, ASSUMPTIONS, DEFAULT_CONFIRMATIONS, DEFAULT_DETECTION_LATENCY_SECONDS_NUMBER, DEFAULT_FRESHNESS_SECONDS, EXCLUSIONS, NOTE_BURST, NOTE_OWNER_APPROVALS, NOTE_POLICY_LOOSER, NOTE_TERMS_UNVERIFIED, NOTE_VALIDATION_NONE } from "./texts";
import type { ParsedTerms } from "./terms";
import { ChainReadError, LbcError } from "./types";
import type { BlockHeader, BlockRef, ChainReader, VaultState } from "./types";
import { buildValidation } from "./validation";
import { toValidity, verifyCertificate } from "./verify";

type Cert = LossBoundCertificate;

export interface AssembleOptions {
  readonly vault: Address;
  readonly chainId: bigint;
  /** `algorithm.gitSha`: the code revision that computed this certificate (lowercase hex, 7-40). */
  readonly gitSha: string;
  readonly detectionLatencySeconds?: number;
  readonly freshnessSeconds?: number;
  readonly nowSeconds: bigint;
  readonly terms?: readonly ParsedTerms[];
  readonly policy?: LoadedPolicy;
  /** profile used to read the vault's limits for the policy comparison (affects sandbox-only limits) */
  readonly policyProfile?: "production" | "sandbox";
  /** parsed `symbolon-blast-validation/1` results file, if any */
  readonly validationResults?: unknown;
  readonly artifact?: ParsedArtifact;
  /** runtime code at the vault, needed for the code match when an artifact is given */
  readonly onchainCode?: `0x${string}`;
}

function policyNotes(state: VaultState, o: AssembleOptions): { policyHash: Hex32 | null; notes: string[] } {
  if (o.policy === undefined) return { policyHash: null, notes: [] };
  try {
    const vaultCfg = makeVaultConfig({
      profile: o.policyProfile ?? "production",
      tokenDecimals: state.tokenDecimals,
      perTxCap: state.perTxCap,
      dailyCap: state.dailyCap,
      hourlyCap: state.hourlyCap,
      humanThreshold: state.humanThreshold,
      ringSize: Number(state.ringSize),
    });
    const violations = checkPolicyWithinVault(o.policy, vaultCfg);
    // POLICY_LOOSER_THAN_VAULT is a flag, never silently ignored (docs/08 §4); other violations (decimals) are flagged too.
    return { policyHash: o.policy.policyHash as Hex32, notes: violations.length > 0 ? [`${NOTE_POLICY_LOOSER} (${violations.map((v) => v.code).join(", ")})`] : [] };
  } catch (cause) {
    throw new LbcError("POLICY_INVALID", "the supplied policy could not be compared with the vault", { cause });
  }
}

/** Assemble and hash the certificate from state already read. Pure. `validity` is set to UNVERIFIED until verified. */
export function assembleCertificate(state: VaultState, header: BlockHeader, o: AssembleOptions): { cert: Cert; body: Body } {
  const detection = o.detectionLatencySeconds ?? DEFAULT_DETECTION_LATENCY_SECONDS_NUMBER;
  const body = computeBody(state, header, { vault: o.vault, chainId: o.chainId, detectionLatencySeconds: detection, terms: o.terms });
  const { policyHash, notes: pNotes } = policyNotes(state, o);

  const notes: string[] = [NOTE_OWNER_APPROVALS];
  const h1m = body.bounds.T3c.horizons.find((h) => h.label === "1m");
  const h24 = body.bounds.T3c.horizons.find((h) => h.label === "24h");
  if (h1m === undefined || h24 === undefined) throw new LbcError("INVALID_STATE", "the 1 m and 24 h horizons are required");
  if (state.hourlyCap === 0n && h1m.value === h24.value && h24.value !== "0") notes.push(NOTE_BURST);
  notes.push(...pNotes);
  if (body.weakEvidence?.perEngagement.some((e) => e.status === "TERMS_UNVERIFIED")) notes.push(NOTE_TERMS_UNVERIFIED);

  let validation: Cert["validation"] = null;
  if (o.validationResults !== undefined) {
    // The build-time code check: MATCH only if the on-chain code equals the artifact AND the artifact is the code the
    // results were produced against; anything else with an artifact is a MISMATCH, no artifact is NOT_CHECKED.
    const results = o.validationResults;
    let status: "MATCH" | "NOT_CHECKED" | "MISMATCH" = "NOT_CHECKED";
    let built = buildValidation(results, BigInt(h24.value), "NOT_CHECKED");
    if (o.artifact !== undefined && built.validation !== null) {
      const m = o.onchainCode === undefined ? ({ status: "MISMATCH" } as const) : matchArtifact(o.onchainCode, o.artifact);
      status = m.status === "MATCH" && built.validation.codeMatch.validatedCodeHash.toLowerCase() === o.artifact.codeHash.toLowerCase() ? "MATCH" : "MISMATCH";
      built = buildValidation(results, BigInt(h24.value), status);
    }
    validation = built.validation;
    notes.push(...built.notes);
  }
  if (validation === null) notes.push(NOTE_VALIDATION_NONE);

  const freshness = o.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS;
  const draft: Cert = {
    schema: "lbc/1",
    algorithm: { id: ALGORITHM_ID, version: ALGORITHM_VERSION, gitSha: o.gitSha, detectionLatencySeconds: detection },
    subject: body.subject,
    asOf: body.asOf,
    inputs: { ...body.inputs, policyHash },
    bounds: body.bounds,
    assumptions: ASSUMPTIONS.map((a) => ({ id: a.id, text: a.text })),
    exclusions: EXCLUSIONS.map((x) => ({ id: x.id, text: x.text })),
    notes,
    validation,
    validity: { status: "UNVERIFIED", reasons: [], checkedAt: Number(o.nowSeconds), freshnessSeconds: freshness },
    certHash: `0x${"00".repeat(32)}` as Hex32,
  };
  return { cert: { ...draft, certHash: computeCertHash(draft) }, body };
}

export interface BuildFromReaderOptions extends Omit<AssembleOptions, "vault" | "chainId" | "onchainCode"> {
  /** default "finalized" (falls back to latest minus DEFAULT_CONFIRMATIONS inside the reader, V-29) */
  readonly block?: BlockRef;
}

/** Read the chain, assemble, then verify our own output at the latest block to fill `validity`. */
export async function buildFromReader(reader: ChainReader, vaultInput: string, o: BuildFromReaderOptions): Promise<{ cert: Cert; body: Body }> {
  const vault = normalizeAddress(vaultInput);
  const chainId = await reader.chainId();
  const header = await reader.header(o.block ?? "finalized");
  if (header === null) throw new LbcError("BLOCK_UNAVAILABLE", "the node does not know the requested block");
  let state: VaultState;
  try {
    state = await reader.vaultState(vault, header.number);
  } catch (e) {
    if (e instanceof ChainReadError && e.code === "STATE_UNAVAILABLE") throw new LbcError("BLOCK_UNAVAILABLE", "the node has no state for the requested block (use a newer block or an archive node)", { cause: e });
    throw e;
  }
  const code = o.artifact === undefined ? undefined : await reader.code(vault, header.number);
  const again = await reader.header(header.number);
  if (again === null || again.hash !== header.hash) throw new LbcError("REORG_DURING_BUILD", "the block changed while the certificate was being built; run it again");

  const { cert, body } = assembleCertificate(state, header, { ...o, vault, chainId, ...(code === undefined ? {} : { onchainCode: code }) });
  const v = await verifyCertificate(cert, reader, {
    nowSeconds: o.nowSeconds,
    ...(o.freshnessSeconds === undefined ? {} : { freshnessSeconds: o.freshnessSeconds }),
    ...(o.terms === undefined ? {} : { terms: o.terms }),
    ...(o.artifact === undefined ? {} : { artifact: o.artifact }),
  });
  if (v.outcome === "MISMATCH") throw new LbcError("INVALID_STATE", "the certificate we just built does not recompute (internal inconsistency); refusing to publish");
  const validity = toValidity(v, Number(o.nowSeconds), o.freshnessSeconds ?? DEFAULT_FRESHNESS_SECONDS);
  return { cert: { ...cert, validity }, body };
}

function normalizeAddress(a: string): Address {
  try {
    return getAddress(a) as Address;
  } catch (cause) {
    throw new LbcError("INVALID_OPTION", "not a valid vault address", { cause });
  }
}

export { DEFAULT_CONFIRMATIONS };

/**
 * Attach the OPTIONAL publisher signature (EIP-191 over certHash). The signer is a function the caller owns: this
 * package never sees a key. The signature is a convenience, never the evidence (RT-20): `verify` recomputes everything
 * without it and only checks that, if present, it is valid.
 */
export async function attachPublisher(cert: Cert, publisher: { address: Address; signMessage(message: { raw: `0x${string}` }): Promise<`0x${string}`> }): Promise<Cert> {
  const sig = (await publisher.signMessage({ raw: cert.certHash })).toLowerCase() as `0x${string}`;
  return { ...cert, publisher: { address: publisher.address, sig } };
}
