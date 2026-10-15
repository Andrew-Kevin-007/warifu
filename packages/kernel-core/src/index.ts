// @symbolon/kernel-core (owner: KERNEL-CORE): the pure deterministic decision kernel (docs/04).
// evaluate(rawIntent, ctx, policy) -> Evaluation. No clock, randomness, network, fs, env or LLM (INV-8/9);
// money is bigint (INV-10); invoice-stated terms are never adopted (INV-19); explanations are templated (INV-20);
// no binary parsing (INV-23).
// WP-04: K-01..K-08 + verdict algebra + parseMoney. WP-05: K-09..K-14, K-16, patterns, gates, explain, reevaluate().
export const PACKAGE_NAME = "@symbolon/kernel-core" as const;

export { KERNEL_VERSION } from "./version";
export { attempt, err, ok } from "./result";
export type { KernelError, KernelErrorCode, Result } from "./result";
export { contextHash, toJsonSafe } from "./context";
export type {
  ApprovedEscalation,
  Balances,
  BreakerState,
  ChainContext,
  DecisionSummary,
  EngagementOnChain,
  EscalationCounts,
  FindingRef,
  KernelContext,
  KernelDocument,
  PayeeHistory,
  Reevaluation,
  ReleasedTotals,
  ScreeningState,
} from "./context";
export { EVALUATION_ORDER, SKIPPABLE_CHECKS, aggregate, issueCodes, severity, verdictForOnFail } from "./verdict";
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
export { EVIDENCE_SOURCE_MAX, SOURCE_ARTIFACT, SOURCE_GITHUB, SOURCE_OWNER_ACK, assessEvidence, evidenceCollectionPlan, productionEvidenceSource, urlEvidenceSource, urlSourceDecision } from "./evidence";
export type { CollectorRequest, EvidenceAssessment, RequirementState, RequirementStatus, UrlDecision, UrlDenial } from "./evidence";
export { BASE64_RUN_LIMIT, HIDDEN_CHAR_LIMIT, PATTERNS_VERSION, TEXT_PATTERNS, foldForScan, isHidden, scanDocument } from "./patterns";
export type { PatternGroup, PatternMatch, TextPattern } from "./patterns";
export { NEVER_APPROVABLE, approvableFindings, approvalStatus, escalationBudgetMet } from "./gates";
export type { ApprovalStatus } from "./gates";
export { digestItem, rankEscalationDigest } from "./digest";
export type { DigestItem, RankedDigestItem } from "./digest";
export { KERNEL_EXCEPTION_LIMIT, KERNEL_EXCEPTION_WINDOW_SECONDS, breakerTrip, nextBreakerState } from "./breaker";
export type { BreakerEvent, BreakerRecord, BreakerSignal, BreakerTrip, TripReason } from "./breaker";
export { deriveSchedule } from "./schedule";
export type { Schedule } from "./schedule";
export { EXPLAIN_MAX_WORDS, explain, explanationVocabulary } from "./explain/index";
export type { ExplainFacts } from "./explain/index";
export { summarizeEvaluation } from "./evaluation";
export type { Evaluation } from "./evaluation";
export { KERNEL_PIPELINE, evaluate } from "./evaluate";
export { ATTESTATION_TTL_SECONDS, reevaluate } from "./reevaluate";
export type { Reevaluated, ReevaluationMismatch, ScheduledRelease } from "./reevaluate";
