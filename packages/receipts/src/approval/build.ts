// WYSIWYS approval (INV-20, RT-12/13). `buildApprovalTypedData` is the ONLY function in the codebase that produces the
// `OwnerApproval` typed data an owner signs; `buildApprovalView` assembles the whole ApprovalView around it.
// Both are pure and are imported by services/kernel (to build the view), apps/web (to re-derive and sign), the
// attack suite (ATK-22/23/24) and the SEC suite (SEC-13). Nothing here reads a clock: `expiresAt` is an argument.
//
//   OwnerApproval(bytes32 intentId, bytes32 receiptHash, uint256 amount, uint64 deadline)
//     intentId, receiptHash  from the view (receiptHash is the ESCALATION receipt the owner reviewed, docs/05 §2);
//     amount                 = releaseBaseUnits (what the vault would pay, so an approval for X never releases X + 1);
//     deadline               = epoch seconds of expiresAt.
//
// The view is parsed with the frozen ApprovalViewSchema, which refuses a view whose typed data, display strings,
// hash or expiry disagree with its own fields, so an inconsistent view cannot be produced here or accepted later.
// The advisory (AI) note is sanitized again here: it is inert, short, and never imperative (RT-12, ATK-24).
import {
  ApprovalViewSchema,
  OwnerApprovalTypedDataSchema,
  computeTypedDataHash,
  epochSecondsFromIso,
  formatBaseUnits,
  inspectUntrusted,
  sanitizeLlmText,
  toTypedDataJson,
  type Address,
  type ApprovalView,
  type Eip712Domain,
  type Hex32,
  type ISODateTime,
  type OwnerApprovalTypedData,
} from "@symbolon/schemas";
import { attempt, describeIssues, err, ok, type Result } from "../result";

/** The four facts the signature commits to, plus the vault domain. A full ApprovalView is accepted in its place. */
export interface ApprovalTypedDataSource {
  readonly intentId: Hex32;
  /** The ESCALATION receipt the owner reviews. */
  readonly receiptHash: Hex32;
  /** What the vault would release (amountDue), in base units. */
  readonly releaseBaseUnits: string;
  readonly expiresAt: ISODateTime;
  readonly domain: Eip712Domain;
}

/** The only producer of OwnerApproval typed data. A full view contributes its own domain (`view.typedData.domain`). */
export function buildApprovalTypedData(source: ApprovalTypedDataSource | ApprovalView): Result<OwnerApprovalTypedData> {
  return attempt(
    () => {
      const domain = "typedData" in source ? source.typedData.domain : source.domain;
      const td = toTypedDataJson("OwnerApproval", domain, {
        intentId: source.intentId,
        receiptHash: source.receiptHash,
        amount: source.releaseBaseUnits,
        deadline: epochSecondsFromIso(source.expiresAt).toString(),
      });
      return ok(OwnerApprovalTypedDataSchema.parse(td));
    },
    "APPROVAL_INVALID",
    "the approval typed data inputs are invalid",
  );
}

/** Everything the kernel knows about a pending approval. All amounts are base units; none is a JS number. */
export interface ApprovalDraft {
  readonly intentId: Hex32;
  readonly receiptHash: Hex32;
  readonly engagementId: Hex32;
  readonly milestoneId: Hex32;
  /** `label` comes from the SIGNED engagement, never from the invoice. */
  readonly payee: { readonly address: Address; readonly label: string };
  readonly decimals: number;
  readonly grossBaseUnits: string;
  readonly releaseBaseUnits: string;
  readonly diffVsEngagement: ApprovalView["diffVsEngagement"];
  readonly reasons: ApprovalView["reasons"];
  readonly planSummary: ApprovalView["planSummary"];
  readonly expiresAt: ISODateTime;
  readonly advisory: ApprovalView["advisory"];
  readonly domain: Eip712Domain;
}

export function buildApprovalView(draft: ApprovalDraft): Result<ApprovalView> {
  return attempt(
    () => {
      const td = buildApprovalTypedData(draft);
      if (!td.ok) return td;
      const note = draft.advisory === null ? null : sanitizeLlmText(draft.advisory.text, { maxChars: 600, maxWords: 60 });
      const parsed = ApprovalViewSchema.safeParse({
        intentId: draft.intentId,
        receiptHash: draft.receiptHash,
        engagementId: draft.engagementId,
        milestoneId: draft.milestoneId,
        payee: draft.payee,
        decimals: draft.decimals,
        grossBaseUnits: draft.grossBaseUnits,
        releaseBaseUnits: draft.releaseBaseUnits,
        display: {
          gross: formatBaseUnits(draft.grossBaseUnits, draft.decimals),
          release: formatBaseUnits(draft.releaseBaseUnits, draft.decimals),
        },
        diffVsEngagement: draft.diffVsEngagement,
        reasons: draft.reasons,
        planSummary: draft.planSummary,
        expiresAt: draft.expiresAt,
        typedData: td.value,
        typedDataHash: computeTypedDataHash(td.value),
        advisory: note === null || inspectUntrusted(note).length === 0 ? null : { text: note },
      });
      if (!parsed.success) return err("APPROVAL_INVALID", `approval view rejected by ApprovalViewSchema: ${describeIssues(parsed.error.issues)}`);
      return ok(parsed.data);
    },
    "APPROVAL_INVALID",
    "the approval view inputs are invalid",
  );
}
