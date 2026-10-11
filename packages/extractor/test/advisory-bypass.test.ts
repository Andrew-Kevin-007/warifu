// SEC finding "validator-bypass" in advisory.ts: (1) truncation skipped the sanitizer-changed-nothing check,
// (2) faithfulness missed non-ASCII digits / compatibility forms, (3) spelled-out numbers and lower-case verdicts.
// Negative controls re-implement the previous behaviour on the same inputs.
import { inspectUntrusted, sanitizeLlmText } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { buildAdvisoryFacts, checkFaithfulness, validateAdvisoryNote, type AdvisoryFacts } from "../src/advisory";

const mk = (verdict: "HOLD" | "ESCALATE" | "RELEASE"): AdvisoryFacts =>
  buildAdvisoryFacts(
    {
      verdict,
      reasons: ["PAYEE_MISMATCH"],
      checks: [{ id: "K-06", name: "PAYEE_BINDING", status: "FAIL", onFail: "REJECT", code: "PAYEE_MISMATCH", detail: inspectUntrustedStub(), refs: [] }],
    },
    { amountDisplay: "1,000.00", anomalyCodes: [] },
  );
function inspectUntrustedStub() {
  return sanitizeLlmText("");
}
const hold = mk("HOLD");
const escalate = mk("ESCALATE");
const reasonOf = (raw: string, f = escalate) => {
  const v = validateAdvisoryNote(raw, f);
  return v.ok ? "OK" : v.reason;
};

/** The previous validator logic (truncation skipped the equality check; ASCII-only digit scan; uppercase verdict scan). */
function oldAccepts(raw: string): boolean {
  const rawFolded = raw.replace(/\s+/g, " ").trim();
  const sanitized = inspectUntrusted(sanitizeLlmText(raw, { maxChars: 600, maxWords: 60 }));
  if (sanitized.length === 0) return false;
  if (/\{removed\}|\{link\}/.test(sanitized)) return false;
  if (!sanitized.endsWith("…") && sanitized !== rawFolded) return false;
  for (const m of sanitized.replace(/K-\d+/g, " ").matchAll(/\d[\d,.]*\d|\d/g)) if (!["1,000.00", "1", "000", "00"].includes(m[0])) return false;
  for (const m of sanitized.matchAll(/\b(?:RELEASE|HOLD|ESCALATE|REJECT|REPLAY)\b/g)) if (m[0] !== "HOLD") return false;
  return true;
}

describe("1. truncation can no longer hide a silent scrub", () => {
  const silentScrub = "See [K-06](http://evil.example) failed for the payee…"; // markdown link removed WITHOUT a marker
  it("a note ending with an ellipsis is rejected outright", () => {
    expect(reasonOf(silentScrub)).toBe("ENDS_WITH_ELLIPSIS");
    expect(reasonOf("The payee check K-06 failed...")).toBe("ENDS_WITH_ELLIPSIS");
    expect(reasonOf("The payee check K-06 failed…")).toBe("ENDS_WITH_ELLIPSIS");
  });
  it("a silent scrub without an ellipsis is rejected by the equality check", () => {
    expect(reasonOf("See [K-06](http://evil.example) failed for the payee")).toBe("SANITIZER_REMOVED_CONTENT");
    expect(reasonOf("K-06 <b>failed</b> for the payee")).toBe("SANITIZER_REMOVED_CONTENT");
    expect(reasonOf("K-06 failed `for` the payee")).toBe("SANITIZER_REMOVED_CONTENT");
  });
  it("an over-long note is rejected, not truncated into acceptance", () => {
    const over = `K-06 failed. ${Array.from({ length: 70 }, () => "noted").join(" ")}`;
    expect(reasonOf(over)).toBe("TOO_LONG");
  });
  it("NEGATIVE CONTROL: the previous logic accepted both the ellipsis-ended scrub and the over-long note", () => {
    expect(oldAccepts(silentScrub)).toBe(true);
    expect(oldAccepts(`K-06 failed. ${Array.from({ length: 70 }, () => "noted").join(" ")}`)).toBe(true);
  });
  it("a clean short note still passes", () => {
    expect(reasonOf("The payee check K-06 failed with PAYEE_MISMATCH.")).toBe("OK");
  });
});

