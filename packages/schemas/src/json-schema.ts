// JSON Schema export (draft 2020-12) of the wire shapes, generated from the Zod schemas (docs/10 WP-01).
// Cross-field rules, EIP-55 checksums, calendar validity and uint ranges are Zod refinements, which JSON
// Schema cannot express: the exported files describe structure for other languages and tools, and the
// Zod schemas stay the validator. Files: packages/schemas/json-schema/<Name>.schema.json (generated).
import * as z from "zod";
import { ApprovalViewSchema } from "./approval";
import { ChallengeAttemptSchema, ChallengeScenarioSchema, ChallengeStatsSchema, ReplayBundleSchema } from "./challenge";
import { CheckResultSchema, DecisionSchema, ReceiptSchema, SignedReceiptSchema } from "./decision";
import { EngagementSchema, EngagementTermsPreimageSchema, EvidenceRequirementSchema, MilestoneSchema, PaymentTermsSchema } from "./engagement";
import { DocumentSchema, EvidenceFixtureSchema, EvidenceSchema } from "./evidence";
import { ConsensusResultSchema, ExtractedInvoiceSchema, StatedTermsSchema } from "./extraction";
import { PaymentIntentSchema } from "./intent";
import { LossBoundCertificateSchema } from "./lbc";
import { FeasiblePlanSchema, PlanEvaluationSchema, PlanSelectionSchema, TimingProposalSchema } from "./plans";
import { PolicyOverridesSchema, PolicySchema } from "./policy";

export const JSON_SCHEMA_REGISTRY = {
  ApprovalView: ApprovalViewSchema,
  ChallengeAttempt: ChallengeAttemptSchema,
  ChallengeScenario: ChallengeScenarioSchema,
  ChallengeStats: ChallengeStatsSchema,
  CheckResult: CheckResultSchema,
  ConsensusResult: ConsensusResultSchema,
  Decision: DecisionSchema,
  Document: DocumentSchema,
  Engagement: EngagementSchema,
  EngagementTermsPreimage: EngagementTermsPreimageSchema,
  Evidence: EvidenceSchema,
  EvidenceFixture: EvidenceFixtureSchema,
  EvidenceRequirement: EvidenceRequirementSchema,
  ExtractedInvoice: ExtractedInvoiceSchema,
  FeasiblePlan: FeasiblePlanSchema,
  LossBoundCertificate: LossBoundCertificateSchema,
  Milestone: MilestoneSchema,
  PaymentIntent: PaymentIntentSchema,
  PaymentTerms: PaymentTermsSchema,
  PlanEvaluation: PlanEvaluationSchema,
  PlanSelection: PlanSelectionSchema,
  Policy: PolicySchema,
  PolicyOverrides: PolicyOverridesSchema,
  Receipt: ReceiptSchema,
  ReplayBundle: ReplayBundleSchema,
  SignedReceipt: SignedReceiptSchema,
  StatedTerms: StatedTermsSchema,
  TimingProposal: TimingProposalSchema,
} as const;

export type JsonSchemaName = keyof typeof JSON_SCHEMA_REGISTRY;

/** JSON Schema (draft 2020-12) for one registered shape, with a stable `$id`. */
export function exportJsonSchema(name: JsonSchemaName): Record<string, unknown> {
  const schema = z.toJSONSchema(JSON_SCHEMA_REGISTRY[name], { target: "draft-2020-12", unrepresentable: "throw" });
  return { $id: `https://symbolon.dev/schemas/v1/${name}.schema.json`, title: name, ...schema };
}
