// Text helpers for K-01 (INV-23: the kernel never parses binary) and K-04 (invoice-number normalization).
// Pure string scanning; nothing here decodes, opens or interprets a payload.
import { isWellFormedString } from "@symbolon/schemas";

export type BinaryKind = "NUL" | "LONE_SURROGATE" | "CONTROL" | "REPLACEMENT_RUN" | "DATA_URI" | "ENCODED_RUN";

/**
 * Longest base64/base64url/hex-alphabet run accepted in kernel text. K-11 (WP-05) already flags runs over 200
 * characters for a human; a run of 512+ is treated as an embedded binary payload and refused outright.
 */
export const ENCODED_RUN_LIMIT = 512;

/** C0 controls except TAB (9), LF (10) and CR (13); DEL and C1 controls (0x7F-0x9F). NUL is reported separately. */
function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}
const REPLACEMENT_RUN = /�{3,}/;
// "data:<type>/<subtype>[;params],": a data URI. Plain prose such as "Data: 2026-10-01" does not match.
const DATA_URI = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9.+=-]*)*,/i;
const ENCODED_RUN = new RegExp(`[A-Za-z0-9+/=_-]{${ENCODED_RUN_LIMIT},}`);

/**
 * Why `s` looks like a binary payload rather than text, or null. Tab, LF and CR are text; every other C0
 * control, DEL and C1 control is not; a lone surrogate is invalid UTF-8; a run of U+FFFD is what lenient
 * decoding of binary produces; data: URIs and long encoded runs are embedded files.
 */
export function binaryKind(s: string): BinaryKind | null {
  if (s.includes("\u0000")) return "NUL";
  if (!isWellFormedString(s)) return "LONE_SURROGATE";
  if (hasControl(s)) return "CONTROL";
  if (REPLACEMENT_RUN.test(s)) return "REPLACEMENT_RUN";
  if (DATA_URI.test(s)) return "DATA_URI";
  if (ENCODED_RUN.test(s)) return "ENCODED_RUN";
  return null;
}

/** UTF-8 byte length of a well-formed string (a lone surrogate counts 3, as U+FFFD would). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Maximum length of a normalized invoice number (the intentId preimage field is text(128), packages/schemas). */
export const MAX_NORM_INVOICE_NO = 128;

/**
 * normInvoiceNo = upper(strip non-alphanumerics, strip leading zeros) (docs/04 K-04), after NFKC so that
 * full-width or ligature spellings collapse to the same ASCII form. Only [A-Z0-9] survive; leading zeros of the
 * whole string are stripped (literal reading: "INV-001" -> "INV001", "0042" -> "42"). Returns null when the
 * result exceeds MAX_NORM_INVOICE_NO characters (NFKC can expand: "ﬃ" -> "FFI").
 */
export function normalizeInvoiceNumber(invoiceNumber: string): string | null {
  const norm = invoiceNumber
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^0+/, "");
  return norm.length > MAX_NORM_INVOICE_NO ? null : norm;
}
