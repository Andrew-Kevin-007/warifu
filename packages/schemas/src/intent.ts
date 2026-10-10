// PaymentIntent: the agent's proposal (docs/05 §2). K-01 parses it with this strict schema.
import * as z from "zod";
import { AgentVerdictSchema } from "./enums";
import { ConsensusResultSchema, ExtractedInvoiceSchema } from "./extraction";
import { hashJcs } from "./hash";
import { AddressSchema, AmountSchema, Hex32Schema, ISODateTimeSchema, UUIDSchema, text, type Address, type Hex32 } from "./primitives";
import { PlanSelectionSchema, TimingProposalSchema } from "./plans";
import { untrustedText } from "./untrusted";

export const ModelIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:/@-]+$/, "expected a model id");

export const AgentRecommendationSchema = z.strictObject({
  verdict: AgentVerdictSchema,
  reasons: z.array(untrustedText(500)).max(10),
});
export type AgentRecommendation = z.infer<typeof AgentRecommendationSchema>;

export const PaymentIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    tenantId: UUIDSchema,
    documentId: UUIDSchema,
    docHash: Hex32Schema,
    extraction: z.strictObject({
      a: ExtractedInvoiceSchema,
      b: ExtractedInvoiceSchema.nullable(),
      modelA: ModelIdSchema,
      modelB: ModelIdSchema.nullable(),
      promptHashA: Hex32Schema,
      promptHashB: Hex32Schema.nullable(),
    }),
    consensus: ConsensusResultSchema,
    engagementId: Hex32Schema.nullable(),
    milestoneId: Hex32Schema.nullable(),
    /** legacy path / fallback (K-14) */
    timingProposal: TimingProposalSchema.nullable(),
    /** planner's pick from the kernel-computed feasible set (docs/03 §5.3) */
    planSelection: PlanSelectionSchema.nullable(),
    agentRecommendation: AgentRecommendationSchema.nullable(),
    submittedAt: ISODateTimeSchema,
  })
  .superRefine((p, ctx) => {
    const { b, modelB, promptHashB } = p.extraction;
    if ((b === null) !== (modelB === null) || (b === null) !== (promptHashB === null)) {
      ctx.addIssue({ code: "custom", path: ["extraction"], message: "b, modelB and promptHashB are all null or all set" });
    }
    if ((p.consensus.status === "SINGLE") !== (b === null)) {
      ctx.addIssue({ code: "custom", path: ["consensus", "status"], message: "SINGLE iff extraction.b is null" });
    }
  });
export type PaymentIntent = z.infer<typeof PaymentIntentSchema>;

/**
 * intentId = keccak256(JCS({engagementId, milestoneId, normInvoiceNo, amountBaseUnits, payee})) (docs/04 K-04).
 * `amountBaseUnits` is the GROSS invoiced amount, never the discounted release amount (P-INTENT-GROSS).
 * `normInvoiceNo` is computed by kernel-core (K-04); this helper only hashes.
 */
export function deriveIntentId(input: {
  engagementId: Hex32;
  milestoneId: Hex32;
  normInvoiceNo: string;
  amountBaseUnits: string;
  payee: Address;
}): Hex32 {
  const parsed = z
    .strictObject({
      engagementId: Hex32Schema,
      milestoneId: Hex32Schema,
      normInvoiceNo: text(128),
      amountBaseUnits: AmountSchema,
      payee: AddressSchema,
    })
    .parse(input);
  return hashJcs(parsed);
}
