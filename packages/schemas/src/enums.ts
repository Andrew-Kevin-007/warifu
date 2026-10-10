// Enumerations and stable constants (docs/04 §1, §4, §6; docs/05 §1-§2; docs/15; docs/16).
// The reason-code list here is authoritative (docs/04 §6).
import * as z from "zod";

// --- Verdicts ------------------------------------------------------------------------------------
export const VERDICTS = ["RELEASE", "HOLD", "ESCALATE", "REJECT", "REPLAY"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const VerdictSchema = z.enum(VERDICTS);

/** uint8 encoding used in the EIP-712 `Receipt` struct (docs/05 §1). */
export const VERDICT_CODE: Readonly<Record<Verdict, number>> = Object.freeze({
  RELEASE: 1,
  HOLD: 2,
  ESCALATE: 3,
  REJECT: 4,
  REPLAY: 5,
});

/** Severity for aggregation: REJECT > ESCALATE > HOLD > RELEASE (docs/04 §1). REPLAY short-circuits and is not ranked. */
export const VERDICT_SEVERITY: Readonly<Record<Exclude<Verdict, "REPLAY">, number>> = Object.freeze({
  RELEASE: 0,
  HOLD: 1,
  ESCALATE: 2,
  REJECT: 3,
});

export const ON_FAIL = ["REJECT", "ESCALATE", "HOLD"] as const;
export type OnFail = (typeof ON_FAIL)[number];
export const OnFailSchema = z.enum(ON_FAIL);

export const CHECK_STATUSES = ["PASS", "FAIL", "SKIP"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export const CheckStatusSchema = z.enum(CHECK_STATUSES);

export const AGENT_VERDICTS = ["RELEASE", "HOLD", "ESCALATE"] as const;
export const AgentVerdictSchema = z.enum(AGENT_VERDICTS);

// --- Kernel checks ---------------------------------------------------------------------------------
export const CHECK_IDS = [
  "K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08",
  "K-09", "K-10", "K-11", "K-12", "K-13", "K-14", "K-15", "K-16",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export const CheckIdSchema = z.enum(CHECK_IDS);

export const CHECK_NAMES: Readonly<Record<CheckId, string>> = Object.freeze({
  "K-01": "STRICT_SCHEMA",
  "K-02": "PRECISION_EXACT",
  "K-03": "DOC_TYPE_SIGN",
  "K-04": "IDEMPOTENCY_DEDUPE",
  "K-05": "ENGAGEMENT_BINDING",
  "K-06": "PAYEE_BINDING",
  "K-07": "CURRENCY_DECIMALS",
  "K-08": "AMOUNT_CONFORMANCE",
  "K-09": "EVIDENCE_MATCH",
  "K-10": "EXTRACTION_CONSENSUS",
  "K-11": "INSTRUCTION_CHANGE_HEURISTIC",
  "K-12": "AUTHORITY_ENVELOPE",
  "K-13": "COUNTERPARTY_SCREEN",
  "K-14": "LIQUIDITY_AND_TIMING",
  "K-15": "RECONCILIATION_WITNESS",
  "K-16": "CIRCUIT_BREAKER",
});
export const CheckNameSchema = z.enum(Object.values(CHECK_NAMES) as [string, ...string[]]);

// --- Reason codes (docs/04 §6; v1 list then the 6 v2 additions) -------------------------------------
export const V1_REASON_CODES = [
  "SCHEMA_INVALID", "NON_ASCII_DIGITS", "SCIENTIFIC", "REFUSE_ROUND", "AMOUNT_AMBIGUOUS",
  "EXTRACTION_PARSE_MISMATCH", "LINEITEM_SUM_MISMATCH", "CREDIT_NOTE", "NOT_PAYABLE", "DUPLICATE_DOC",
  "NEAR_DUPLICATE", "MILESTONE_ALREADY_PAID", "NO_ENGAGEMENT", "ENGAGEMENT_INACTIVE", "OUT_OF_WINDOW",
  "MILESTONE_ORDER", "UNKNOWN_MILESTONE", "PAYEE_MISMATCH", "ADDRESS_CHANGE_CLAIMED", "PAYEE_CHANGE_PENDING",
  "CURRENCY_UNSUPPORTED", "DECIMALS_MISMATCH", "SCALE_ABSURD", "OVERPAY", "UNDERPAY_PARTIAL",
  "EVIDENCE_MISSING", "EVIDENCE_FAILED", "EVIDENCE_HASH_MISMATCH", "EXTRACTION_DISAGREE", "SINGLE_EXTRACTION",
  "INSTRUCTION_IN_DOC", "CAP_PER_TX", "CAP_DAILY", "CAP_WEEKLY", "CATEGORY_BUDGET",
  "VELOCITY", "HUMAN_REQUIRED", "FIRST_PAYMENT_LARGE", "SCREENING_PENDING", "SCREEN_HIT",
  "SCREENING_DISABLED", "LIQUIDITY", "TIMING_CLAMPED", "LATE", "BREAKER_HALTED",
  "KERNEL_ERROR",
] as const;

export const V2_REASON_CODES = [
  "TERMS_NOT_SIGNED",
  "TERMS_MISMATCH",
  "DISCOUNT_WINDOW_CLOSED",
  "EVIDENCE_SOURCE_DENIED",
  "ESCALATION_BUDGET_EXCEEDED",
  "PLAN_OUT_OF_ENVELOPE",
] as const;

export const REASON_CODES = [...V1_REASON_CODES, ...V2_REASON_CODES] as const;
export type ReasonCode = (typeof REASON_CODES)[number];
export const ReasonCodeSchema = z.enum(REASON_CODES);

// --- Profiles, timing, planner ------------------------------------------------------------------
export const PROFILES = ["production", "sandbox"] as const;
export type Profile = (typeof PROFILES)[number];
export const ProfileSchema = z.enum(PROFILES);

export const TIMING_SOURCES = ["AGENT", "CLAMPED", "DEFAULT"] as const;
export type TimingSource = (typeof TIMING_SOURCES)[number];
export const TimingSourceSchema = z.enum(TIMING_SOURCES);

export const PLAN_MODES = ["TAKE_DISCOUNT", "DUE_MINUS_BUFFER", "IMMEDIATE", "AFTER_EVIDENCE", "AFTER_DISPUTE_WINDOW", "HOLD"] as const;
export type PlanMode = (typeof PLAN_MODES)[number];
export const PlanModeSchema = z.enum(PLAN_MODES);

export const PLAN_FACTORS = [
  "due_date", "discount_window", "implied_apr", "liquidity", "payee_history", "evidence_status", "policy_rule", "delivery_risk",
] as const;
export const PlanFactorSchema = z.enum(PLAN_FACTORS);

export const PLAN_RISK_FLAGS = ["DELIVERY_UNCERTAIN", "VENDOR_HISTORY_POOR", "LIQUIDITY_TIGHT", "TERMS_AMBIGUOUS", "OTHER"] as const;
export const PlanRiskFlagSchema = z.enum(PLAN_RISK_FLAGS);

// --- Engagements, documents, evidence -----------------------------------------------------------
export const ENGAGEMENT_STATUSES = ["DRAFT", "AWAITING_PAYEE", "REGISTERING", "ACTIVE", "CLOSED", "CANCELLED"] as const;
export const EngagementStatusSchema = z.enum(ENGAGEMENT_STATUSES);

export const MILESTONE_STATUSES = ["PENDING", "EVIDENCE_OK", "PAID", "DISPUTED", "CANCELLED"] as const;
export const MilestoneStatusSchema = z.enum(MILESTONE_STATUSES);

export const EVIDENCE_TYPES = ["OWNER_ACK", "CI_PASS", "URL_HEALTH", "ARTIFACT_HASH"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
export const EvidenceTypeSchema = z.enum(EVIDENCE_TYPES);

export const EVIDENCE_RESULTS = ["PASS", "FAIL", "ERROR"] as const;
export const EvidenceResultSchema = z.enum(EVIDENCE_RESULTS);

export const DOC_TYPES = ["INVOICE", "CREDIT_NOTE", "STATEMENT", "OTHER"] as const;
export const DocTypeSchema = z.enum(DOC_TYPES);

export const DECIMAL_SEPARATOR_GUESSES = [".", ",", "none", "ambiguous"] as const;
export const DecimalSeparatorGuessSchema = z.enum(DECIMAL_SEPARATOR_GUESSES);

export const ANOMALY_CODES = [
  "INSTRUCTION_IN_DOC", "ADDRESS_CHANGE", "AMOUNT_AMBIGUOUS", "MISSING_FIELD", "HIDDEN_CHARS", "TERMS_CLAIM", "OTHER",
] as const;
export const AnomalyCodeSchema = z.enum(ANOMALY_CODES);

export const CONSENSUS_STATUSES = ["AGREE", "DISAGREE", "SINGLE"] as const;
export type ConsensusStatus = (typeof CONSENSUS_STATUSES)[number];
export const ConsensusStatusSchema = z.enum(CONSENSUS_STATUSES);

// --- Challenge / oracle (docs/15) ---------------------------------------------------------------
export const SCENARIO_IDS = ["S-A", "S-B", "S-C"] as const;
export const ScenarioIdSchema = z.enum(SCENARIO_IDS);

export const ATTEMPT_SOURCES = ["human", "house", "oneclick"] as const;
export const AttemptSourceSchema = z.enum(ATTEMPT_SOURCES);

export const ORACLE_PREDICATES = ["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8"] as const;
export type OraclePredicate = (typeof ORACLE_PREDICATES)[number];
export const OraclePredicateSchema = z.enum(ORACLE_PREDICATES);

export const ORACLE_RESULTS = ["NO_LOSS", "LOSS"] as const;
export const OracleResultSchema = z.enum(ORACLE_RESULTS);

// --- Loss Bound Certificate (docs/16) -------------------------------------------------------------
export const LBC_TERMS = ["balance", "daily", "engagements", "hourly"] as const;
export type LbcTerm = (typeof LBC_TERMS)[number];
export const LbcTermSchema = z.enum(LBC_TERMS);

export const LBC_HORIZONS = [
  { label: "1m", seconds: 60 },
  { label: "1h", seconds: 3_600 },
  { label: "6h", seconds: 21_600 },
  { label: "24h", seconds: 86_400 },
  { label: "48h", seconds: 172_800 },
  { label: "7d", seconds: 604_800 },
] as const;
export const LBC_HORIZON_LABELS = ["1m", "1h", "6h", "24h", "48h", "7d"] as const;
export const LbcHorizonLabelSchema = z.enum(LBC_HORIZON_LABELS);

export const ASSUMPTION_IDS = ["A-EVID", "A-MON", "A-OWNER-KEY", "A-TOKEN", "A-CHAIN", "A-MODEL"] as const;
export type AssumptionId = (typeof ASSUMPTION_IDS)[number];
export const AssumptionIdSchema = z.enum(ASSUMPTION_IDS);

export const LBC_VALIDITY_STATUSES = ["VALID", "STALE", "UNVERIFIED"] as const;
export const LbcValidityStatusSchema = z.enum(LBC_VALIDITY_STATUSES);

/** Reasons reported by `lbc verify` (docs/16 §5.2-§5.3). */
export const LBC_VALIDITY_REASONS = [
  "BLOCK_HASH_MISMATCH",
  "CONFIG_CHANGED",
  "ENGAGEMENTS_CHANGED",
  "BALANCE_INCREASED",
  "FRESHNESS_EXCEEDED",
  "RPC_ERROR",
  "CODE_NOT_VALIDATED",
] as const;
export const LbcValidityReasonSchema = z.enum(LBC_VALIDITY_REASONS);

export const CODE_MATCH_STATUSES = ["MATCH", "NOT_CHECKED", "MISMATCH"] as const;
export const CodeMatchStatusSchema = z.enum(CODE_MATCH_STATUSES);
