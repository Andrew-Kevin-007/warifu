// Anchored ("whole token") occurrence checks, replacing unanchored substring tests (finding "validation bypass").
//
// `text.includes(value)` accepts "INV-1" inside "INV-1001", "1,000.00" inside "11,000.00" and "USD" inside
// "USDC". A value the model claims was printed must occur in the document as a WHOLE TOKEN: whatever sits
// immediately before and after the occurrence must not continue it.
//
// What continues a token (fail closed: anything that could be part of the same visible "word" or number):
//   * letters, digits, "_", "-", "/", plus unicode minus/dashes (U+2212, U+2010..U+2015);
//   * combining marks (\p{M}) and format/zero-width characters (\p{Cf}: U+200B..U+200D, U+2060, U+00AD, U+FEFF, ...).
//     normalizeUntrusted() already strips most of these before the model sees the text; the guard is kept anyway
//     (defence in depth) so a character that survives normalization can never act as a boundary;
//   * "." and "," when they join two alphanumerics (so a sentence-final period after an invoice number is fine,
//     but "1,000.001" does not contain "1,000.00");
//   * apostrophes, NBSP, thin/narrow spaces when they join two digits (digit-group joiners in "1'000.00");
//   * for numeric values, an enclosing "(" ... ")" (accounting notation for a NEGATIVE amount).
// Case folding, when requested, is ASCII-only and length-preserving, so indexes found in the folded copy are valid
// in the original (toLowerCase() is NOT length-preserving: "İ" becomes two code units).
import { isWellFormedString } from "@symbolon/schemas";
import { KNOWN_TOKENS_LONGEST_FIRST } from "./currency";

const TOKEN_CHAR = /^[\p{L}\p{N}\p{M}\p{Cf}_\-/−‐-―]$/u;
const ALNUM = /^[\p{L}\p{N}]$/u;
const DIGIT = /^\p{N}$/u;
const DOT_COMMA = /^[.,]$/;
const DIGIT_JOINER = new RegExp("^['\u2019\u02bc\u00a0\u2009\u202f]$", "u");

/** ASCII-only lower-casing; always the same length as the input. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function lastChar(s: string): string {
  if (s.length === 0) return "";
  const lo = s.charCodeAt(s.length - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && s.length >= 2) return s.slice(-2);
  return s.slice(-1);
}

function firstChar(s: string): string {
  if (s.length === 0) return "";
  const hi = s.charCodeAt(0);
  if (hi >= 0xd800 && hi <= 0xdbff && s.length >= 2) return s.slice(0, 2);
  return s.slice(0, 1);
}

function beforeContinues(text: string, index: number, valueStartsWithDigit: boolean): boolean {
  const before = text.slice(Math.max(0, index - 4), index);
  const c = lastChar(before);
  if (c === "") return false;
  if (TOKEN_CHAR.test(c)) return true;
  const prev = lastChar(before.slice(0, before.length - c.length));
  if (DOT_COMMA.test(c)) return prev !== "" && ALNUM.test(prev);
  if (DIGIT_JOINER.test(c)) return valueStartsWithDigit && prev !== "" && DIGIT.test(prev);
  return false;
}

function afterContinues(text: string, end: number, valueEndsWithDigit: boolean): boolean {
  const after = text.slice(end, end + 4);
  const c = firstChar(after);
  if (c === "") return false;
  if (TOKEN_CHAR.test(c)) return true;
  const next = firstChar(after.slice(c.length));
  if (DOT_COMMA.test(c)) return next !== "" && ALNUM.test(next);
  if (DIGIT_JOINER.test(c)) return valueEndsWithDigit && next !== "" && DIGIT.test(next);
  return false;
}

export interface TokenOptions {
  /** ASCII-only case folding (hex addresses). Default false: exact, case-sensitive. */
  readonly asciiCaseInsensitive?: boolean;
  /** The value ends in a symbol that may touch a digit ("$", "US$"): do not apply the right-hand boundary. */
  readonly rightOpen?: boolean;
}

/** Start indices (in `text`) at which `value` occurs as a whole token. Ill-formed UTF-16 yields no match. */
export function tokenOccurrences(text: string, value: string, options: TokenOptions = {}): number[] {
  if (value.length === 0) return [];
  if (!isWellFormedString(text) || !isWellFormedString(value)) return [];
  const ci = options.asciiCaseInsensitive === true;
  const hay = ci ? asciiLower(text) : text;
  const needle = ci ? asciiLower(value) : value;
  if (hay.length !== text.length || needle.length !== value.length) return []; // invariant of asciiLower; fail closed
  const numeric = /^\p{N}/u.test(value) && /\p{N}$/u.test(value);
  const startsDigit = /^\p{N}/u.test(value);
  const endsDigit = /\p{N}$/u.test(value);
  const out: number[] = [];
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const end = i + needle.length;
    let ok = !beforeContinues(text, i, startsDigit);
    if (ok && options.rightOpen !== true) ok = !afterContinues(text, end, endsDigit);
    // "(1,000.00)": accounting negative; a numeric value wrapped in brackets is not a plain positive amount.
    if (ok && numeric && text.charAt(i - 1) === "(" && text.charAt(end) === ")") ok = false;
    if (ok) out.push(i);
    from = i + 1;
  }
  return out;
}

export function occursAsToken(text: string, value: string, options: TokenOptions | boolean = {}): boolean {
  const o: TokenOptions = typeof options === "boolean" ? { asciiCaseInsensitive: options } : options;
  return tokenOccurrences(text, value, o).length > 0;
}

/** A currency token may be glued to the digits that follow it ("$1,000", "US$5"): only the left boundary applies then. */
export function occursAsCurrency(text: string, currency: string): boolean {
  const last = lastChar(currency);
  return occursAsToken(text, currency, { rightOpen: last !== "" && !ALNUM.test(last) });
}

const LETTER_OR_DIGIT = /^[\p{L}\p{N}_\p{M}\p{Cf}]$/u;
const isSpace = (c: string) => c === " " || c === " " || c === " ";

/**
 * Known currency tokens printed immediately next to (before or after, at most 3 spaces away) a whole-token
 * occurrence of `printed`. Exact, case-sensitive; "USD" is never reported for "USDC". Boundaries are checked on
 * the FULL text, never on a truncated slice.
 */
export function currenciesNextTo(text: string, printed: string): Set<string> {
  const found = new Set<string>();
  for (const i of tokenOccurrences(text, printed)) {
    // after: skip up to 3 spaces, then a token that is not continued by a letter/digit
    let k = i + printed.length;
    for (let n = 0; n < 3 && k < text.length && isSpace(text.charAt(k)); n++) k++;
    for (const t of KNOWN_TOKENS_LONGEST_FIRST) {
      if (!text.startsWith(t, k)) continue;
      const nextCh = firstChar(text.slice(k + t.length, k + t.length + 2));
      if (nextCh === "" || !LETTER_OR_DIGIT.test(nextCh)) found.add(t);
    }
    // before: skip up to 3 spaces backwards, then a token not preceded by a letter/digit
    let j = i;
    for (let n = 0; n < 3 && j > 0 && isSpace(text.charAt(j - 1)); n++) j--;
    for (const t of KNOWN_TOKENS_LONGEST_FIRST) {
      if (j - t.length < 0 || text.slice(j - t.length, j) !== t) continue;
      const prevCh = lastChar(text.slice(Math.max(0, j - t.length - 2), j - t.length));
      if (prevCh === "" || !LETTER_OR_DIGIT.test(prevCh)) found.add(t);
    }
  }
  return found;
}
