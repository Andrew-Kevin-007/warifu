// Fixture shapes for the attack suite (docs/07 §2-§3). Everything here is DATA: a fixture says what is
// submitted and what a correct system must do; it never contains a decision, a verdict computed by us, or
// a hand-typed public number (INV-18). Hostile text is carried as Untrusted<string> and is inert: no
// consumer renders it, parses it as markup, or executes it (AGENTS.md §0.8).
import * as z from "zod";
import {
  AddressSchema,
  AgentRecommendationSchema,
  AmountSchema,
  ApprovalViewSchema,
  CheckIdSchema,
  ExtractedInvoiceSchema,
  ISODateTimeSchema,
  JsonObjectSchema,
  MilestoneStatusSchema,
  OraclePredicateSchema,
  ReasonCodeSchema,
  ScenarioIdSchema,
  VerdictSchema,
  untrustedText,
} from "@symbolon/schemas";

export const ATTACK_IDS = [
  "ATK-01", "ATK-02", "ATK-03", "ATK-04", "ATK-05", "ATK-06", "ATK-07", "ATK-08",
  "ATK-09", "ATK-10", "ATK-11", "ATK-12", "ATK-13", "ATK-14", "ATK-15", "ATK-16",
  "ATK-17", "ATK-18", "ATK-19", "ATK-20", "ATK-21", "ATK-22", "ATK-23", "ATK-24",
] as const;
export type AttackId = (typeof ATTACK_IDS)[number];
export const AttackIdSchema = z.enum(ATTACK_IDS);

export type ScenarioId = z.infer<typeof ScenarioIdSchema>;

/** `target` ids (docs/07 §1; `naive` was renamed `b1`). */
export const TARGET_IDS = ["symbolon", "b0", "b1", "b2"] as const;
export type TargetId = (typeof TARGET_IDS)[number];
export const TargetIdSchema = z.enum(TARGET_IDS);

export const MAX_DOC_BYTES_SANDBOX = 4096; // docs/04 K-01 (sandbox profile)

// --- documents --------------------------------------------------------------------------------------
export const TEMPLATE_STYLES = ["plain", "html", "pdf-text-layer", "eu-formal", "us-letter", "swiss", "multi-line", "bilingual"] as const;
export type TemplateStyle = (typeof TEMPLATE_STYLES)[number];

export const DOC_ORIGINS = [...TEMPLATE_STYLES, "email", "freeform"] as const;

/** A document as the kernel stores it: text only (INV-23). `receivedAt` is the kernel-recorded time (INV-19). */
export const FixtureDocumentSchema = z.strictObject({
  docLabel: z.string().min(1).max(96),
  origin: z.enum(DOC_ORIGINS),
  mime: z.literal("text/plain"),
  text: untrustedText(20_000),
  receivedAt: ISODateTimeSchema,
});
export type FixtureDocument = z.infer<typeof FixtureDocumentSchema>;

// --- expectations -----------------------------------------------------------------------------------
/** What a correct Symbolon decision must look like for one extraction run. All listed conditions must hold. */
export const StepExpectSchema = z.strictObject({
  /** The verdict must be one of these. */
  verdictIn: z.array(VerdictSchema).min(1).max(5),
  /** At least one of these reason codes must be present. */
  reasonsAnyOf: z.array(ReasonCodeSchema).max(12).exactOptional(),
  /** All of these reason codes must be present. */
  reasonsAllOf: z.array(ReasonCodeSchema).max(12).exactOptional(),
  /** At least one of these checks must have fired (FAIL). */
  checksAnyOf: z.array(CheckIdSchema).max(16).exactOptional(),
  /** If a RELEASE is scheduled, its release amount must equal this (K-08 `amountDue`, docs/04). */
  amountDueBaseUnits: AmountSchema.exactOptional(),
  note: z.string().max(400).exactOptional(),
});
export type StepExpect = z.infer<typeof StepExpectSchema>;

/**
 * One scripted pair of extractor outputs for a document (unit mode feeds these straight into PaymentIntent.extraction).
 * `a`/`b` are REFERENCE reads built by the fixture generator (what a careful extractor would output, or, for a
 * "steered"/"misread" run, what a fooled one would output). They are not recorded LLM outputs; recordings come
 * from `--live-llm` runs in the harness (WP-23).
 */
export const ExtractionRunSchema = z.strictObject({
  label: z.string().min(1).max(64),
  a: ExtractedInvoiceSchema,
  b: ExtractedInvoiceSchema.nullable(),
  agentRecommendation: AgentRecommendationSchema.nullable(),
  expect: StepExpectSchema,
});
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;

