// @symbolon/receipts/approval: the WYSIWYS surface (INV-20). Pure; safe to import from apps/web (no signing, no keys,
// no chain code). buildApprovalTypedData is the ONLY producer of OwnerApproval typed data.
export { buildApprovalTypedData, buildApprovalView } from "./build";
export type { ApprovalDraft, ApprovalTypedDataSource } from "./build";
export { ADVISORY_LABEL, checkWysiwys, renderModel, signedModel } from "./render";
export type { ApprovalModel, SignedSection, WysiwysOptions, WysiwysResult } from "./render";
export type { ReceiptError, ReceiptErrorCode, Result } from "../result";
