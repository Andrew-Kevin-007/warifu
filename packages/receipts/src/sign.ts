// EIP-712 `Receipt(bytes32 receiptHash, bytes32 intentId, uint8 verdict, bytes32 policyHash, uint64 issuedAt)` signed by
// the kernel signer (docs/05 §2). The key is INJECTED as a ReceiptSigner: this package never sees, reads or stores a
// private key (AGENTS.md §0.10). `signDigest` signs the 32-byte EIP-712 digest, i.e. the same bytes a wallet's
// eth_signTypedData_v4 would sign for the same typed data; services/kernel's KernelSigner already has this shape.
//
// signReceipt() does not trust the signer it is handed: it checks that the receiptHash really is the hash of the
// receipt, that the signature is in canonical form and that it recovers to `signer.address`, before it returns.
// A misconfigured signer (wrong key, wrong digest, a malleated or truncated signature) yields `ok: false`.
import {
  SignedReceiptSchema,
  AddressSchema,
  computeReceiptHash,
  eip712Digest,
  epochSecondsFromIso,
  receiptEip712Message,
  toTypedDataJson,
  type Address,
  type Eip712Domain,
  type Hex32,
  type Receipt,
  type SignedReceipt,
  type TypedDataJson,
} from "@symbolon/schemas";
import type { BuiltReceipt } from "./build";
import { attempt, attemptAsync, describeIssues, err, ok, type Result } from "./result";
import { checkCanonicalSignature, recoverSigner } from "./signature";

export interface ReceiptSigner {
  /** EIP-55 address of the kernel signer key. */
  readonly address: Address;
  /** Sign a 32-byte EIP-712 digest and return the 65-byte signature (r || s || v) as hex. */
  signDigest(digest: Hex32): Promise<`0x${string}`>;
}

/** The typed data the kernel signer signs for a receipt. The domain is the tenant vault's (name, version, chainId, vault). */
export function receiptTypedData(receipt: Receipt, receiptHash: Hex32, domain: Eip712Domain): Result<TypedDataJson<"Receipt">> {
  return attempt(
    () =>
      ok(
        toTypedDataJson(
          "Receipt",
          domain,
          receiptEip712Message({
            receiptHash,
            intentId: receipt.decision.intentId,
            verdict: receipt.decision.verdict,
            policyHash: receipt.decision.policyHash,
            issuedAtEpochSeconds: epochSecondsFromIso(receipt.issuedAt),
          }),
        ),
      ),
    "INTERNAL",
    "cannot build the Receipt typed data",
  );
}

/** The EIP-712 digest of the Receipt typed data (what the signer signs and what a verifier recovers from). */
export function receiptDigest(receipt: Receipt, receiptHash: Hex32, domain: Eip712Domain): Result<Hex32> {
  return attempt(
    () => {
      const td = receiptTypedData(receipt, receiptHash, domain);
      return td.ok ? ok(eip712Digest(td.value)) : td;
    },
    "INTERNAL",
    "cannot compute the Receipt digest",
  );
}

export async function signReceipt(built: BuiltReceipt, signer: ReceiptSigner, domain: Eip712Domain): Promise<Result<SignedReceipt>> {
  return attemptAsync(
    async () => {
      if (computeReceiptHash(built.receipt) !== built.receiptHash) {
        return err("RECEIPT_INVALID", "receiptHash is not the hash of the receipt; refusing to sign");
      }
      if (!AddressSchema.safeParse(signer.address).success) return err("SIGNER_FAILED", "signer address is not an EIP-55 address");
      const digest = receiptDigest(built.receipt, built.receiptHash, domain);
      if (!digest.ok) return digest;

      let raw: string;
      try {
        raw = await signer.signDigest(digest.value);
      } catch {
        return err("SIGNER_FAILED", "the signer failed to sign the digest");
      }
      const signature = typeof raw === "string" ? raw.toLowerCase() : "";
      const form = checkCanonicalSignature(signature);
      if (!form.ok) return err("SIGNER_FAILED", form.reason);
      const recovered = await recoverSigner(digest.value, signature as `0x${string}`);
      if (recovered !== signer.address) return err("SIGNER_MISMATCH", "the signature does not recover to the signer's address");

      const signed = SignedReceiptSchema.safeParse({ receipt: built.receipt, receiptHash: built.receiptHash, signature, signer: signer.address });
      if (!signed.success) return err("RECEIPT_INVALID", `signed receipt rejected by SignedReceiptSchema: ${describeIssues(signed.error.issues)}`);
      return ok(signed.data);
    },
    "INTERNAL",
    "unexpected error while signing a receipt",
  );
}
