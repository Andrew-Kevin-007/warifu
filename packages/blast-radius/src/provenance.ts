// Provenance carried by every Blast Radius results file (docs/08 §5.2.7, docs/16 §5.3, WP-25 brief):
//   { gitSha, seeds, modelIds, promptHashes, vaultRuntimeCodeHash, tool versions }
// A results file with no vaultRuntimeCodeHash says nothing about any deployment: consumers must render it as
// "not validated for this deployment" and the claim language drops "empirically tested" accordingly
// (docs/08 §11, INV-18). Pure: the caller reads git and the build artifact and passes the values in.
import * as z from "zod";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

export const ProvenanceSchema = z.strictObject({
  /** `git rev-parse HEAD` when the file was produced. */
  gitSha: z.string().regex(HEX40),
  /** true when the working tree had uncommitted changes (the sha then does not fully identify the code). */
  gitDirty: z.boolean(),
  /** Every PRNG seed that influenced the content. Empty only for fully deterministic content. */
  seeds: z.array(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)).max(10_000),
  /** LLM model ids used. Empty when no model was involved (Cut 7: no LLM red-team loop). */
  modelIds: z.array(z.string().min(1).max(200)).max(100),
  /** keccak256 of each prompt used, 0x-prefixed lowercase hex. */
  promptHashes: z.array(z.string().regex(HEX32)).max(10_000),
  /**
   * keccak256 of the vault runtime code (immutables zeroed) the numbers were produced against, or null when no
   * vault was executed (closed form only). null => "not validated for this deployment".
   */
  vaultRuntimeCodeHash: z.string().regex(HEX32).nullable(),
  tools: z.record(z.string().max(40), z.string().max(80)),
});
export type ResultProvenance = z.infer<typeof ProvenanceSchema>;

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(`PROVENANCE_INVALID: ${message}`);
    this.name = "ProvenanceError";
  }
}

/** Validate untrusted/parsed provenance. Throws ProvenanceError; never returns a partially valid object. */
export function parseProvenance(input: unknown): ResultProvenance {
  const r = ProvenanceSchema.safeParse(input);
  if (!r.success) {
    throw new ProvenanceError(r.error.issues.map((i) => `${i.path.map(String).join(".") || "$"}: ${i.message}`).join("; "));
  }
  if (r.data.modelIds.length > 0 && r.data.promptHashes.length === 0) {
    throw new ProvenanceError("modelIds were recorded but no promptHashes: an LLM result must name its prompts");
  }
  if (r.data.modelIds.length === 0 && r.data.promptHashes.length > 0) {
    throw new ProvenanceError("promptHashes were recorded but no modelIds");
  }
  return Object.freeze(r.data);
}

export type CodeMatch = "NOT_VALIDATED_FOR_THIS_DEPLOYMENT" | "MATCH" | "MISMATCH";

/**
 * Does a results file speak for the deployed code? `deployedRuntimeCodeHash` is the hash of the code at the
 * address in question (immutables zeroed). A missing hash on either side is NOT a match (fail closed).
 */
export function codeMatch(p: ResultProvenance, deployedRuntimeCodeHash: string | null): CodeMatch {
  if (p.vaultRuntimeCodeHash === null || deployedRuntimeCodeHash === null) return "NOT_VALIDATED_FOR_THIS_DEPLOYMENT";
  return p.vaultRuntimeCodeHash === deployedRuntimeCodeHash.toLowerCase() ? "MATCH" : "MISMATCH";
}
