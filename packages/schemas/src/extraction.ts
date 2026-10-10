// D1 extraction contract (docs/03 §3) and dual-model consensus (docs/03 §4, K-10).
// Every string copied out of the document is Untrusted (INV-15).
import * as z from "zod";
import { AnomalyCodeSchema, DecimalSeparatorGuessSchema, DocTypeSchema, type ConsensusStatus } from "./enums";
import { jcs } from "./jcs";
import { AddressSchema, AmountSchema, ISODateSchema } from "./primitives";
import { untrusted, untrustedText, type Untrusted } from "./untrusted";

/** What the INVOICE claims about terms: compared with the signed terms, never adopted (INV-19). */
export const StatedTermsSchema = z.strictObject({
  raw: untrustedText(256).nullable(),
  netDays: z.number().int().min(0).max(3650).nullable(),
  earlyPay: z
    .strictObject({
      discountBps: z.number().int().min(0).max(10_000),
      withinDays: z.number().int().min(0).max(3650),
    })
    .nullable(),
  ambiguous: z.boolean(),
});
export type StatedTerms = z.infer<typeof StatedTermsSchema>;

export const ExtractedInvoiceSchema = z.strictObject({
  docType: DocTypeSchema,
  invoiceNumber: untrustedText(128),
  issueDate: ISODateSchema.nullable(),
  dueDate: ISODateSchema.nullable(),
  payee: z.strictObject({
    legalName: untrustedText(256).nullable(),
    /** EIP-55 if present (the extractor checksums it), else null. Never invented. */
    walletAddress: AddressSchema.nullable(),
    claimsAddressChange: z.boolean(),
  }),
  amount: z.strictObject({
    /** EXACT substring of the normalized document text. */
    printed: untrustedText(64),
    currencyPrinted: untrustedText(32),
    decimalSeparatorGuess: DecimalSeparatorGuessSchema,
    /** Only if unambiguous; else null. */
    parsedBaseUnits: AmountSchema.nullable(),
    decimals: z.number().int().min(0).max(255).nullable(),
  }),
  references: z.strictObject({
    engagementId: untrustedText(128).nullable(),
    milestoneId: untrustedText(128).nullable(),
    poNumber: untrustedText(128).nullable(),
  }),
  statedTerms: StatedTermsSchema,
  lineItems: z
    .array(z.strictObject({ description: untrustedText(500), amountPrinted: untrustedText(64).nullable() }))
    .max(200),
  anomalies: z.array(z.strictObject({ code: AnomalyCodeSchema, quote: untrustedText(500) })).max(50),
  /** 0..1, INFORMATIONAL ONLY; never used for release (INV-8). */
  confidence: z.number().min(0).max(1),
});
export type ExtractedInvoice = z.infer<typeof ExtractedInvoiceSchema>;

/** Fields compared by consensus(A, B), in this order (docs/03 §4). */
export const CONSENSUS_FIELDS = [
  "payee.walletAddress",
  "amount.printed",
  "amount.parsedBaseUnits",
  "invoiceNumber",
  "docType",
  "references.engagementId",
  "references.milestoneId",
  "references.poNumber",
  "statedTerms.netDays",
  "statedTerms.earlyPay",
] as const;
export type ConsensusField = (typeof CONSENSUS_FIELDS)[number];
export const ConsensusFieldSchema = z.enum(CONSENSUS_FIELDS);

export const ConsensusDiffSchema = z.strictObject({
  field: ConsensusFieldSchema,
  /** JCS text of the value in A / B (so `null` and the string "null" differ). */
  a: untrustedText(2000),
  b: untrustedText(2000),
});
export type ConsensusDiff = z.infer<typeof ConsensusDiffSchema>;

export const ConsensusResultSchema = z
  .strictObject({
    status: z.enum(["AGREE", "DISAGREE", "SINGLE"]),
    diffs: z.array(ConsensusDiffSchema).max(CONSENSUS_FIELDS.length),
  })
  .superRefine((c, ctx) => {
    if ((c.status === "DISAGREE") !== c.diffs.length > 0) {
      ctx.addIssue({ code: "custom", path: ["diffs"], message: "DISAGREE iff diffs is non-empty" });
    }
  });
export type ConsensusResult = { status: ConsensusStatus; diffs: ConsensusDiff[] };

function fieldValue(x: ExtractedInvoice, field: ConsensusField): unknown {
  switch (field) {
    case "payee.walletAddress":
      return x.payee.walletAddress;
    case "amount.printed":
      return x.amount.printed;
    case "amount.parsedBaseUnits":
      return x.amount.parsedBaseUnits;
    case "invoiceNumber":
      return x.invoiceNumber;
    case "docType":
      return x.docType;
    case "references.engagementId":
      return x.references.engagementId;
    case "references.milestoneId":
      return x.references.milestoneId;
    case "references.poNumber":
      return x.references.poNumber;
    case "statedTerms.netDays":
      return x.statedTerms.netDays;
    case "statedTerms.earlyPay":
      return x.statedTerms.earlyPay;
    default: {
      const never: never = field;
      throw new Error(`unhandled consensus field ${String(never)}`);
    }
  }
}

/**
 * Pure field-level comparison of two extractions (exact equality of canonical JSON; no fuzzy matching).
 * `b === null` ⇒ SINGLE. Any difference ⇒ DISAGREE with one diff per differing field, in CONSENSUS_FIELDS order.
 * K-10 should recompute this from intent.extraction rather than trust intent.consensus.
 */
export function consensus(a: ExtractedInvoice, b: ExtractedInvoice | null): ConsensusResult {
  if (b === null) return { status: "SINGLE", diffs: [] };
  const diffs: ConsensusDiff[] = [];
  for (const field of CONSENSUS_FIELDS) {
    const va = jcs(fieldValue(a, field));
    const vb = jcs(fieldValue(b, field));
    if (va !== vb) diffs.push({ field, a: untrusted(va) as Untrusted<string>, b: untrusted(vb) });
  }
  return { status: diffs.length === 0 ? "AGREE" : "DISAGREE", diffs };
}
