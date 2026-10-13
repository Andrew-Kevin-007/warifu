// @symbolon/receipts (owner: KERNEL-CORE, WP-02): RFC 8785 JCS -> keccak256 -> EIP-712 receipts (DEC-009).
//   buildReceipt   Decision + inputs -> Receipt + receiptHash       (pure)
//   signReceipt    sign with an INJECTED signer, then self-verify  (no key is ever read here)
//   verifyReceipt  schema, hash, signature, signer pin, optional on-chain anchor (never throws)
//   approval/*     buildApprovalTypedData / buildApprovalView / renderModel / signedModel / checkWysiwys (INV-20)
// The on-chain anchor check lives in "@symbolon/receipts/anchor" (it needs @symbolon/chain); the CLI in src/cli.
export const PACKAGE_NAME = "@symbolon/receipts" as const;

export { attempt, attemptAsync, describeIssues, err, ok } from "./result";
export type { ReceiptError, ReceiptErrorCode, Result } from "./result";
export { buildReceipt } from "./build";
export type { BuildReceiptOptions, BuiltReceipt } from "./build";
export { receiptDigest, receiptTypedData, signReceipt } from "./sign";
export type { ReceiptSigner } from "./sign";
export { SECP256K1_HALF_N, SECP256K1_N, checkCanonicalSignature, recoverSigner } from "./signature";
export type { SignatureForm } from "./signature";
export { MAX_RECEIPT_FILE_BYTES, findDuplicateKey, parseReceiptJson } from "./json";
export { VERIFY_CHECK_IDS, verifyReceipt, verifyReceiptJson } from "./verify";
export type { AnchorOutcome, VerifyCheck, VerifyCheckId, VerifyOptions, VerifyReport, VerifyStatus } from "./verify";
export { ADVISORY_LABEL, buildApprovalTypedData, buildApprovalView, checkWysiwys, renderModel, signedModel } from "./approval/index";
export type { ApprovalDraft, ApprovalModel, ApprovalTypedDataSource, SignedSection, WysiwysOptions, WysiwysResult } from "./approval/index";