// --- context patches --------------------------------------------------------------------------------
export const PriorReleaseSchema = z.strictObject({
  milestoneSlug: z.string().min(1).max(64),
  invoiceNumber: z.string().min(1).max(128),
  amountBaseUnits: AmountSchema,
  payee: AddressSchema,
  at: ISODateTimeSchema,
});
export type PriorRelease = z.infer<typeof PriorReleaseSchema>;

export const EvidencePlanSchema = z.union([
  z.literal("all-pass"),
  z.literal("none"),
  z.strictObject({ pass: z.array(z.string().max(64)).max(16), fail: z.array(z.string().max(64)).max(16) }),
]);
export type EvidencePlan = z.infer<typeof EvidencePlanSchema>;

/**
 * Symbolic state the harness applies to the scenario instance before the step (everything optional).
 * A patch is applied ONCE, before its step; state it creates (prior releases, milestone status) persists for the
 * later steps of the same fixture, and decisions produced by earlier steps accumulate in the same instance.
 */
export const ContextPatchSchema = z.strictObject({
  /** Overrides the scenario clock (kernel `ctx.now`). Also the document's receivedAt unless stated otherwise. */
  now: ISODateTimeSchema.exactOptional(),
  /** "none" = the intent references no engagement (ATK-13). */
  engagement: z.enum(["scenario", "none"]).exactOptional(),
  milestoneStatus: z.record(z.string().max(64), MilestoneStatusSchema).exactOptional(),
  priorReleases: z.array(PriorReleaseSchema).max(64).exactOptional(),
  evidencePlan: EvidencePlanSchema.exactOptional(),
  /** category key -> already booked this month, in base units */
  categoryMonthSpent: z.record(z.string().max(64), AmountSchema).exactOptional(),
  screening: z.enum(["CLEAR", "HIT", "UNKNOWN"]).exactOptional(),
  payeeChangePending: z.boolean().exactOptional(),
  escalationsToday: z.number().int().min(0).max(1000).exactOptional(),
  breakerHalted: z.boolean().exactOptional(),
});
export type ContextPatch = z.infer<typeof ContextPatchSchema>;

// --- steps ------------------------------------------------------------------------------------------
export const ExplainerChecksSchema = z.strictObject({
  /** Phrases from the document that must never appear in a human-facing explanation (ATK-24). */
  forbiddenPhrases: z.array(z.string().min(1).max(200)).min(1).max(20),
  /**
   * n-gram size for the automatic overlap check, and the maximum allowed shared n-grams (0 = none) between the
   * explanation and these phrases. Measured against the phrases, not the whole document: formatted facts such as
   * the amount legitimately appear in both.
   */
  ngram: z.number().int().min(2).max(8),
  maxSharedNgrams: z.number().int().min(0).max(100),
});
export type ExplainerChecks = z.infer<typeof ExplainerChecksSchema>;

export const SubmitStepSchema = z.strictObject({
  kind: z.literal("submit"),
  stepId: z.string().min(1).max(64),
  /** Scenario this step runs in; absent = the fixture's scenario. */
  scenarioId: ScenarioIdSchema.exactOptional(),
  /** null when the document names no milestone of the engagement (ATK-13). */
  milestoneSlug: z.string().min(1).max(64).nullable(),
  doc: FixtureDocumentSchema,
  context: ContextPatchSchema,
  runs: z.array(ExtractionRunSchema).min(1).max(8),
  explainerChecks: ExplainerChecksSchema.exactOptional(),
  note: z.string().max(400).exactOptional(),
  /**
   * `true` = this step is an independent attempt: it starts on a FRESH scenario instance (docs/15 §2 "every attempt runs
   * on a fresh scenario instance"). The decisions, releases and patch state of earlier steps of the fixture are not
   * visible to it, and the steps that follow WITHOUT the flag continue in the instance it started (so a fixture can
   * group a step with its re-sent duplicate). Absent = the step continues in the current instance, which is what
   * sequential attacks (retry, near-duplicate, velocity, weekly re-invoice) need. WP-23 C.2 option (b).
   */
  freshInstance: z.literal(true).exactOptional(),
});
export type SubmitStep = z.infer<typeof SubmitStepSchema>;

export const FAULT_TYPES = ["relay-timeout", "provider-timeout", "agent-false-claim", "usdc-blocklist-revert"] as const;

export const FaultStepSchema = z.strictObject({
  kind: z.literal("fault"),
  stepId: z.string().min(1).max(64),
  fault: z.enum(FAULT_TYPES),
  params: JsonObjectSchema,
  expect: z.strictObject({
    /** Reconciler finding code (docs/04 K-15), if one is required. */
    finding: z.string().max(64).exactOptional(),
    /** Severity the reconciler must assign (docs/04 K-15: unconfirmed > 10 min is HIGH and trips the breaker). */
    severity: z.enum(["INFO", "HIGH"]).exactOptional(),
    breaker: z.enum(["OK", "HALTED"]).exactOptional(),
    /** Statements that must stay false in the ledger/UI state (e.g. "decision marked PAID"). */
    mustNotHold: z.array(z.string().max(160)).max(8),
    note: z.string().max(400),
  }),
});
export type FaultStep = z.infer<typeof FaultStepSchema>;

