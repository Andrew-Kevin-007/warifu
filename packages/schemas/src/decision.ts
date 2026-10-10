// Decision and receipt (docs/05 §2, docs/04 §8). receiptHash = keccak256(JCS(Receipt)).
import * as z from "zod";
import {
  CHECK_NAMES,
  CheckIdSchema,
  CheckNameSchema,
  CheckStatusSchema,
  EvidenceResultSchema,
  OnFailSchema,
  ProfileSchema,
  ReasonCodeSchema,
  TimingSourceSchema,
  VerdictSchema,
} from "./enums";
import { hashJcs } from "./hash";
import { AgentRecommendationSchema, ModelIdSchema } from "./intent";
import { AddressSchema, AmountSchema, Hex32Schema, HexBytesSchema, ISODateTimeSchema, UUIDSchema, text, type Hex32 } from "./primitives";
import { untrustedText } from "./untrusted";

export const CheckResultSchema = z
  .strictObject({
    id: CheckIdSchema,
    name: CheckNameSchema,
    status: CheckStatusSchema,
    onFail: OnFailSchema.nullable(),
    code: ReasonCodeSchema.nullable(),
    /** May quote document text (e.g. K-11 matches): untrusted when rendered. */
    detail: untrustedText(2000),
    refs: z.array(text(256)).max(32),
  })
  .superRefine((c, ctx) => {
    if (CHECK_NAMES[c.id] !== c.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: `name for ${c.id} is ${CHECK_NAMES[c.id]}` });
    }
  });
export type CheckResult = z.infer<typeof CheckResultSchema>;

const decisionShape = {
  decisionId: UUIDSchema,
  tenantId: UUIDSchema,
  intentId: Hex32Schema,
  verdict: VerdictSchema,
  checks: z.array(CheckResultSchema).max(32),
  reasons: z.array(ReasonCodeSchema).max(64),
  engagementId: Hex32Schema.nullable(),
  milestoneId: Hex32Schema.nullable(),
  payee: AddressSchema.nullable(),
  /** the GROSS invoiced amount */
  amountBaseUnits: AmountSchema.nullable(),
  payAt: ISODateTimeSchema.nullable(),
  timingSource: TimingSourceSchema.nullable(),
  /** v2: amountDue(payAt) */
  releaseAmountBaseUnits: AmountSchema.nullable(),
  planId: Hex32Schema.nullable(),
  plannerFallback: z.boolean(),
  invoiceReceivedAt: ISODateTimeSchema.nullable(),
  policyHash: Hex32Schema,
  kernelVersion: z.string().min(1).max(64),
  patternsVersion: z.string().min(1).max(64),
  contextHash: Hex32Schema,
  agentRecommendation: AgentRecommendationSchema.nullable(),
  supersedes: UUIDSchema.nullable(),
  createdAt: ISODateTimeSchema,
};

/** Templated by the kernel from structured facts (INV-20); never LLM prose. */
const humanExplanationSchema = text(2000).nullable();

export const DecisionSchema = z.strictObject({ ...decisionShape, humanExplanation: humanExplanationSchema });
export type Decision = z.infer<typeof DecisionSchema>;

/** Receipt.decision = Omit<Decision, 'humanExplanation'> (its hash goes in humanExplanationHash). */
export const ReceiptDecisionSchema = z.strictObject(decisionShape);
export type ReceiptDecision = z.infer<typeof ReceiptDecisionSchema>;

export const ReceiptSchema = z.strictObject({
  receiptVersion: z.literal(1),
  decision: ReceiptDecisionSchema,
  humanExplanationHash: Hex32Schema.nullable(),
  inputs: z.strictObject({
    docHash: Hex32Schema,
    extractionHashA: Hex32Schema,
    extractionHashB: Hex32Schema.nullable(),
    promptHashA: Hex32Schema,
    promptHashB: Hex32Schema.nullable(),
    modelA: ModelIdSchema,
    modelB: ModelIdSchema.nullable(),
    evidence: z.array(z.strictObject({ evidenceId: UUIDSchema, payloadHash: Hex32Schema, result: EvidenceResultSchema })).max(64),
    engagementTermsHash: Hex32Schema.nullable(),
    normalizedDocHash: Hex32Schema,
    paymentTermsHash: Hex32Schema.nullable(),
    planEvaluationHash: Hex32Schema.nullable(),
    profile: ProfileSchema,
  }),
  issuedAt: ISODateTimeSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

/** receiptHash = keccak256(JCS(Receipt)) (docs/05 §2). */
export function computeReceiptHash(r: Receipt): Hex32 {
  return hashJcs(r);
}

/** A receipt with the kernel's EIP-712 `Receipt` signature (GET /v1/receipts/:hash, replay bundles). */
export const SignedReceiptSchema = z.strictObject({
  receipt: ReceiptSchema,
  receiptHash: Hex32Schema,
  signature: HexBytesSchema,
  signer: AddressSchema,
});
export type SignedReceipt = z.infer<typeof SignedReceiptSchema>;