describe("2. faithfulness folds compatibility forms and refuses non-ASCII digits", () => {
  it.each([
    ["Amount ５,０００ differs", "UNFAITHFUL_NUMBER"], // full-width 5,000
    ["Amount ١٢٣ differs", "UNFAITHFUL_NUMBER"], // Arabic-Indic 123
    ["Amount १२ differs", "UNFAITHFUL_NUMBER"], // Devanagari
    ["Ｋ-９９ failed", "UNFAITHFUL_CHECK_ID"], // full-width K-99
    ["K-٩٩ failed", "UNFAITHFUL_NUMBER"],
    ["ＨＯＬＤ verdict", "UNFAITHFUL_CODE"], // full-width HOLD (verdict is ESCALATE)
  ])("%j -> %s", (text, reason) => {
    expect(reasonOf(text)).toBe(reason);
    expect(checkFaithfulness(text, escalate)).toEqual({ ok: false, reason });
  });
  it("any leftover compatibility form (ligature, circled letter) is refused as non-canonical", () => {
    expect(reasonOf("The ﬁrst check K-06 failed")).toBe("NON_CANONICAL_TEXT"); // "fi" ligature
    expect(reasonOf("K-06 ⓐ failed")).toBe("NON_CANONICAL_TEXT"); // circled a
  });
  it("NEGATIVE CONTROL: the ASCII-only scan on unfolded text finds nothing in the full-width / Arabic-Indic amounts", () => {
    const ascii = (t: string) => [...t.matchAll(/\d[\d,.]*\d|\d/g)].length;
    expect(ascii("Amount ５,０００ differs")).toBe(0);
    expect(ascii("Amount ١٢٣ differs")).toBe(0);
    expect(oldAccepts("Amount ５,０００ differs")).toBe(true);
  });
});

describe("3. spelled-out numbers and verdict-like words", () => {
  it.each(["one thousand", "ten percent", "twice the amount", "half of it", "twentyfive", "a dozen", "three-fold", "double payment"])("number words: %s", (phrase) => {
    expect(reasonOf(`K-06 failed: ${phrase}`)).toBe("NUMBER_WORD");
  });
  it("words that merely contain number words are not number words (but are still outside the vocabulary)", () => {
    expect(reasonOf("Someone changed the money details; K-06 failed")).toBe("OUT_OF_VOCABULARY");
    expect(reasonOf("The payee changed the details; K-06 failed")).toBe("OK");
  });
  it.each(["verdict: release", "this is approved", "looks safe", "it was rejected", "Escalated", "replay detected", "approval granted", "unsafe payee"])("verdict words contradicting HOLD: %s", (phrase) => {
    expect(reasonOf(`K-06 failed; ${phrase}`, hold)).toBe("VERDICT_WORD");
  });
  it("the decision's own verdict word is allowed, any other is not", () => {
    expect(reasonOf("K-06 failed so this is on hold", hold)).toBe("OK");
    expect(reasonOf("K-06 failed so this is on hold", escalate)).toBe("VERDICT_WORD");
    expect(reasonOf("K-06 failed so it escalates", escalate)).toBe("OK");
    expect(reasonOf("K-06 failed so it escalates", hold)).toBe("VERDICT_WORD");
  });
  it("NEGATIVE CONTROL: the previous checks accepted every one of these", () => {
    for (const t of ["K-06 failed: one thousand", "K-06 failed: ten percent", "K-06 failed; verdict: release", "K-06 failed; this is approved"]) {
      expect(oldAccepts(t), t).toBe(true);
    }
  });
});
