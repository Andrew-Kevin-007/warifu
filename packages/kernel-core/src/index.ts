// @symbolon/kernel-core (owner: KERNEL-CORE): the pure deterministic decision kernel (docs/04).
// evaluate(rawIntent, ctx, policy) -> Evaluation. No clock, randomness, network, fs, env or LLM (INV-8/9);
// money is bigint (INV-10); invoice-stated terms are never adopted (INV-19); no binary parsing (INV-23).
// WP-04: K-01..K-08 + verdict algebra + parseMoney. WP-05: K-09..K-14, K-16, patterns, explain, reevaluate().
export const PACKAGE_NAME = "@symbolon/kernel-core" as const;

export { KERNEL_VERSION } from "./version";
export { attempt, err, ok } from "./result";
export type { KernelError, KernelErrorCode, Result } from "./result";
export { contextHash, toJsonSafe } from "./context";
export type {
  Balances,
  BreakerState,
  ChainContext,
  DecisionSummary,
  EngagementOnChain,
  EscalationCounts,
  KernelContext,
  KernelDocument,
  PayeeHistory,
  Reevaluation,
  ReleasedTotals,
  ScreeningState,
} from "./context";
export { EVALUATION_ORDER, SKIPPABLE_CHECKS, aggregate, severity, verdictForOnFail } from "./verdict";
export type { Aggregate, FinalVerdict } from "./verdict";
export { parseMoney } from "./money";
export type { AmbiguityReason, DecimalSeparator, MoneyParse, MoneyRejectCode, ParseMoneyOptions } from "./money";
export { ENCODED_RUN_LIMIT, MAX_NORM_INVOICE_NO, binaryKind, normalizeInvoiceNumber, utf8ByteLength } from "./text";
export type { BinaryKind } from "./text";
export { UNKNOWN_INTENT_ID, deriveFacts, unboundIntentId } from "./facts";
export type { Facts, ReleaseFacts } from "./facts";
export { SANDBOX_MAX_DOC_BYTES, maxIntentChars } from "./checks/k01-schema";
export { NEAR_DUPLICATE_WINDOW_SECONDS } from "./checks/k04-idempotency";
export { SCALE_ABSURD_WHOLE_UNITS_EXPONENT } from "./checks/k07-currency";
export { summarizeEvaluation } from "./evaluation";
export type { Evaluation } from "./evaluation";
export { KERNEL_PIPELINE, evaluate } from "./evaluate";
