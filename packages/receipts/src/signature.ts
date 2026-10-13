// Canonical ECDSA signatures over EIP-712 digests (secp256k1, 65 bytes r || s || v).
//
// One signature has exactly one accepted spelling, so that "flip any byte and verification fails" is true and a
// receipt cannot be re-spelled without invalidating it (RT: signature malleability; docs/13 §4.2):
//   - lowercase 0x hex, exactly 65 bytes;
//   - v is 27 or 28 (not 0/1, which viem would also accept and which recovers to the same address);
//   - 0 < r < n and 0 < s <= n/2 (low-s; (r, n - s, v ^ 1) is the malleated twin and is refused).
// Recovery is delegated to viem; this module only decides whether the bytes are in canonical form.
import { recoverAddress } from "viem";
import type { Address, Hex32 } from "@symbolon/schemas";

/** Order of the secp256k1 group. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** floor(n / 2): the largest s a canonical signature may carry. */
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

const SIGNATURE_RE = /^0x[0-9a-f]{130}$/;

export type SignatureForm = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Is `signature` the single canonical spelling described above? */
export function checkCanonicalSignature(signature: string): SignatureForm {
  if (!SIGNATURE_RE.test(signature)) return { ok: false, reason: "signature is not lowercase 0x hex of exactly 65 bytes" };
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = signature.slice(130);
  if (v !== "1b" && v !== "1c") return { ok: false, reason: "signature v byte is not 27 or 28" };
  if (r === 0n || r >= SECP256K1_N) return { ok: false, reason: "signature r is out of range" };
  if (s === 0n || s > SECP256K1_HALF_N) return { ok: false, reason: "signature s is zero or high (malleable form)" };
  return { ok: true };
}

/** The address that signed `digest` with `signature`, or null if the signature does not recover. */
export async function recoverSigner(digest: Hex32, signature: `0x${string}`): Promise<Address | null> {
  try {
    return await recoverAddress({ hash: digest, signature });
  } catch {
    return null;
  }
}
