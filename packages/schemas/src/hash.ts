// Hash helpers (docs/05 §1): keccak256 over the UTF-8 bytes of the JCS text of an object;
// documents are hashed over their raw bytes. All digests are lowercase 0x-prefixed hex (Hex32).
import { keccak256 as viemKeccak256, sha256 as viemSha256, stringToBytes } from "viem";
import { JcsError, isWellFormedString, jcs } from "./jcs";
import type { Hex32 } from "./primitives";

function utf8(s: string): Uint8Array {
  // TextEncoder would silently turn a lone surrogate into U+FFFD; refuse instead.
  if (!isWellFormedString(s)) throw new JcsError("lone UTF-16 surrogate in string", "$");
  return stringToBytes(s);
}

export function keccak256Bytes(bytes: Uint8Array): Hex32 {
  return viemKeccak256(bytes);
}

export function keccak256Utf8(s: string): Hex32 {
  return viemKeccak256(utf8(s));
}

export function sha256Bytes(bytes: Uint8Array): Hex32 {
  return viemSha256(bytes);
}

export function sha256Utf8(s: string): Hex32 {
  return viemSha256(utf8(s));
}

/** keccak256(UTF-8(JCS(value))): the hash of every object Symbolon signs or anchors. */
export function hashJcs(value: unknown): Hex32 {
  return keccak256Utf8(jcs(value));
}
