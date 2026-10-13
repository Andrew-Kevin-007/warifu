// buildReceipt(decision, inputs): assemble the Receipt whose JCS-keccak hash is the receiptHash (docs/05 §2, DEC-009).
//
//   receiptHash = keccak256(UTF-8(JCS(Receipt)))
//   Receipt     = { receiptVersion: 1, decision: Omit<Decision, 'humanExplanation'>, humanExplanationHash, inputs, issuedAt }
//
// Pure: no clock (issuedAt is an argument and defaults to the decision's own createdAt, which the service took from
// its injected clock), no I/O. The kernel decided; this only assembles, and it re-parses everything with the frozen
// schemas so an inconsistent decision cannot become a receipt (fail closed: `ok: false`, nothing is signed).
//
// humanExplanationHash = keccak256 of the explanation's UTF-8 bytes (docs/QUESTIONS WP-01 item 2, confirmed in the
// WP-02 entry): the explanation is text, not JSON, so it is not JCS-wrapped. The text itself never enters the
// receipt; only its hash does, so a receipt cannot carry attacker prose.
import {
  DecisionSchema,
  ReceiptSchema,
  computeReceiptHash,
  keccak256Utf8,
  type Decision,
  type Hex32,
  type ISODateTime,
  type Receipt,
} from "@symbolon/schemas";
import { attempt, describeIssues, err, ok, type Result } from "./result";

export interface BuiltReceipt {
  readonly receipt: Receipt;
  readonly receiptHash: Hex32;
}

export interface BuildReceiptOptions {
  /** Default: the decision's `createdAt`. Never read from a clock inside this package. */
  readonly issuedAt?: ISODateTime;
}

/** What a RELEASE needs in order to be anchored by a vault `Released` event (docs/05 §6). */
function releaseProblem(d: Decision): string | null {
  if (d.checks.some((c) => c.status === "FAIL")) return "a RELEASE decision has a failed check";
  if (d.payee === null || d.engagementId === null || d.milestoneId === null || d.amountBaseUnits === null || d.releaseAmountBaseUnits === null) {
    return "a RELEASE decision must name payee, engagement, milestone, gross amount and release amount";
  }
  return null;
}

export function buildReceipt(decision: Decision, inputs: Receipt["inputs"], options: BuildReceiptOptions = {}): Result<BuiltReceipt> {
  return attempt(
    () => {
      const parsed = DecisionSchema.safeParse(decision);
      if (!parsed.success) return err("DECISION_INVALID", `decision rejected by DecisionSchema: ${describeIssues(parsed.error.issues)}`);
      const d = parsed.data;
      const problem = d.verdict === "RELEASE" ? releaseProblem(d) : null;
      if (problem !== null) return err("DECISION_INVALID", problem);

      const { humanExplanation, ...receiptDecision } = d;
      const candidate = {
        receiptVersion: 1 as const,
        decision: receiptDecision,
        humanExplanationHash: humanExplanation === null ? null : keccak256Utf8(humanExplanation),
        inputs,
        issuedAt: options.issuedAt ?? d.createdAt,
      };
      const receipt = ReceiptSchema.safeParse(candidate);
      if (!receipt.success) return err("RECEIPT_INVALID", `receipt rejected by ReceiptSchema: ${describeIssues(receipt.error.issues)}`);
      return ok({ receipt: receipt.data, receiptHash: computeReceiptHash(receipt.data) });
    },
    "INTERNAL",
    "unexpected error while building a receipt",
  );
}
