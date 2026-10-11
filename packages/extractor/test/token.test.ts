// token.ts regressions: (1) case-fold index misalignment, (2) boundary characters the check did not see.
// Each has a negative control that re-implements the OLD behaviour and shows the attack input got through.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { asciiLower, currenciesNextTo, occursAsCurrency, occursAsToken, tokenOccurrences } from "../src/token";

// --- the pre-fix implementation, kept only as a negative control -----------------------------------------------
function oldOccurrences(text: string, value: string, ci: boolean): number[] {
  const TOKEN = /^[\p{L}\p{N}_\-/]$/u;
  const hay = ci ? text.toLowerCase() : text;
  const needle = ci ? value.toLowerCase() : value;
  const out: number[] = [];
  for (let from = 0; ; ) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    const before = text.charAt(i - 1);
    const after = text.charAt(i + needle.length);
    if ((i === 0 || !TOKEN.test(before)) && (after === "" || !TOKEN.test(after))) out.push(i);
    from = i + 1;
  }
  return out;
}

describe("1. case folding is ASCII-only and length-preserving", () => {
  it("asciiLower never changes length and leaves non-ASCII alone", () => {
    for (const s of ["İ", "K", "ACME", "ÄÖ", "straSSe"]) expect(asciiLower(s).length).toBe(s.length);
    expect(asciiLower("İ")).toBe("İ");
    expect(asciiLower("K")).toBe("K"); // Kelvin sign does NOT fold to "k"
    expect(asciiLower("AbC")).toBe("abc");
  });

  it("the dotted-I prefix attack: 'ACME CO' must not be accepted as a whole token inside 'ACME COMPANY LTD'", () => {
    const text = "İİİİİ ACME COMPANY LTD";
    expect(tokenOccurrences(text, "ACME CO", { asciiCaseInsensitive: true })).toEqual([]);
    expect(tokenOccurrences(text, "ACME COMPANY LTD", { asciiCaseInsensitive: true })).toEqual([6]);
    // NEGATIVE CONTROL: the old toLowerCase-based search shifts indexes and accepts the fragment
    expect(oldOccurrences(text, "ACME CO", true).length).toBeGreaterThan(0);
  });

  it("the Kelvin sign does not fold to k", () => {
    expect(tokenOccurrences("K-1", "k-1", { asciiCaseInsensitive: true })).toEqual([]);
  });

  it("property: every returned index really holds the value (ASCII-folded in ci mode)", () => {
    const alphabet = ["a", "B", "k", "K", "İ", "K", "1", "0", " ", "-", ".", ",", "​", "́", "😀", "x"];
    const str = (max: number) => fc.array(fc.constantFrom(...alphabet), { maxLength: max }).map((a) => a.join(""));
    fc.assert(
      fc.property(str(24), str(5), fc.boolean(), (text, value, ci) => {
        for (const i of tokenOccurrences(text, value, { asciiCaseInsensitive: ci })) {
          const slice = text.slice(i, i + value.length);
          expect(ci ? asciiLower(slice) : slice).toBe(ci ? asciiLower(value) : value);
        }
      }),
      { numRuns: 1000 },
    );
  });
});

