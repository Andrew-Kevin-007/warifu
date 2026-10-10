// ApprovalView (INV-20, WYSIWYS; docs/05 §2 v2 shapes). The UI renders FROM this object and the wallet
// signs `typedData`. The builder (buildApprovalTypedData / renderModel) lives in packages/receipts (WP-02);
// this schema makes an internally inconsistent view unparseable: the signed message, the display
// strings, the hash and the expiry must all agree with the view's own fields.
import * as z from "zod";
import { OwnerApprovalTypedDataSchema, type OwnerApprovalTypedData } from "./eip712";
import { PlanModeSchema, ReasonCodeSchema } from "./enums";
import { hashJcs } from "./hash";
import { formatBaseUnits } from "./money";
import { AddressSchema, AmountSchema, DecimalsSchema, Hex32Schema, ISODateTimeSchema, epochSecondsFromIso, text, type Hex32 } from "./primitives";
import { untrustedText } from "./untrusted";

/** typedDataHash = keccak256(JCS(typedData)) (docs/05 §2), shown beside the wallet prompt. */
export function computeTypedDataHash(typedData: OwnerApprovalTypedData): Hex32 {
  return hashJcs(typedData);
}

export const ApprovalViewSchema = z
  .strictObject({
    intentId: Hex32Schema,
    /** the ESCALATION receipt the owner reviews (docs/06 A.4) */
    receiptHash: Hex32Schema,
    engagementId: Hex32Schema,
    milestoneId: Hex32Schema,
    /** label comes from the signed engagement, never from the invoice */
    payee: z.strictObject({ address: AddressSchema, label: text(200) }),
    decimals: DecimalsSchema,
    grossBaseUnits: AmountSchema,
    releaseBaseUnits: AmountSchema,
    /** produced by formatBaseUnits() only */
    display: z.strictObject({ gross: z.string().max(128), release: z.string().max(128) }),
    diffVsEngagement: z.array(z.strictObject({ field: text(64), expected: text(512), actual: untrustedText(512) })).max(32),
    reasons: z.array(ReasonCodeSchema).max(64),
    planSummary: z
      .strictObject({ planId: Hex32Schema, mode: PlanModeSchema, payAt: ISODateTimeSchema, discountValue: AmountSchema })
      .nullable(),
    expiresAt: ISODateTimeSchema,
    typedData: OwnerApprovalTypedDataSchema,
    typedDataHash: Hex32Schema,
    /** collapsed, labelled "Advisory (AI), not verified", never adjacent to Approve */
    advisory: z.strictObject({ text: untrustedText(600) }).nullable(),
  })
  .superRefine((v, ctx) => {
    const m = v.typedData.message;
    if (m.intentId !== v.intentId) ctx.addIssue({ code: "custom", path: ["typedData", "message", "intentId"], message: "≠ view.intentId" });
    if (m.receiptHash !== v.receiptHash) ctx.addIssue({ code: "custom", path: ["typedData", "message", "receiptHash"], message: "≠ view.receiptHash" });
    if (m.amount !== v.releaseBaseUnits) ctx.addIssue({ code: "custom", path: ["typedData", "message", "amount"], message: "≠ view.releaseBaseUnits" });
    if (m.deadline !== epochSecondsFromIso(v.expiresAt).toString()) {
      ctx.addIssue({ code: "custom", path: ["typedData", "message", "deadline"], message: "≠ view.expiresAt (epoch seconds)" });
    }
    if (v.display.gross !== formatBaseUnits(v.grossBaseUnits, v.decimals)) {
      ctx.addIssue({ code: "custom", path: ["display", "gross"], message: "≠ formatBaseUnits(grossBaseUnits, decimals)" });
    }
    if (v.display.release !== formatBaseUnits(v.releaseBaseUnits, v.decimals)) {
      ctx.addIssue({ code: "custom", path: ["display", "release"], message: "≠ formatBaseUnits(releaseBaseUnits, decimals)" });
    }
    if (v.typedDataHash !== computeTypedDataHash(v.typedData)) {
      ctx.addIssue({ code: "custom", path: ["typedDataHash"], message: "≠ keccak256(JCS(typedData))" });
    }
  });
export type ApprovalView = z.infer<typeof ApprovalViewSchema>;
