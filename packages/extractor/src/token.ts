// Anchored ("whole token") occurrence checks, replacing unanchored substring tests (finding "validation bypass").
//
// `text.includes(value)` accepts "INV-1" inside "INV-1001", "1,000.00" inside "11,000.00" and "USD" inside
// "USDC". A value the model claims was printed must occur in the document as a WHOLE token: the characters
// immediately before and after the occurrence must not continue it. Token characters are letters, digits, "_",
// "-" and "/"; a "." or "," continues a token only when it joins two alphanumerics (so a sentence-final period
// after an invoice number is fine, but "1,000.001" does not contain "1,000.00").
import { KNOWN_TOKENS_LONGEST_FIRST } from "./currency";

const TOKEN_CHAR = /^[\p{L}\p{N}_\-/]$/u;
const ALNUM = /^[\p{L}\p{N}]$/u;
const JOINER = /^[.,]$/;

function lastChar(s: string): string {
  const cps = Array.from(s.slice(-2));
  return cps.length === 0 ? "" : (cps[cps.length - 1] ?? "");
}

function firstChar(s: string): string {
  return Array.from(s.slice(0, 2))[0] ?? "";
}

function beforeContinues(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 4), index);
  const c = lastChar(before);
  if (c === "") return false;
  if (TOKEN_CHAR.test(c)) return true;
  if (JOINER.test(c)) {
    const cc = lastChar(before.slice(0, before.length - c.length));
    return cc !== "" && ALNUM.test(cc);
  }
  return false;
}

function afterContinues(text: string, end: number): boolean {
  const after = text.slice(end, end + 4);
  const c = firstChar(after);
  if (c === "") return false;
  if (TOKEN_CHAR.test(c)) return true;
  if (JOINER.test(c)) {
    const nn = firstChar(after.slice(c.length));
    return nn !== "" && ALNUM.test(nn);
  }
  return false;
}

/** Start indices at which `value` occurs in `text` as a whole token. ASCII case-insensitive only when asked. */
export function tokenOccurrences(text: string, value: string, asciiCaseInsensitive = false): number[] {
  if (value.length === 0) return [];
  const ci = asciiCaseInsensitive && /^[\x00-\x7f]*$/.test(value);
  const hay = ci ? text.toLowerCase() : text;
  const needle = ci ? value.toLowerCase() : value;
  const out: number[] = [];
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    if (!beforeContinues(text, i) && !afterContinues(text, i + needle.length)) out.push(i);
    from = i + 1;
  }
  return out;
}

export function occursAsToken(text: string, value: string, asciiCaseInsensitive = false): boolean {
  return tokenOccurrences(text, value, asciiCaseInsensitive).length > 0;
}

const SPACES = "[ \\u00a0\\u2009]{0,3}";
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Known currency tokens printed immediately next to (before or after) a whole-token occurrence of `printed`.
 * Exact, case-sensitive; "USD" is never reported for "USDC".
 */
export function currenciesNextTo(text: string, printed: string): Set<string> {
  const found = new Set<string>();
  for (const i of tokenOccurrences(text, printed)) {
    const after = text.slice(i + printed.length, i + printed.length + 12);
    const before = text.slice(Math.max(0, i - 12), i);
    for (const t of KNOWN_TOKENS_LONGEST_FIRST) {
      const e = escapeRe(t);
      if (new RegExp(`^${SPACES}${e}(?![\\p{L}\\p{N}_])`, "u").test(after)) found.add(t);
      if (new RegExp(`(?<![\\p{L}\\p{N}_])${e}${SPACES}$`, "u").test(before)) found.add(t);
    }
  }
  return found;
}
