// Engagement, milestones, evidence requirements and signed payment terms (docs/05 §2, docs/03 §5.2, INV-19).
import * as z from "zod";
import { EngagementStatusSchema, MilestoneStatusSchema } from "./enums";
import { hashJcs } from "./hash";
import {
  AddressSchema,
  DecimalsSchema,
  Hex32Schema,
  HexBytesSchema,
  ISODateTimeSchema,
  PositiveAmountSchema,
  AmountSchema,
  Uint256StringSchema,
  UUIDSchema,
  epochSecondsFromIso,
  text,
  type Hex32,
} from "./primitives";

// --- Evidence requirements (all_of per milestone) -------------------------------------------------
export const EvidenceRequirementSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("OWNER_ACK") }),
  z.strictObject({
    type: z.literal("CI_PASS"),
    repo: z.string().max(200).regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected "owner/name"'),
    ref: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/-]+$/, "expected a commit sha or branch name"),
    workflow: z.string().min(1).max(255).regex(/^[A-Za-z0-9._/ -]+$/).exactOptional(),
  }),
  z.strictObject({
    type: z.literal("URL_HEALTH"),
    // Only the shape is checked here; the SSRF guard (K-09) re-validates host, port, DNS and redirects.
    url: z.string().max(2048).regex(/^https:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/, "expected an https URL without userinfo"),
    expectStatus: z.number().int().min(100).max(599),
    contentSha256: Hex32Schema.exactOptional(),
  }),
  z.strictObject({ type: z.literal("ARTIFACT_HASH"), sha256: Hex32Schema }),
]);
export type EvidenceRequirement = z.infer<typeof EvidenceRequirementSchema>;

// --- Signed payment terms (inside termsHash; INV-19) ------------------------------------------------
export const EarlyPaySchema = z.strictObject({
  discountBps: z.number().int().min(1).max(2000),
  withinDays: z.number().int().min(1).max(365),
});

export const PaymentTermsSchema = z
  .strictObject({
    netDays: z.number().int().min(0).max(365),
    earlyPay: EarlyPaySchema.nullable(),
    payBeforeDueBufferHours: z.number().int().min(0).max(8760),
    allowImmediate: z.boolean(),
  })
  .superRefine((t, ctx) => {
    if (t.earlyPay !== null && !(t.earlyPay.withinDays < t.netDays)) {
      ctx.addIssue({ code: "custom", path: ["earlyPay", "withinDays"], message: "earlyPay.withinDays must be < netDays" });
    }
  });
export type PaymentTerms = z.infer<typeof PaymentTermsSchema>;

// --- Milestones -----------------------------------------------------------------------------------
const milestoneTermsShape = {
  milestoneId: Hex32Schema,
  slug: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "expected a lowercase slug"),
  description: text(2000),
  amountBaseUnits: PositiveAmountSchema,
  partialAllowed: z.boolean(),
  immediate: z.boolean(),
  dueDate: ISODateTimeSchema.nullable(),
  category: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/, "expected a lowercase category key"),
  evidenceSpec: z.array(EvidenceRequirementSchema).max(16),
};

/** The signed part of a milestone: everything except the mutable `status`. */
export const MilestoneTermsSchema = z.strictObject(milestoneTermsShape);
export type MilestoneTerms = z.infer<typeof MilestoneTermsSchema>;

export const MilestoneSchema = z.strictObject({ ...milestoneTermsShape, status: MilestoneStatusSchema });
export type Milestone = z.infer<typeof MilestoneSchema>;

// --- Engagement -------------------------------------------------------------------------------------
export const EngagementSchema = z
  .strictObject({
    engagementId: Hex32Schema,
    tenantId: UUIDSchema,
    owner: AddressSchema,
    payee: AddressSchema,
    payeeLabel: text(200),
    currency: z.literal("USDC"),
    currencyDecimals: DecimalsSchema,
    capBaseUnits: AmountSchema,
    start: ISODateTimeSchema,
    end: ISODateTimeSchema,
    sequential: z.boolean(),
    milestones: z.array(MilestoneSchema).min(1).max(64),
    paymentTerms: PaymentTermsSchema.nullable(),
    termsHash: Hex32Schema,
    // Null until the party has signed (DRAFT / AWAITING_PAYEE); docs/05 §3 columns are nullable.
    ownerSig: HexBytesSchema.nullable(),
    payeeSig: HexBytesSchema.nullable(),
    nonce: Uint256StringSchema,
    status: EngagementStatusSchema,
    registeredTx: Hex32Schema.nullable(),
  })
  .superRefine((e, ctx) => {
    if (epochSecondsFromIso(e.start) > epochSecondsFromIso(e.end)) {
      ctx.addIssue({ code: "custom", path: ["end"], message: "end must be >= start" });
    }
    const ids = new Set<string>();
    const slugs = new Set<string>();
    e.milestones.forEach((m, i) => {
      if (ids.has(m.milestoneId)) ctx.addIssue({ code: "custom", path: ["milestones", i, "milestoneId"], message: "duplicate milestoneId" });
      if (slugs.has(m.slug)) ctx.addIssue({ code: "custom", path: ["milestones", i, "slug"], message: "duplicate slug" });
      ids.add(m.milestoneId);
      slugs.add(m.slug);
    });
  });
