// POST /documents (docs/05 s4, INV-23, INV-19). The input is TEXT produced by apps/web plus an optional opaque blob.
// The kernel normalizes the text with the pure schemas function, records `receivedAt` itself (the discount clock starts
// here, never from anything printed in the document), hashes everything, stores the blob without ever reading it, and
// refuses anything that looks like a binary payload before it is stored.
//
// Hashes (docs/QUESTIONS WP-10): docHash = keccak256(UTF-8 bytes of the submitted text); normalizedHash =
// keccak256(UTF-8 bytes of the normalized text); blobSha256 = SHA-256 of the blob bytes. The same text posted twice returns the
// FIRST row (and its original receivedAt): re-posting can never move the discount clock.
import {
  MAX_DOC_CHARS,
  inspectUntrusted,
  isWellFormedString,
  keccak256Utf8,
  normalizeUntrusted,
  sha256Bytes,
  toExcerpt,
} from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import { binaryKind, utf8ByteLength } from "@symbolon/kernel-core";
import { normalizePolicy } from "@symbolon/policy";
import { ApiError } from "../errors";
import type { BlobStore } from "../blob/store";
import type { Db } from "../db/pool";
import * as repo from "../db/repo";
import { nowIso } from "../time";
import type { Clock } from "../time";
import type { Profile } from "../boot";

export const SANDBOX_MAX_DOC_BYTES = 4096;
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export interface DocumentsDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly blobs: BlobStore;
  readonly maxBlobBytes: number;
}

export interface IngestInput {
  readonly tenantId: string;
  readonly text: unknown;
  readonly mime: unknown;
  readonly blob: Uint8Array | null;
}

export interface IngestResult {
  readonly documentId: string;
  readonly docHash: Hex32;
  readonly normalizedHash: Hex32;
  readonly blobSha256: Hex32 | null;
  readonly receivedAt: string;
  readonly created: boolean;
  /** Sanitized single-line excerpt (still Untrusted for display). */
  readonly textPreview: string;
}

async function tenantDocLimit(db: Db, tenantId: string): Promise<number> {
  const t = await repo.getTenant(db, tenantId);
  if (t === null) throw new ApiError("FORBIDDEN", "unknown tenant");
  try {
    return Math.min(normalizePolicy(t.policy).policy.limits.maxDocChars, MAX_DOC_CHARS);
  } catch {
    throw new ApiError("UNAVAILABLE", "tenant policy is unavailable");
  }
}

export async function ingestDocument(d: DocumentsDeps, i: IngestInput): Promise<IngestResult> {
  if (typeof i.text !== "string") throw new ApiError("BAD_REQUEST", "text is required");
  const text = i.text;
  const mime = i.mime === undefined || i.mime === null || i.mime === "" ? "text/plain" : i.mime;
  if (typeof mime !== "string" || mime.length > 128 || !MIME.test(mime)) throw new ApiError("BAD_REQUEST", "mime must be a lowercase type/subtype");
  if (d.profile === "sandbox" && (mime !== "text/plain" || i.blob !== null)) {
    throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "the sandbox accepts plain text only");
  }

  // Binary / oversize rejection happens before anything is hashed or stored (SEC-09: bounded work, no parser).
  if (!isWellFormedString(text)) throw new ApiError("NOT_TEXT", "text is not valid Unicode");
  const bytes = utf8ByteLength(text);
  if (d.profile === "sandbox" ? bytes > SANDBOX_MAX_DOC_BYTES : false) throw new ApiError("PAYLOAD_TOO_LARGE", "text exceeds the sandbox limit", { maxBytes: SANDBOX_MAX_DOC_BYTES });
  const maxChars = await tenantDocLimit(d.db, i.tenantId);
  if (text.length > maxChars) throw new ApiError("PAYLOAD_TOO_LARGE", "text exceeds the document limit", { maxChars });
  const kind = binaryKind(text);
  if (kind !== null) throw new ApiError("NOT_TEXT", "text looks like a binary payload", { kind });

  const n = normalizeUntrusted(text);
  const normalized = inspectUntrusted(n.normalized);
  if (normalized.trim().length === 0) throw new ApiError("UNPROCESSABLE", "document is empty after normalization");

  let blobSha256: Hex32 | null = null;
  let storageKey: string | null = null;
  if (i.blob !== null) {
    if (i.blob.byteLength === 0) throw new ApiError("BAD_REQUEST", "blob is empty");
    if (i.blob.byteLength > d.maxBlobBytes) throw new ApiError("PAYLOAD_TOO_LARGE", "blob exceeds the upload limit", { maxBytes: d.maxBlobBytes });
    blobSha256 = sha256Bytes(i.blob);
    try {
      storageKey = await d.blobs.put(blobSha256.slice(2), i.blob); // never decoded or parsed
    } catch {
      throw new ApiError("UNAVAILABLE", "blob storage is unavailable");
    }
  }

  const rawHash = keccak256Utf8(text);
  const normalizedHash = keccak256Utf8(normalized);
  const receivedAt = nowIso(d.clock);
  const { doc, created } = await d.db.tx((q) =>
    repo.insertDocumentOnce(q, {
      tenantId: i.tenantId,
      rawHash,
      normalizedHash,
      blobSha256,
      mime,
      storageKey,
      normalizedText: normalized,
      zeroWidthCount: n.removedCount,
      receivedAt,
    }),
  );
  return {
    documentId: doc.documentId,
    docHash: doc.rawHash,
    normalizedHash: doc.normalizedHash,
    blobSha256: doc.blobSha256,
    receivedAt: doc.receivedAt,
    created,
    textPreview: toExcerpt(doc.normalizedText, 240),
  };
}
