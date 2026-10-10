// policy.yaml shape (docs/04 §7) as JSON. packages/policy (WP-03) loads YAML, parses it with this schema,
// converts the decimal amount strings to bigint base units with `currency.decimals`, computes
// policyHash = keccak256(JCS(json)) and checks it against the vault. Amounts are strings, never floats.
import * as z from "zod";
import { DecimalAmountSchema, DecimalsSchema } from "./primitives";

const count = z.number().int().min(0).max(1_000_000);
const hours = z.number().int().min(0).max(87_600);

export const PolicyCapsSchema = z.strictObject({
  perTxHardCap: DecimalAmountSchema,
  dailyCap: DecimalAmountSchema,
  /** P1; absent or "0" = off */
  hourlyCap: DecimalAmountSchema.exactOptional(),
  weeklyCap: DecimalAmountSchema,
  humanApprovalAbove: DecimalAmountSchema,
});

export const PolicyVelocitySchema = z.strictObject({
  maxReleasesPerDay: count,
  maxReleasesPerPayeePerDay: count,
  maxAmountPerPayeePerDay: DecimalAmountSchema,
});

export const PolicyNewPayeeSchema = z.strictObject({ firstPaymentMax: DecimalAmountSchema, alwaysHuman: z.boolean() });

export const PolicyReserveSchema = z.strictObject({ floor: DecimalAmountSchema, lookaheadDays: z.number().int().min(0).max(3650) });

export const PolicyTimingSchema = z.strictObject({
  disputeWindowHours: hours,
  payBeforeDueBufferHours: hours,
  allowImmediate: z.boolean(),
  defaultNetDays: z.number().int().min(0).max(365),
  windowSafetyMarginMinutes: z.number().int().min(0).max(525_600),
});

export const PolicyEscalationSchema = z.strictObject({ maxPerDay: count, maxPerEngagementPerDay: count });

export const PolicyLimitsSchema = z.strictObject({ maxDocChars: z.number().int().min(1).max(20_000) });

export const PolicyEvidenceSchema = z.strictObject({
  freshnessHours: hours,
  allowOwnerOverride: z.boolean(),
  urlAllowlist: z.array(z.string().max(2048).regex(/^https:\/\/[^\s/?#@]+$/, "expected an https origin pattern")).max(64),
});

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  tenant: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  currency: z.strictObject({ code: z.literal("USDC"), decimals: DecimalsSchema, treatUsdAsUsdc: z.boolean() }),
  caps: PolicyCapsSchema,
  velocity: PolicyVelocitySchema,
  newPayee: PolicyNewPayeeSchema,
  /** monthly budget per category key */
  categories: z.record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).max(64), DecimalAmountSchema),
  reserve: PolicyReserveSchema,
  timing: PolicyTimingSchema,
  treasury: z.strictObject({ costOfCapitalBps: z.number().int().min(0).max(1_000_000) }),
  escalation: PolicyEscalationSchema,
  limits: PolicyLimitsSchema,
  evidence: PolicyEvidenceSchema,
  extraction: z.strictObject({ allowSingle: z.boolean() }),
  screening: z.strictObject({ required: z.boolean(), staleAfterHours: hours }),
  /** hours; may be fractional for demos (0.17 ≈ 10 min). Not money. */
  reconciliation: z.strictObject({ ackWindowHours: z.number().min(0).max(87_600) }),
});
export type Policy = z.infer<typeof PolicySchema>;

/** Sandbox scenario overrides (docs/15 §2: "small caps, e.g. perTx 25, daily 60"). Every key optional. */
export const PolicyOverridesSchema = z.strictObject({
  caps: PolicyCapsSchema.partial().exactOptional(),
  velocity: PolicyVelocitySchema.partial().exactOptional(),
  newPayee: PolicyNewPayeeSchema.partial().exactOptional(),
  reserve: PolicyReserveSchema.partial().exactOptional(),
  timing: PolicyTimingSchema.partial().exactOptional(),
  escalation: PolicyEscalationSchema.partial().exactOptional(),
  limits: PolicyLimitsSchema.partial().exactOptional(),
  evidence: PolicyEvidenceSchema.partial().exactOptional(),
});
export type PolicyOverrides = z.infer<typeof PolicyOverridesSchema>;
