// Treasury Planner contracts (docs/03 §5.3) and the legacy timing proposal (docs/04 K-14).
import * as z from "zod";
import { PlanFactorSchema, PlanModeSchema, PlanRiskFlagSchema } from "./enums";
import { hashJcs } from "./hash";
import { AmountSchema, Hex32Schema, ISODateTimeSchema, SignedBaseUnitsSchema, type Hex32 } from "./primitives";
import { untrustedText } from "./untrusted";

export const FeasiblePlanSchema = z.strictObject({
  /** derivePlanId({intentId, mode, payAt}) */
  planId: Hex32Schema,
  mode: PlanModeSchema,
  payAt: ISODateTimeSchema,
  /** equals what K-08 will expect at payAt */
  amountDue: AmountSchema,
  /** "0" when none */
  discountValue: AmountSchema,
  impliedAprBps: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  /** projected vault balance after paying, before next obligations (can be negative in a projection) */
  liquidityAfter: SignedBaseUnitsSchema,
  reserveFloorOk: z.boolean(),
  windowEnd: ISODateTimeSchema.nullable(),
});
export type FeasiblePlan = z.infer<typeof FeasiblePlanSchema>;

export const PlanEvaluationSchema = z.strictObject({
  plans: z
    .array(z.strictObject({ planId: Hex32Schema, netBenefitBase: SignedBaseUnitsSchema, regretBase: SignedBaseUnitsSchema }))
    .max(64),
  topPlanId: Hex32Schema,
  costOfCapitalBps: z.number().int().min(0).max(1_000_000),
});
export type PlanEvaluation = z.infer<typeof PlanEvaluationSchema>;

/** The ONLY planner output (docs/03 §5.3). The kernel validates planId membership (guardrail 9). */
export const PlanSelectionSchema = z
  .strictObject({
    planId: Hex32Schema,
    rationale: untrustedText(600),
    factorsConsidered: z.array(PlanFactorSchema).max(8),
    riskFlags: z.array(PlanRiskFlagSchema).max(5),
    deviatesFromEvaluator: z.boolean(),
    deviationReason: untrustedText(600).nullable(),
  })
  .superRefine((p, ctx) => {
    if (p.deviatesFromEvaluator && p.deviationReason === null) {
      ctx.addIssue({ code: "custom", path: ["deviationReason"], message: "required when deviatesFromEvaluator" });
    }
  });
export type PlanSelection = z.infer<typeof PlanSelectionSchema>;

/**
 * Legacy timing proposal (K-14 fallback path). Not spelled out in the v2 docs; defined by SCHEMAS as the
 * minimum K-14 needs: a proposed instant (accepted inside [legalEarliest, legalLatest], else clamped) and advisory prose.
 */
export const TimingProposalSchema = z.strictObject({
  payAt: ISODateTimeSchema,
  rationale: untrustedText(600),
});
export type TimingProposal = z.infer<typeof TimingProposalSchema>;

/** planId = keccak256(JCS({intentId, mode, payAt})) (docs/03 §5.3). */
export function derivePlanId(input: { intentId: Hex32; mode: z.infer<typeof PlanModeSchema>; payAt: string }): Hex32 {
  const parsed = z.strictObject({ intentId: Hex32Schema, mode: PlanModeSchema, payAt: ISODateTimeSchema }).parse(input);
  return hashJcs(parsed);
}
