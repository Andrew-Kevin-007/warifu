// Test-only helpers. `k11Reading` is an INDEPENDENT reading of docs/04 K-11 (not the kernel's code, which does
// not exist yet): it exists to check the labels in the injection library, and to prove honest documents are
// not flagged. It is deliberately simple.
import { inspectUntrusted, normalizeUntrusted } from "@symbolon/schemas";

const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "ѕ": "s",
  "А": "a", "Е": "e", "О": "o", "Р": "p", "С": "c", "Т": "t", "Х": "x", "І": "i",
  "ο": "o", "α": "a", "ε": "e",
};

const PATTERNS: RegExp[] = [
  /new wallet/,
  /updated (payment|wallet|bank) details/,
  /change of (bank|wallet|address)/,
  /please (use|send to) the following (address|wallet)/,
  /ignore (all|any|previous|above)/,
  /system:/,
  /assistant:/,
  /you are (now )?an? /,
  /do not verify/,
  /skip (the )?(check|verification)/,
  /approve (this|the) (payment|invoice)/,
  /pay (immediately|now)/,
];

export interface K11Reading {
  readonly patternHit: boolean;
  readonly structureHit: boolean;
  readonly foreignAddressHit: boolean;
  readonly matched: string[];
}

export function k11Reading(text: string, payee: string): K11Reading {
  const { normalized, removedCount } = normalizeUntrusted(text);
  const folded = Array.from(inspectUntrusted(normalized).normalize("NFKC"))
    .map((ch) => HOMOGLYPHS[ch] ?? ch)
    .join("")
    .toLowerCase();
  const matched = PATTERNS.filter((p) => p.test(folded)).map((p) => p.source);
  const base64Run = /[A-Za-z0-9+/]{200,}={0,2}/.test(text);
  const structureHit = removedCount > 5 || base64Run;
  const addresses = (text.match(/\b0x[0-9a-fA-F]{40}\b/g) ?? []).filter((a) => a.toLowerCase() !== payee.toLowerCase());
  return { patternHit: matched.length > 0, structureHit, foreignAddressHit: addresses.length > 0, matched };
}

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}
