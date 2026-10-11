// SEC review of 07588b9: denylists cannot win, so the advisory validator is an ALLOWLIST over ONE tokenizer.
// Every numeric/word/code/check-id decision is made on the same tokens. Negative controls re-implement the
// previous denylist + split-regex logic and show it accepts inputs the allowlist rejects.
import { untrusted } from "@symbolon/schemas";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildAdvisoryFacts, checkFaithfulness, tokenizeNote, validateAdvisoryNote, type AdvisoryFacts } from "../src/advisory";
import { ADVISORY_VOCABULARY, VERDICT_FORMS } from "../src/advisory-vocab";

const facts: AdvisoryFacts = buildAdvisoryFacts(
  {
    verdict: "HOLD",
    reasons: ["PAYEE_MISMATCH", "AMOUNT_AMBIGUOUS"],
    checks: [
      { id: "K-06", name: "PAYEE_BINDING", status: "FAIL", onFail: "REJECT", code: "PAYEE_MISMATCH", detail: untrusted(""), refs: [] },
      { id: "K-02", name: "PRECISION_EXACT", status: "FAIL", onFail: "ESCALATE", code: "AMOUNT_AMBIGUOUS", detail: untrusted(""), refs: [] },
    ],
  },
  { amountDisplay: "1,000.00", anomalyCodes: [] },
);
const verdictOf = (text: string, f = facts) => {
  const r = checkFaithfulness(text, f);
  return r.ok ? "OK" : r.reason;
};
const noteVerdict = (text: string) => {
  const r = validateAdvisoryNote(text, facts);
  return r.ok ? "OK" : r.reason;
};

/** The previous approach: a small denylist of number/verdict words plus separate regex scans for numbers. */
function denylistAccepts(text: string): boolean {
  const deny = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|fifty|hundred|thousand|million|percent|half|double|twice|dozen|safe|unsafe|approve[ds]?|approval|release[ds]?|reject(?:ed)?|escalat\w*|replay)$/;
  for (const run of text.toLowerCase().split(/[^a-z]+/)) if (run.length > 0 && deny.test(run)) return false;
  const allowedParts = new Set(["1,000.00", "1", "000", "00", "06", "02"]);
  for (const m of text.matchAll(/\d[\d,.]*\d|\d/g)) if (!allowedParts.has(m[0])) return false;
  return true;
}

describe("a clean note built only from vocabulary and facts passes", () => {
  it("passes through the full validator", () => {
    expect(noteVerdict("The payee check failed and K-06 shows PAYEE_MISMATCH while the amount 1,000.00 was ambiguous; the decision is on hold.")).toBe("OK");
    expect(noteVerdict("K-02 flagged AMOUNT_AMBIGUOUS, so this requires a human review of the amount 1,000.00.")).toBe("OK");
  });
  it("every vocabulary word is usable on its own (the vocabulary never collides with the number/verdict checks)", () => {
    for (const w of ADVISORY_VOCABULARY) expect(verdictOf(`the ${w}`), w).toBe("OK");
  });
  it("each decision's own verdict forms pass for that verdict only", () => {
    for (const [verdict, forms] of Object.entries(VERDICT_FORMS)) {
      for (const form of forms) {
        const f = { ...facts, verdict: verdict as AdvisoryFacts["verdict"] };
        expect(verdictOf(`it was ${form}`, f), `${verdict}:${form}`).toBe("OK");
        const other = { ...facts, verdict: (verdict === "HOLD" ? "REJECT" : "HOLD") as AdvisoryFacts["verdict"] };
        expect(verdictOf(`it was ${form}`, other), `${verdict}:${form} under another verdict`).not.toBe("OK");
      }
    }
  });
  it("words of the decision's own codes are allowed (payee, mismatch), words of other codes are not", () => {
    expect(verdictOf("a payee mismatch")).toBe("OK");
    expect(verdictOf("a screen hit")).toBe("OUT_OF_VOCABULARY"); // "screen" belongs to SCREEN_HIT, not to this decision
  });
});