export const VaultCallStepSchema = z.strictObject({
  kind: z.literal("vault-call"),
  stepId: z.string().min(1).max(64),
  /** a..f of ATK-17 */
  label: z.string().min(1).max(8),
  actor: z.literal("compromised-kernel-signer"),
  call: z.enum(["release", "registerEngagement"]),
  /** Symbolic arguments; the harness resolves names to addresses/hashes of the deployed sandbox vault. */
  args: JsonObjectSchema,
  /** Custom error the vault must revert with (docs/06 release() order); null when the error name is defined by WP-07. */
  expectRevert: z.string().max(64).nullable(),
  expectRevertNote: z.string().max(400).exactOptional(),
});
export type VaultCallStep = z.infer<typeof VaultCallStepSchema>;

export const RenderMutationSchema = z.strictObject({
  mutationId: z.string().min(1).max(64),
  /** Dotted path into the RENDER model (what the screen shows). */
  path: z.string().min(1).max(120),
  from: z.string().max(200),
  to: z.string().max(200),
  note: z.string().max(300),
});

export const ApprovalRenderStepSchema = z.strictObject({
  kind: z.literal("approval-render"),
  stepId: z.string().min(1).max(64),
  /** The honest, self-consistent view that the wallet is asked to sign. */
  signedView: ApprovalViewSchema,
  mutations: z.array(RenderMutationSchema).min(1).max(16),
  expect: z.strictObject({ signDisabled: z.literal(true), rawTypedDataShown: z.literal(true), note: z.string().max(400) }),
});
export type ApprovalRenderStep = z.infer<typeof ApprovalRenderStepSchema>;

export const FloodItemSchema = z.strictObject({
  itemId: z.string().min(1).max(64),
  malicious: z.boolean(),
  /** Why a human is needed for this item (the benign ESCALATE trigger), or the attack for the malicious one. */
  trigger: z.string().min(1).max(80),
  step: SubmitStepSchema,
});
export type FloodItem = z.infer<typeof FloodItemSchema>;

export const FloodStepSchema = z.strictObject({
  kind: z.literal("flood"),
  stepId: z.string().min(1).max(64),
  items: z.array(FloodItemSchema).min(2).max(200),
  maliciousItemId: z.string().min(1).max(64),
  expect: z.strictObject({
    /** At most this many individual approval prompts (policy.escalation.maxPerDay). */
    maxIndividualPrompts: z.number().int().min(1).max(1000),
    /** The malicious item must appear in the digest at a rank <= this. */
    maliciousMaxRank: z.number().int().min(1).max(100),
    overflowVerdict: z.literal("HOLD"),
    overflowReason: z.literal("ESCALATION_BUDGET_EXCEEDED"),
    bulkApproveExists: z.literal(false),
    note: z.string().max(400),
  }),
});
export type FloodStep = z.infer<typeof FloodStepSchema>;

export const StepSchema = z.discriminatedUnion("kind", [
  SubmitStepSchema,
  FaultStepSchema,
  VaultCallStepSchema,
  ApprovalRenderStepSchema,
  FloodStepSchema,
]);
export type AttackStep = z.infer<typeof StepSchema>;

// --- intended loss and controls ---------------------------------------------------------------------
/** A release a successful attacker is after, in the terms the oracle (docs/15 §2) judges. */
export const ReleaseSpecSchema = z.strictObject({
  stepId: z.string().min(1).max(64),
  scenarioId: ScenarioIdSchema,
  milestoneSlug: z.string().min(1).max(64).nullable(),
  payee: AddressSchema,
  amountBaseUnits: AmountSchema,
  time: ISODateTimeSchema,
});
export type ReleaseSpec = z.infer<typeof ReleaseSpecSchema>;

/** A release plus the oracle predicates that must hold for it (the harness checks the oracle agrees). */
export const IntendedReleaseSchema = ReleaseSpecSchema.extend({
  predicates: z.array(OraclePredicateSchema).min(1).max(8),
});
export type IntendedRelease = z.infer<typeof IntendedReleaseSchema>;

export const IntendedLossSchema = z.strictObject({
  /**
   * "each": every release is judged on its own. "cumulative": the releases are applied in order to ONE scenario
   * instance and each listed predicate must be reported on at least one release (e.g. velocity splitting, ATK-14).
   */
  mode: z.enum(["each", "cumulative"]),
  releases: z.array(IntendedReleaseSchema).min(1).max(64),
});
export type IntendedLoss = z.infer<typeof IntendedLossSchema>;