export type Engagement = z.infer<typeof EngagementSchema>;

/**
 * The termsHash preimage (docs/05 §2): {engagementId, owner, payee, payeeLabel, currency, currencyDecimals,
 * cap, start, end, sequential, milestones (incl. evidenceSpec), paymentTerms, nonce}.
 * Milestones enter without their mutable `status`. Signatures, status, tenantId, termsHash and registeredTx are excluded.
 */
export const EngagementTermsPreimageSchema = z.strictObject({
  engagementId: Hex32Schema,
  owner: AddressSchema,
  payee: AddressSchema,
  payeeLabel: text(200),
  currency: z.literal("USDC"),
  currencyDecimals: DecimalsSchema,
  cap: AmountSchema,
  start: ISODateTimeSchema,
  end: ISODateTimeSchema,
  sequential: z.boolean(),
  milestones: z.array(MilestoneTermsSchema).min(1).max(64),
  paymentTerms: PaymentTermsSchema.nullable(),
  nonce: Uint256StringSchema,
});
export type EngagementTermsPreimage = z.infer<typeof EngagementTermsPreimageSchema>;

type EngagementTermsSource = Pick<
  Engagement,
  "engagementId" | "owner" | "payee" | "payeeLabel" | "currency" | "currencyDecimals" | "capBaseUnits" | "start" | "end" | "sequential" | "milestones" | "paymentTerms" | "nonce"
>;

export function termsPreimage(e: EngagementTermsSource): EngagementTermsPreimage {
  return {
    engagementId: e.engagementId,
    owner: e.owner,
    payee: e.payee,
    payeeLabel: e.payeeLabel,
    currency: e.currency,
    currencyDecimals: e.currencyDecimals,
    cap: e.capBaseUnits,
    start: e.start,
    end: e.end,
    sequential: e.sequential,
    milestones: e.milestones.map((m) => ({
      milestoneId: m.milestoneId,
      slug: m.slug,
      description: m.description,
      amountBaseUnits: m.amountBaseUnits,
      partialAllowed: m.partialAllowed,
      immediate: m.immediate,
      dueDate: m.dueDate,
      category: m.category,
      evidenceSpec: m.evidenceSpec,
    })),
    paymentTerms: e.paymentTerms,
    nonce: e.nonce,
  };
}

/** termsHash = keccak256(JCS(terms without signatures)). */
export function computeTermsHash(e: EngagementTermsSource): Hex32 {
  return hashJcs(termsPreimage(e));
}

export function verifyTermsHash(e: Engagement): boolean {
  return computeTermsHash(e) === e.termsHash;
}

/** paymentTermsHash = keccak256(JCS(paymentTerms)) (docs/05 Receipt.inputs); null when there are no signed terms. */
export function paymentTermsHash(t: PaymentTerms | null): Hex32 | null {
  return t === null ? null : hashJcs(t);
}

/**
 * Deterministic ids (docs/05 §1): `engagementId`, `milestoneId` = keccak256(JCS({tenantId, slug|uuid})).
 * Pass exactly one of `slug` or `uuid`. Milestone slugs are only unique per engagement, so milestones
 * must use a `uuid` or a tenant-unique slug (see docs/QUESTIONS.md, WP-01).
 */
export function deriveEntityId(input: { tenantId: string; slug: string } | { tenantId: string; uuid: string }): Hex32 {
  const parsed = z
    .union([
      z.strictObject({ tenantId: UUIDSchema, slug: z.string().min(1).max(128) }),
      z.strictObject({ tenantId: UUIDSchema, uuid: UUIDSchema }),
    ])
    .parse(input);
  return hashJcs(parsed);
}