describe("words outside the closed vocabulary are rejected", () => {
  it.each([
    ["one thousand", "NUMBER_WORD"],
    ["eleven", "NUMBER_WORD"],
    ["a dozen", "NUMBER_WORD"],
    ["fifty-fifty", "NUMBER_WORD"],
    ["safe to release", "VERDICT_WORD"],
    ["approve it", "VERDICT_WORD"],
    ["twice", "NUMBER_WORD"],
  ])("%j -> %s", (text, reason) => {
    expect(verdictOf(`K-06 failed ${text}`)).toBe(reason);
  });

  it("homoglyph words (Cyrillic look-alikes) are out of vocabulary", () => {
    for (const w of ["ѕafe", "аpprove", "pаyee", "chеck", "сheck"]) expect(verdictOf(`the ${w}`), w).toBe("OUT_OF_VOCABULARY");
  });

  it("NEGATIVE CONTROL: the denylist approach accepts words nobody listed; the allowlist rejects them", () => {
    for (const w of ["umpteen", "gazillion", "tenfold", "fiftyish", "eleventy", "ѕafe", "аpprove"]) {
      expect(denylistAccepts(`K-06 failed ${w}`), `denylist accepts ${w}`).toBe(true);
      expect(verdictOf(`K-06 failed ${w}`), `allowlist rejects ${w}`).not.toBe("OK");
    }
  });

  it("PROPERTY: any random lower-case word outside the vocabulary and the decision's own words is always rejected", () => {
    const own = new Set<string>([...VERDICT_FORMS.HOLD, "payee", "mismatch", "amount", "ambiguous"]);
    const word = fc.string({ unit: fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz"), minLength: 2, maxLength: 12 });
    fc.assert(
      fc.property(word.filter((w) => !ADVISORY_VOCABULARY.has(w) && !own.has(w)), (w) => {
        expect(verdictOf(`the payee ${w}`), w).not.toBe("OK");
      }),
      { numRuns: 1000 },
    );
  });

  it("PROPERTY: a random word with a Unicode look-alike letter is always rejected", () => {
    const lookalike = fc.constantFrom("а", "е", "о", "р", "с", "х", "у", "і");
    fc.assert(
      fc.property(fc.constantFrom(...ADVISORY_VOCABULARY), lookalike, (w, ch) => {
        const mutated = ch + w.slice(1);
        fc.pre(mutated !== w);
        expect(verdictOf(`the ${mutated}`)).toBe("OUT_OF_VOCABULARY");
      }),
      { numRuns: 500 },
    );
  });
});

describe("one tokenizer: numbers are judged as whole tokens", () => {
  it("tokenizeNote keeps glued and separated forms as single tokens", () => {
    expect(tokenizeNote("K-06x 5k 1.000,00 1_000 -5 50%. done; (ok)")).toEqual(["K-06x", "5k", "1.000,00", "1_000", "-5", "50%", "done", "ok"]);
  });

  it.each(["5k", "2x", "x2", "10th", "1.000,00", "1_000", "-5", "+5", "5%", "01,000.00", "1000.00", "1,000.0", "1,000.00x", "$1,000.00", "1,000.000", "K-6", "XK-06", "K-06x", "k-06", "5", "0"])(
    "rejects the numeric-looking token %j",
    (tok) => {
      expect(verdictOf(`the amount ${tok}`), tok).not.toBe("OK");
    },
  );

  it("rejects a space- or apostrophe-separated amount, whose parts are separate tokens", () => {
    expect(verdictOf("the amount 1 000.00")).toBe("UNFAITHFUL_NUMBER");
    expect(verdictOf("the amount 1'000.00")).toBe("UNFAITHFUL_NUMBER");
  });

  it("rejects roman numerals and multiplier words (not in the vocabulary)", () => {
    for (const w of ["iv", "xii", "x", "mmxxvi", "fold", "multiplied"]) expect(verdictOf(`the ${w}`), w).toBe("OUT_OF_VOCABULARY");
    expect(verdictOf("the 2x")).toBe("UNFAITHFUL_NUMBER");
  });

  it("accepts exactly the decision's amount and check ids, with sentence punctuation around them", () => {
    expect(verdictOf("the amount 1,000.00.")).toBe("OK");
    expect(verdictOf("(K-06)")).toBe("OK");
    expect(verdictOf("K-02, K-06")).toBe("OK");
    const noAmount = { ...facts, amountDisplay: null };
    expect(verdictOf("the amount 1,000.00", noAmount)).toBe("UNFAITHFUL_NUMBER");
  });

  it("PROPERTY: any numeric token that is not the amount (or a check id) is always rejected", () => {
    const numeric = fc.string({ unit: fc.constantFrom(..."0123456789.,_%+-xk"), minLength: 1, maxLength: 9 });
    fc.assert(
      fc.property(
        numeric.filter((s) => /[0-9]/.test(s) && s.replace(/^[.,]+|[.,]+$/g, "") !== "1,000.00"),
        (tok) => {
          expect(verdictOf(`the amount ${tok}`), tok).not.toBe("OK");
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("NEGATIVE CONTROL: the previous split-regex number scan accepts glued and re-separated forms", () => {
    for (const t of ["the amount 1k", "the amount 1x", "the amount 1_000", "the amount 1 000", "K-06x"]) {
      expect(denylistAccepts(t), `old scan accepts ${t}`).toBe(true);
      expect(verdictOf(t), `new tokenizer rejects ${t}`).not.toBe("OK");
    }
  });
});
