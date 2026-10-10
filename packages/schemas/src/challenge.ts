// "Break the Treasurer" challenge shapes (docs/15 §2, §8; docs/05 §2) and the replay bundle (docs/15 §7).
import * as z from "zod";
import { MilestoneSchema, EngagementSchema, PaymentTermsSchema } from "./engagement";
import {
  AttemptSourceSchema,
  CheckIdSchema,
  ORACLE_PREDICATES,
  OraclePredicateSchema,
  OracleResultSchema,
  ReasonCodeSchema,
  ScenarioIdSchema,
  VerdictSchema,
} from "./enums";
import { DecisionSchema, SignedReceiptSchema } from "./decision";
import { EvidenceFixtureSchema, JsonObjectSchema } from "./evidence";
import { hashJcs } from "./hash";
import { ModelIdSchema } from "./intent";
import { LossBoundCertificateSchema } from "./lbc";
import { PolicyOverridesSchema } from "./policy";
import {
  AddressSchema,
  AmountSchema,
  BaseUnitsSchema,
  GitShaSchema,
  Hex32Schema,
  ISODateTimeSchema,
  SafeUintSchema,
  UUIDSchema,
  text,
  type Hex32,
} from "./primitives";
import { untrustedText } from "./untrusted";

export const ChallengeScenarioSchema = z.strictObject({
  scenarioId: ScenarioIdSchema,
  title: text(200),
  engagement: EngagementSchema,
  milestones: z.array(MilestoneSchema).min(1).max(64),
  paymentTerms: PaymentTermsSchema,
  policy: PolicyOverridesSchema,
  clock: z.strictObject({ mode: z.enum(["fixed", "advancing"]), start: ISODateTimeSchema }),
  evidenceFixtures: z.array(EvidenceFixtureSchema).max(64),
  groundTruth: z.strictObject({
    legitPayee: AddressSchema,
    /** gross; the discount is computed by amountDue() */
    legitAmountByMilestone: z.record(Hex32Schema, AmountSchema),
    allowedWindow: z.strictObject({ start: ISODateTimeSchema, end: ISODateTimeSchema }),
  }),
  oracleVersion: z.literal("oracle-v1"),
});
export type ChallengeScenario = z.infer<typeof ChallengeScenarioSchema>;

export const ChallengeAttemptSchema = z.strictObject({
  attemptId: UUIDSchema,
  scenarioId: ScenarioIdSchema,
  source: AttemptSourceSchema,
  attackId: z.string().max(32).regex(/^[A-Z0-9-]+$/).nullable(),
  /** sha256(ip ‖ CHALLENGE_IP_SALT), 7-day TTL */
  ipHash: Hex32Schema.nullable(),
  textHash: Hex32Schema,
  textLength: SafeUintSchema,
  /** <= 240 chars (toExcerpt); full text kept 30 d elsewhere */
  excerpt: untrustedText(240),
  extraction: z.strictObject({
    modelA: ModelIdSchema,
    modelB: ModelIdSchema.nullable(),
    promptHashA: Hex32Schema,
    promptHashB: Hex32Schema.nullable(),
    outputHashA: Hex32Schema,
    outputHashB: Hex32Schema.nullable(),
  }),
  decisionId: UUIDSchema,
  verdict: VerdictSchema,
  reasons: z.array(ReasonCodeSchema).max(64),
  checksFired: z.array(CheckIdSchema).max(16),
  receiptHash: Hex32Schema,
  vaultSimulation: z.strictObject({ ok: z.boolean(), revertError: text(256).nullable() }).nullable(),
  txHash: Hex32Schema.nullable(),
  oracle: z.strictObject({
    version: z.literal("oracle-v1"),
    result: OracleResultSchema,
    predicates: z.array(OraclePredicateSchema).max(8),
  }),
  benignControl: z.boolean(),
  publishable: z.boolean(),
  createdAt: ISODateTimeSchema,
});
export type ChallengeAttempt = z.infer<typeof ChallengeAttemptSchema>;

const nonNeg = SafeUintSchema;

export const ChallengeStatsSchema = z.strictObject({
  asOf: ISODateTimeSchema,
  source: z.enum(["live", "recorded"]),
  attempts: z.strictObject({ human: nonNeg, distinctHuman: nonNeg, house: nonNeg, oneClick: nonNeg }),
  outcomes: z.strictObject({ RELEASE: nonNeg, HOLD: nonNeg, ESCALATE: nonNeg, REJECT: nonNeg, REPLAY: nonNeg }),
  lossEvents: z.strictObject({
    total: nonNeg,
    byPredicate: z.strictObject(Object.fromEntries(ORACLE_PREDICATES.map((p) => [p, nonNeg])) as Record<(typeof ORACLE_PREDICATES)[number], typeof nonNeg>),
  }),
  benign: z.strictObject({ n: nonNeg, falseRejects: nonNeg }),
  topReasonCodes: z.array(z.strictObject({ code: ReasonCodeSchema, count: nonNeg })).max(64),
  /** distinct salted ip hashes */
  uniqueAttackers: nonNeg,
  certifiedBoundBaseUnits: BaseUnitsSchema,
  observedMaxLossBaseUnits: BaseUnitsSchema,
  /**
   * Rule of three when lossEvents.total === 0: 3 / attempts.distinctHuman. null when distinctHuman === 0
   * (no independent trials yet; a number would be a fabricated claim).
   */
  upper95LossRate: z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
});
export type ChallengeStats = z.infer<typeof ChallengeStatsSchema>;

export const ReplayBundleSchema = z.strictObject({
  version: z.literal(1),
  builtAt: ISODateTimeSchema,
  gitSha: GitShaSchema,
  harnessVersions: z.record(z.string().max(64), z.string().max(64)),
  attackMatrix: JsonObjectSchema,
  holdout: z.strictObject({ seedHash: Hex32Schema, n: nonNeg, losses: nonNeg, upper95: z.number().min(0) }),
  scenarios: z.array(ChallengeScenarioSchema).max(16),
  attempts: z.array(ChallengeAttemptSchema),
  /** receipts with their kernel signatures, so verify-bundle can check them (docs/15 §7) */
  receipts: z.array(SignedReceiptSchema),
  decisions: z.array(DecisionSchema),
  extractionOutputs: z.array(JsonObjectSchema),
  /** lbc/1; null if no certificate existed when the bundle was built */
  certificate: LossBoundCertificateSchema.nullable(),
  txs: z.array(Hex32Schema),
  plannerReport: JsonObjectSchema,
  bundleHash: Hex32Schema,
});
export type ReplayBundle = z.infer<typeof ReplayBundleSchema>;

/** bundleHash = keccak256(JCS(bundle without bundleHash)). */
export function computeBundleHash(bundle: ReplayBundle): Hex32 {
  const { bundleHash: _bundleHash, ...rest } = bundle;
  return hashJcs(rest);
}
