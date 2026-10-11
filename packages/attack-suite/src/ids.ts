// Deterministic identities for fixtures. Nobody holds a key for any of these: addresses are derived from
// a hash of a label (the last 20 bytes of keccak256), so they are valid EIP-55 addresses with no known
// private key, and they can never be a real person's or a real wallet's (AGENTS.md §0.6, §0.10).
import { keccak256Utf8, sha256Utf8, type Address, type Hex32 } from "@symbolon/schemas";

/** EIP-55 checksum over a lowercase 40-hex string (the hash is taken over the ASCII hex text). */
function checksum(lower40: string): string {
  const h = keccak256Utf8(lower40).slice(2);
  let out = "";
  for (let i = 0; i < 40; i++) {
    const ch = lower40.charAt(i);
    out += parseInt(h.charAt(i), 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

export function addressFromLabel(label: string): Address {
  const lower = keccak256Utf8(`symbolon-fixture-address/1:${label}`).slice(-40);
  return `0x${checksum(lower)}`;
}

export function hex32FromLabel(label: string): Hex32 {
  return sha256Utf8(`symbolon-fixture-hex32/1:${label}`);
}

/** Lowercase RFC 9562 version-4-shaped uuid derived from a label. */
export function uuidFromLabel(label: string): string {
  const h = sha256Utf8(`symbolon-fixture-uuid/1:${label}`).slice(2, 34);
  const variant = ["8", "9", "a", "b"][parseInt(h.charAt(16), 16) % 4] as string;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A 40-hex commit-sha-looking id for CI fixtures. */
export function gitShaFromLabel(label: string): string {
  return sha256Utf8(`symbolon-fixture-sha/1:${label}`).slice(2, 42);
}