/** The honest twin of an attack: near-identical, must pay or sign (docs/07 §6 "negative control"). */
export const ControlSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("release"), step: SubmitStepSchema, correctRelease: ReleaseSpecSchema }),
  z.strictObject({
    kind: z.literal("approval-unmodified"),
    stepId: z.string().min(1).max(64),
    signedView: ApprovalViewSchema,
    expect: z.strictObject({ signEnabled: z.literal(true), note: z.string().max(300) }),
  }),
]);
export type Control = z.infer<typeof ControlSchema>;

export const ATTACK_KINDS = ["document", "process", "contract", "approval", "explainer", "flood"] as const;

export const AttackFixtureSchema = z.strictObject({
  schema: z.literal("attack-fixture/1"),
  attackId: AttackIdSchema,
  title: z.string().min(1).max(120),
  errorClass: z.string().min(1).max(80),
  /** One plain-English line for the challenge one-click button (docs/15 §1). */
  caption: z.string().min(1).max(240),
  kind: z.enum(ATTACK_KINDS),
  scenarioId: ScenarioIdSchema,
  seed: z.string().min(1).max(64),
  steps: z.array(StepSchema).min(1).max(200),
  intendedLoss: IntendedLossSchema.nullable(),
  /** Required when intendedLoss is null: why the oracle predicates cannot express this attack. */
  intendedLossNote: z.string().max(400).exactOptional(),
  /** Table column "Naive" of docs/07 §3, kept verbatim as a hypothesis; measured outcomes come from the harness. */
  naiveHypothesis: z.string().max(200),
  /** Table columns "Symbolon" and "Backstop" of docs/07 §3 (expected defences), for the report. */
  symbolonDefence: z.string().max(400),
  onChainBackstop: z.string().max(200),
  control: ControlSchema,
  tags: z.array(z.string().max(48)).max(16),
});
export type AttackFixture = z.infer<typeof AttackFixtureSchema>;

/**
 * benign-control / discount-honest: the 12 invoices docs/07 §4 names (WP-22).
 * general: >= 40 ordinary legitimate invoices across formats, amounts, timing and categories (WP-24).
 * ugly: 10 "legit but ugly" invoices (WP-24); some are correctly sent to a human by design.
 */
export const HONEST_GROUPS = ["benign-control", "discount-honest", "general", "ugly"] as const;
export type HonestGroup = (typeof HONEST_GROUPS)[number];

/**
 * What a correct system does with this legitimate invoice. AUTO_RELEASE: pay it at `correctRelease`, no human.
 * HUMAN_REVIEW: a human is needed BY DESIGN (the kernel must not guess); ESCALATE or HOLD in `humanVerdicts` is
 * the correct outcome and a REJECT is a wrongful reject. Absent on the 12 WP-22 fixtures = AUTO_RELEASE.
 * The expectation is written from docs/04 (the spec), never from what the kernel build happens to answer.
 */
export const HonestExpectSchema = z.strictObject({
  outcome: z.enum(["AUTO_RELEASE", "HUMAN_REVIEW"]),
  /** HUMAN_REVIEW only: verdicts that count as "correctly sent to a human". */
  humanVerdicts: z.array(z.enum(["ESCALATE", "HOLD"])).min(1).max(2).exactOptional(),
  /** HUMAN_REVIEW only: the reason code(s) docs/04 gives for this case (at least one should appear). */
  reasonsAnyOf: z.array(ReasonCodeSchema).min(1).max(8).exactOptional(),
  /** Why this invoice is legitimate and what the spec says should happen (reviewable, plain English). */
  why: z.string().min(1).max(400),
});
export type HonestExpect = z.infer<typeof HonestExpectSchema>;

export const HonestFixtureSchema = z.strictObject({
  schema: z.literal("honest-fixture/1"),
  id: z.string().min(1).max(64),
  group: z.enum(HONEST_GROUPS),
  caption: z.string().min(1).max(240),
  scenarioId: ScenarioIdSchema,
  step: SubmitStepSchema,
  /** The payment a correct system makes (for HUMAN_REVIEW: what the owner's approval would release). */
  correctRelease: ReleaseSpecSchema,
  /** The oracle must say NO_LOSS for the correct release. */
  oracleExpected: z.literal("NO_LOSS"),
  expect: HonestExpectSchema.exactOptional(),
  /** Coverage tags (format, timing, category, ...), so the corpus can report what it covers. */
  tags: z.array(z.string().min(1).max(48)).max(16).exactOptional(),
});
export type HonestFixture = z.infer<typeof HonestFixtureSchema>;
