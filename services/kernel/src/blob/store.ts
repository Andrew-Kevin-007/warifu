// Opaque blob storage (INV-23, RT-03): the bytes are hashed and written under their own SHA-256 and NEVER decoded,
// sniffed, decompressed or parsed. The file name is the hash, so nothing the sender controls reaches the filesystem path.
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStore {
  /** Store `bytes` under `sha256Hex` (64 lowercase hex). Idempotent. Returns the storage key. */
  put(sha256Hex: string, bytes: Uint8Array): Promise<string>;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function fileBlobStore(dir: string): BlobStore {
  return {
    async put(sha256Hex, bytes) {
      if (!HEX64.test(sha256Hex)) throw new TypeError("blob key must be 64 lowercase hex characters");
      await mkdir(dir, { recursive: true });
      try {
        const h = await open(join(dir, sha256Hex), "wx");
        try {
          await h.writeFile(bytes);
        } finally {
          await h.close();
        }
      } catch (e) {
        if ((e as { code?: unknown }).code !== "EEXIST") throw e; // content-addressed: an existing file is the same bytes
      }
      return sha256Hex;
    },
  };
}

/** For tests and deployments without blob support: refuses to store anything. */
export const noBlobStore: BlobStore = {
  put: () => Promise.reject(new Error("no blob store configured")),
};