describe("2. boundary characters the check must see", () => {
  it("combining marks and format/zero-width characters continue a token", () => {
    expect(occursAsToken("INV-1́ x", "INV-1")).toBe(false); // combining acute
    for (const cf of ["​", "‌", "‍", "⁠", "­", "﻿"]) {
      expect(occursAsToken(`INV-1${cf}001`, "INV-1"), `U+${cf.charCodeAt(0).toString(16)}`).toBe(false);
      expect(occursAsToken(`${cf}INV-1 `, "INV-1"), `before U+${cf.charCodeAt(0).toString(16)}`).toBe(false);
    }
    // NEGATIVE CONTROL: the old check treated them as boundaries
    expect(oldOccurrences("INV-1​001", "INV-1", false).length).toBe(1);
    expect(oldOccurrences("INV-1́ x", "INV-1", false).length).toBe(1);
  });

  it("unicode minus and dashes before or after an amount continue the token", () => {
    for (const dash of ["−", "‐", "‑", "‒", "–", "—", "―", "-"]) {
      expect(occursAsToken(`Total ${dash}1,000.00 USDC`, "1,000.00"), `U+${dash.charCodeAt(0).toString(16)}`).toBe(false);
    }
    expect(oldOccurrences("Total −1,000.00 USDC", "1,000.00", false).length).toBe(1);
    expect(occursAsToken("Total 1,000.00 USDC", "1,000.00")).toBe(true);
  });

  it("an amount in accounting brackets is a negative amount, not a plain one", () => {
    expect(occursAsToken("Total (1,000.00)", "1,000.00")).toBe(false);
    expect(occursAsToken("Total (see 1,000.00)", "1,000.00")).toBe(true); // bracket does not directly wrap the value
    expect(occursAsToken("Invoice (INV-1001)", "INV-1001")).toBe(true); // non-numeric ids are unaffected
    expect(oldOccurrences("Total (1,000.00)", "1,000.00", false).length).toBe(1);
  });

  it("digit-group joiners (apostrophes, NBSP, thin and narrow spaces) between digits continue a number", () => {
    for (const j of ["'", "’", " ", " ", " "]) {
      expect(occursAsToken(`x 1${j}1,000.00`, "1,000.00"), `before U+${j.charCodeAt(0).toString(16)}`).toBe(false);
      expect(occursAsToken(`1,000.00${j}500 x`, "1,000.00"), `after U+${j.charCodeAt(0).toString(16)}`).toBe(false);
    }
    expect(occursAsToken("Total: 1,000.00 USDC", "1,000.00")).toBe(true); // a plain space is a normal boundary
    expect(oldOccurrences("x 1 1,000.00", "1,000.00", false).length).toBe(1);
  });

  it("ill-formed UTF-16 yields no match", () => {
    expect(tokenOccurrences("abc \ud800 def", "def")).toEqual([]);
    expect(tokenOccurrences("abc def", "d\udc00")).toEqual([]);
    expect(tokenOccurrences("abc def", "")).toEqual([]);
  });

  it("astral characters before or after are handled as whole characters", () => {
    expect(occursAsToken("😀INV-1", "INV-1")).toBe(true); // emoji is not a token character
    expect(occursAsToken("𝐀INV-1", "INV-1")).toBe(false); // mathematical bold A is a letter
  });
});

describe("currenciesNextTo checks boundaries on the full text", () => {
  it("a letter before the slice start still blocks the match (old code looked at a 12-char slice only)", () => {
    const filler = "a".repeat(12);
    // 'USDC' preceded by exactly 12 chars of context would sit at the start of the old slice
    const text = `Q${"X".repeat(8)}ZUSD 1,000.00`;
    expect([...currenciesNextTo(text, "1,000.00")]).toEqual([]); // "ZUSD" is a word, not the token USD
    expect([...currenciesNextTo(`${filler} USD 1,000.00`, "1,000.00")]).toEqual(["USD"]);
    expect([...currenciesNextTo("Total 1,000.00 USDC.", "1,000.00")]).toEqual(["USDC"]);
    expect([...currenciesNextTo("ZZZZZZZZZZZZZUSDC 1,000.00", "1,000.00")]).toEqual([]);
    // NEGATIVE CONTROL: a lookbehind evaluated on a slice that starts at the token passes although the real text has a letter before it
    const cutBefore = (slice: string) => /(?<![\p{L}\p{N}_])USDC[ ]{0,3}$/u.test(slice);
    const full = "ZUSDC 1,000.00";
    expect(cutBefore(full.slice(1, full.indexOf("1,000.00")))).toBe(true); // what a truncated-slice check sees
    expect([...currenciesNextTo(full, "1,000.00")]).toEqual([]); // the full-text boundary check refuses
  });

  it("symbol currencies are accepted glued to digits only on the left boundary", () => {
    expect(occursAsCurrency("Total $1,000.00", "$")).toBe(true);
    expect(occursAsCurrency("Total US$1,000.00", "US$")).toBe(true);
    expect(occursAsCurrency("Total US$1,000.00", "$")).toBe(false); // "$" is the tail of "US$"
    expect(occursAsCurrency("Total 1,000.00 USDC", "USD")).toBe(false);
  });
});
