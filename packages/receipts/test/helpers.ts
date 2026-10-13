// Shared test material. Keys are derived at run time from a label and used only here: no key literal is committed, the
// derived accounts hold nothing anywhere, and the package under test never sees a key (it gets a ReceiptSigner).
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { SignedReceipt } from "@symbolon/schemas";
import { buildReceipt, signReceipt, type ReceiptSigner } from "../src/index";
import {
  DOMAIN,
  ESCALATION_DECISION,
  ESCALATION_RECEIPT,
  RELEASE_DECISION,
  RELEASE_RECEIPT,
} from "../../schemas/test/fixtures";

export { DOMAIN, ESCALATION_DECISION, ESCALATION_RECEIPT, RELEASE_DECISION, RELEASE_RECEIPT };

export function accountFor(label: string) {
  return privateKeyToAccount(keccak256(toHex(`symbolon-receipts-test:${label}`)));
}

export function signerFor(label: string): ReceiptSigner {
  const account = accountFor(label);
  return { address: account.address, signDigest: (digest) => account.sign({ hash: digest }) };
}

export const KERNEL = signerFor("kernel");
export const STRANGER = signerFor("stranger");

/** A properly built and signed receipt for a decision (default: the final RELEASE one). */
export async function signed(which: "RELEASE" | "ESCALATE" = "RELEASE", signer: ReceiptSigner = KERNEL, domain = DOMAIN): Promise<SignedReceipt> {
  const decision = which === "RELEASE" ? RELEASE_DECISION : ESCALATION_DECISION;
  const base = which === "RELEASE" ? RELEASE_RECEIPT : ESCALATION_RECEIPT;
  const built = buildReceipt(decision, base.inputs);
  if (!built.ok) throw new Error(`fixture does not build: ${built.error.message}`);
  const result = await signReceipt(built.value, signer, domain);
  if (!result.ok) throw new Error(`fixture does not sign: ${result.error.message}`);
  return result.value;
}
