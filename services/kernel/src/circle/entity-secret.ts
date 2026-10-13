// Entity-secret handling (WP-11). The entity secret is a 32-byte value that authorises every developer-controlled-wallet
// write. Circle never sees it in clear: each request carries a FRESH RSA-OAEP(SHA-256) ciphertext of it under Circle's
// entity public key (VERIFY(V-26): scheme as remembered from Circle's docs). It lives only in a Secret; the ciphertext is
// the only thing that leaves the process, and it is never logged.
import { constants, createHash, publicEncrypt, randomBytes } from "node:crypto";
import type { Secret } from "../secret";

const ENTITY_SECRET = /^[0-9a-f]{64}$/;

export function isValidEntitySecret(hex: string): boolean {
  return ENTITY_SECRET.test(hex);
}

/** 32 random bytes as 64 lowercase hex. `rng` is injectable for tests only. */
export function generateEntitySecret(rng: (n: number) => Buffer = randomBytes): string {
  const b = rng(32);
  if (b.length !== 32) throw new RangeError("entity secret needs 32 bytes");
  return b.toString("hex");
}

/** Fresh ciphertext (base64). OAEP is randomised, so two calls never match. */
export function encryptEntitySecret(entitySecret: Secret, publicKeyPem: string): string {
  const hex = entitySecret.reveal();
  if (!ENTITY_SECRET.test(hex)) throw new RangeError("CIRCLE_ENTITY_SECRET must be 64 lowercase hex characters");
  return publicEncrypt({ key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(hex, "hex")).toString("base64");
}

/** Deterministic RFC 4122 v4-shaped UUID from arbitrary material (Circle idempotency keys must be UUIDs, VERIFY(V-11)). */
export function uuidFromMaterial(material: string): string {
  const h = createHash("sha256").update(material, "utf8").digest();
  const b = Buffer.from(h.subarray(0, 16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
