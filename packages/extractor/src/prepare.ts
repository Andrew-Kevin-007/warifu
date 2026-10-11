// Document preparation: size cap, normalization (guardrail 7), hashes. Runs BEFORE any model call or budget charge.
//
// The extractor receives TEXT only. PDF text-layer extraction (size/page/time/memory caps) happens in apps/web
// (RT-03, INV-23); nothing in this package parses a binary format.
import { inspectUntrusted, normalizeUntrusted, sha256Bytes, type Hex32, type NormalizeCounts, type Untrusted } from "@symbolon/schemas";

/** Default cap for pilot documents (UTF-8 bytes). The public challenge passes 4096 (RT-03/INV-23). */
export const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024;

export interface PreparedDocument {
  /** sha256 of the original UTF-8 bytes (lossy for ill-formed strings). */
  readonly originalHash: Hex32;
  /** sha256 of the normalized text: what the model sees and what `amount.printed` must be a substring of. */
  readonly normalizedHash: Hex32;
  readonly normalized: Untrusted<string>;
  readonly removedCount: number;
  readonly counts: NormalizeCounts;
  readonly originalBytes: number;
}

export type PrepareFailure =
  | { readonly code: "DOC_TOO_LARGE"; readonly bytes: number; readonly max: number }
  | { readonly code: "DOC_EMPTY" };

export type PrepareResult = { readonly ok: true; readonly value: PreparedDocument } | { readonly ok: false; readonly error: PrepareFailure };

const encoder = new TextEncoder();

export function prepareDocument(raw: string, options: { readonly maxBytes?: number } = {}): PrepareResult {
  if (typeof raw !== "string") throw new TypeError("prepareDocument expects a string");
  const max = options.maxBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
  const originalBytes = encoder.encode(raw);
  if (originalBytes.length > max) return { ok: false, error: { code: "DOC_TOO_LARGE", bytes: originalBytes.length, max } };
  const n = normalizeUntrusted(raw);
  const text = inspectUntrusted(n.normalized);
  if (text.trim().length === 0) return { ok: false, error: { code: "DOC_EMPTY" } };
  return {
    ok: true,
    value: {
      originalHash: sha256Bytes(originalBytes),
      normalizedHash: sha256Bytes(encoder.encode(text)),
      normalized: n.normalized,
      removedCount: n.removedCount,
      counts: n.counts,
      originalBytes: originalBytes.length,
    },
  };
}
