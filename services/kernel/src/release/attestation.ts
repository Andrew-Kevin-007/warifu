// The release Attestation (docs/05 s2, docs/06 A.4):
//   Attestation(bytes32 intentId,bytes32 engagementId,bytes32 milestoneId,address payee,uint256 amount,bytes32 receiptHash,uint64 deadline)
// signed by the kernel signer under the tenant vault's EIP-712 domain. The kernel signer is the INJECTED KernelSigner
// (packages/receipts ReceiptSigner shape); this module never sees a key. Like signReceipt, it does not trust the signer it is
// handed: the signature must be canonical (low-s, v in {27,28}) and recover to `signer.address`, or nothing is returned.
import { checkCanonicalSignature, recoverSigner } from "@symbolon/receipts";
import { eip712Digest, epochSecondsFromIso, symbolonDomain, toTypedDataJson } from "@symbolon/schemas";
import type { Address, Eip712Message, Hex32, ISODateTime } from "@symbolon/schemas";
import type { KernelSigner } from "../receipt/build";

export interface AttestationInput {
  readonly chainId: number;
  readonly vault: Address;
  readonly intentId: Hex32;
  readonly engagementId: Hex32;
  readonly milestoneId: Hex32;
  readonly payee: Address;
  /** Base units (decimal string): the RELEASE amount amountDue(payAt), never the gross. */
  readonly amount: string;
  /** The receipt of the RELEASE decision the vault anchors in `Released`. */
  readonly receiptHash: Hex32;
  readonly deadline: ISODateTime;
}

export interface SignedAttestation {
  readonly message: Eip712Message<"Attestation">;
  readonly digest: Hex32;
  readonly signature: `0x${string}`;
  readonly signer: Address;
}

export class AttestationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AttestationError";
  }
}

export function attestationTypedData(i: AttestationInput) {
  return toTypedDataJson("Attestation", symbolonDomain(i.chainId, i.vault), {
    intentId: i.intentId,
    engagementId: i.engagementId,
    milestoneId: i.milestoneId,
    payee: i.payee,
    amount: i.amount,
    receiptHash: i.receiptHash,
    deadline: epochSecondsFromIso(i.deadline).toString(),
  });
}

export async function signAttestation(i: AttestationInput, signer: KernelSigner): Promise<SignedAttestation> {
  if (!/^[1-9][0-9]{0,77}$/.test(i.amount)) throw new AttestationError("attestation amount must be a positive integer string");
  const td = attestationTypedData(i);
  const digest = eip712Digest(td);
  let raw: string;
  try {
    raw = await signer.signDigest(digest);
  } catch {
    throw new AttestationError("the kernel signer failed to sign the attestation");
  }
  const signature = (typeof raw === "string" ? raw.toLowerCase() : "") as `0x${string}`;
  const form = checkCanonicalSignature(signature);
  if (!form.ok) throw new AttestationError("the kernel signer returned a non-canonical signature");
  if ((await recoverSigner(digest, signature)) !== signer.address) throw new AttestationError("the attestation signature does not recover to the kernel signer");
  return { message: td.message, digest, signature, signer: signer.address };
}
