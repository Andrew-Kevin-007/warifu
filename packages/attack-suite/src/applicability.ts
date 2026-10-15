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

const B0_MAPPING =
  "mapping: the milestone is an escrow agreement whose beneficiary and amount are fixed at creation, the document is the deliverable the vendored validate-work route inspects (vendor/arc-escrow/VENDOR.md)";

/** B0 rows: measured on the vendored path, including the ones it holds by design (reported, never dropped). */
const B0_SPECIFIC: Partial<Record<AttackId, string>> = {
  "ATK-01": `A lost relay: the route stores the transaction and sets the agreement PENDING, CLOSED only by a COMPLETE webhook (modelled from the upstream webhook route). ${B0_MAPPING}.`,
  "ATK-02": "Holds by design: the beneficiary is the wallet fixed at agreement creation; a wallet printed in the document is never read. Measured, not assumed.",
  "ATK-03": "The route has no category or budget logic; it releases the agreement's amount to the agreement's beneficiary when the validator says HIGH.",
  "ATK-04": "Holds by design on amount: the paid amount is the agreement's, not the document's; a locale misread of the document cannot change it. Measured.",
  "ATK-05": "Holds by design on amount: the paid amount is the agreement's, not the document's. Measured.",
  "ATK-06": "Each milestone is its own agreement with its own fixed amount, so a compensating error has nothing to move. Measured.",
  "ATK-07": "The validator is asked whether the deliverable meets the task; a credit note is judged by the (SIMULATED) model, with no document-type rule in the route.",
  "ATK-08": "The route has no idempotency key; the escrow contract's withdrawnAmount makes a second withdraw() pay 0. Measured.",
  "ATK-09": "B0's ledger is written by the route after the SDK answers and by webhooks; there is no agent-narrated record to forge. Modelled from the upstream code.",
  "ATK-10": "Instructions inside the deliverable reach the model prompt unchanged (the file is base64-embedded as an image URL); payee and amount are still the agreement's. Measured with a SIMULATED model.",
  "ATK-11": "Holds by design: a swapped wallet in a document changes nothing; the beneficiary is fixed at agreement creation. Measured.",
  "ATK-12": "A renumbered or one-cent-different invoice for a milestone already withdrawn: the contract pays 0 the second time. Measured.",
  "ATK-13": "Holds by design: validate-work needs the circleContractId of an existing agreement; an unregistered vendor has none, so there is nothing to withdraw. Measured as a decline.",
  "ATK-14": "One agreement pays once; repeated deliverables for it hit the withdrawnAmount guard. There is no velocity logic in the route. Measured.",
  "ATK-15": "No evidence gating: the model's judgement of the uploaded file is the only gate, so a payee-supplied claim in the file reaches the release decision. Measured with a SIMULATED model.",
  "ATK-16": "The agreement stores no time window the route reads (the arc-escrow pattern stores a timestamp and never reads it). Measured.",
  "ATK-18": "Single model read; no second read and no consensus. Payee and amount are still the agreement's. Measured with a SIMULATED model.",
  "ATK-19": "A blocklist revert arrives as a FAILED webhook which sets the agreement back to LOCKED (modelled from the upstream webhook route).",
  "ATK-20": "A re-invoice of a milestone already withdrawn: the contract pays 0 the second time. Measured.",
  "ATK-21": "No terms logic: it pays the agreement's amount whatever terms the document states and whenever the validator says HIGH. Measured.",
};

const B2_SPECIFIC: Partial<Record<AttackId, string>> = {
  "ATK-01": "B2 records the payment at submission as B1 does (same architecture); only the duplicate-number check differs.",
  "ATK-02": "Allowlist (H2): a wallet that is on the allowlist (any payee of the tenant) is paid even if it is not this engagement's payee; an unlisted wallet is declined. Measured.",
  "ATK-03": "No category budget in B2 (caps are per transaction and per day only). Measured.",
  "ATK-04": "Schema (H1) declines an ambiguous separator; a confidently mis-parsed amount inside the caps is paid. Measured.",
  "ATK-05": "The per-tx cap (H3) bounds a scale error; a confident sub-cap misread is paid. Measured.",
  "ATK-06": "No milestone binding: the document's amount is paid as printed, within the caps. Measured.",
  "ATK-07": "H1 declines docType CREDIT_NOTE when the model reads it faithfully; a sign-flipped read is paid. Measured.",
  "ATK-08": "H4: a retry carries the same invoice number and is declined. Measured.",
  "ATK-09": "B2 books what the agent reports, as B1.",
  "ATK-10": "Same validator as B1 plus H1-H4; a steered address is declined by the allowlist unless it is a listed payee. Measured.",
  "ATK-11": "Allowlist (H2) declines an unlisted wallet; a listed one is paid. Measured.",
  "ATK-12": "H4 catches an exact repeat of the number only; a renumbered or changed-by-a-cent invoice is paid within the caps. Measured.",
  "ATK-13": "Allowlist (H2) declines an unregistered vendor. Measured.",
  "ATK-14": "Per-tx and 24 h caps (H3) stop a split once the daily total is reached; there is no velocity rule. Measured.",
  "ATK-15": "No evidence gating in B2. Measured.",
  "ATK-16": "No time window in B2. Measured.",
  "ATK-18": "Single read, no consensus (H1 only checks shape). Measured.",
  "ATK-19": "No screening in B2; a reverted transfer leaves a recorded payment (as B1).",
  "ATK-20": "H4 catches an exact repeat of the number only; a re-invoice under a new number is paid. Measured.",
  "ATK-21": "No terms logic in B2: the stated amount is paid. Measured.",
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
  if (target === "b0") {
    return { applicable: true, reason: B0_SPECIFIC[attackId] ?? `B0 runs the vendored validate-work path on this document as the deliverable; ${B0_MAPPING}.` };
  }
  return { applicable: true, reason: B2_SPECIFIC[attackId] ?? "B2 is B1 plus schema validation, an allowlist, per-tx and daily caps and an exact duplicate-number check; the document reaches the same validator." };
}

export function buildApplicability(): ApplicabilityFile {
  const rows: ApplicabilityRow[] = [];
  for (const attackId of ATTACK_IDS) {
    for (const target of TARGET_IDS) rows.push({ attackId, target, ...reasonFor(attackId, target) });
  }
  return {
    schema: "applicability/1",
    note: "Started by WP-22, completed by WP-36. Every row is decided. N/A rows are listed in the report with their reason, never dropped and never counted as blocked; attacks that B0 or B2 hold by design are applicable and measured. A row with applicable=null (none today) would be unresolved and must not be counted as applicable or as blocked.",
    rows,
  };
}
