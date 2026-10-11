// fixtures/applicability.json (docs/07 §3.1): which attack applies to which target, with a reason for every row.
// N/A rows are listed in the report, never silently dropped and never counted as "blocked". WP-22 STARTS the
// file: symbolon and b1 are decided here; b0 and b2 carry only the rows docs/07 §3.1 already fixes
// (ATK-17 and ATK-22/23/24) and `applicable: null` ("not yet decided") elsewhere, which WP-36 resolves when it
// vendors the arc-escrow path (b0) and writes b2. VERIFIER reviews the finished file.
import * as z from "zod";
import { ATTACK_IDS, AttackIdSchema, TARGET_IDS, TargetIdSchema, type AttackId, type TargetId } from "./types";

export const ApplicabilityRowSchema = z.strictObject({
  attackId: AttackIdSchema,
  target: TargetIdSchema,
  /** null = not decided yet (WP-36); the report must treat it as unresolved, not as applicable or blocked. */
  applicable: z.boolean().nullable(),
  reason: z.string().min(1).max(400),
});
export type ApplicabilityRow = z.infer<typeof ApplicabilityRowSchema>;

export const ApplicabilityFileSchema = z.strictObject({
  schema: z.literal("applicability/1"),
  note: z.string().max(600),
  rows: z.array(ApplicabilityRowSchema),
});
export type ApplicabilityFile = z.infer<typeof ApplicabilityFileSchema>;

const NO_APPROVAL_GATE = "no approval gate or explainer exists in this target (docs/07 §3.1)";
const NO_SIGNER_BOUNDS = "no equivalent of a compromised signer bounded by contract limits (docs/07 §3.1)";

const B1_SPECIFIC: Partial<Record<AttackId, string>> = {
  "ATK-01": "B1 records the payment when it submits the transaction, so a lost relay leaves a recorded payment that never happened.",
  "ATK-02": "B1 releases to the address in the document: any wallet in the model's output is paid.",
  "ATK-03": "B1 has no category budget; the attack maps to what it books and pays.",
  "ATK-08": "B1 re-submits on a retry, so a timeout followed by a retry can pay twice.",
  "ATK-09": "B1 trusts the agent's record of what it paid.",
  "ATK-13": "B1's naive escrow has no payee registration, so an unregistered vendor can be paid.",
  "ATK-14": "B1 has no velocity or aggregate limits.",
  "ATK-15": "B1 releases on the model's {valid, confidence} output; evidence claims in the document reach the validator.",
  "ATK-16": "B1 does not enforce timestamps (the arc-escrow pattern stores them and never reads them).",
  "ATK-19": "B1 has no screening; a blocklisted payee makes the transfer revert after the decision.",
};

function reasonFor(attackId: AttackId, target: TargetId): { applicable: boolean | null; reason: string } {
  if (target === "symbolon") {
    return {
      applicable: true,
      reason: attackId === "ATK-17" ? "executed at contract level with the kernel signer key against the vault (docs/07 §6)" : "Symbolon runs every ATK; the same oracle decides loss (docs/15 §2)",
    };
  }
  if (attackId === "ATK-17") return { applicable: false, reason: NO_SIGNER_BOUNDS };
  if (attackId === "ATK-22" || attackId === "ATK-23" || attackId === "ATK-24") return { applicable: false, reason: NO_APPROVAL_GATE };
  if (target === "b1") {
    return {
      applicable: true,
      reason: B1_SPECIFIC[attackId] ?? "B1 is a release-on-model-output pattern: the document reaches its validator unchanged and the output decides the release.",
    };
  }
  return {
    applicable: null,
    reason:
      target === "b0"
        ? "undecided: depends on the mapping onto arc-escrow's job/deliverable API, which WP-36 vendors and publishes"
        : "undecided: depends on which controls the b2 hardening (schema check, allowlist, caps, invoice-number check) covers; WP-36 writes b2",
  };
}

export function buildApplicability(): ApplicabilityFile {
  const rows: ApplicabilityRow[] = [];
  for (const attackId of ATTACK_IDS) {
    for (const target of TARGET_IDS) rows.push({ attackId, target, ...reasonFor(attackId, target) });
  }
  return {
    schema: "applicability/1",
    note: "Started by WP-22. symbolon and b1 are decided; b0 and b2 are completed by WP-36. Rows with applicable=null are unresolved and must not be counted as applicable or as blocked.",
    rows,
  };
}
