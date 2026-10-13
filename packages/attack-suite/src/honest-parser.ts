// Extractor-side check on the honest corpus (WP-24, AGENT lane): the deterministic readers of packages/extractor
// (parse/amount.ts, parse/terms.ts) are the product's zero-LLM path (docs/QUESTIONS: zero paid calls by default), so
// they must read honest invoices correctly. For every honest document this compares
//   - the amount parser's reading of the printed total with the fixture's reference reading, and
//   - the terms reader's reading of the document with the terms the fixture states.
// The unforgivable class (docs/03 §8) is WRONG: a confident amount that differs from the truth. A refusal on an
// honest document costs a human review, not money, and is counted separately. No model is involved; no clock.
import { parseAmountPrinted, parseStatedTerms } from "@symbolon/extractor";
import { inspectUntrusted, normalizeUntrusted } from "@symbolon/schemas";
import type { HonestFixture } from "./types";

export const PARSER_CHECK_VERSION = "honest-parser/1" as const;

export const AMOUNT_OUTCOMES = ["EXACT", "AMBIGUOUS_AGREED", "WRONG", "PARSED_WHERE_REFERENCE_REFUSES", "REFUSED_HONEST"] as const;
export type AmountOutcome = (typeof AMOUNT_OUTCOMES)[number];

export const TERMS_OUTCOMES = ["EXACT", "NONE_AGREED", "MISSED", "INVENTED", "WRONG_VALUES", "FLAGGED_AMBIGUOUS"] as const;
export type TermsOutcome = (typeof TERMS_OUTCOMES)[number];

export interface ParserItem {
  readonly id: string;
  readonly amount: AmountOutcome;
  readonly terms: TermsOutcome;
}

export interface ParserSummary {
  readonly version: typeof PARSER_CHECK_VERSION;
  readonly n: number;
  readonly amount: Readonly<Record<AmountOutcome, number>>;
  readonly terms: Readonly<Record<TermsOutcome, number>>;
  /** Items where a reader's output is not what the fixture says (the lists are empty when everything agrees). */
  readonly disagreements: readonly { readonly id: string; readonly field: "amount" | "terms"; readonly outcome: string }[];
  readonly items: readonly ParserItem[];
}

export function checkParsers(fixtures: readonly HonestFixture[]): ParserSummary {
  const items: ParserItem[] = [];
  const disagreements: { id: string; field: "amount" | "terms"; outcome: string }[] = [];
  for (const h of fixtures) {
    const ref = h.step.runs[0]?.a;
    if (ref === undefined) throw new RangeError(`${h.id}: no reference reading`);

    // amount: the printed total as the reference extraction recorded it
    const printed = inspectUntrusted(ref.amount.printed);
    const p = parseAmountPrinted(printed, 6);
    const expected = ref.amount.parsedBaseUnits; // null where the reference reader refuses (ambiguous print)
    let amount: AmountOutcome;
    if (p.kind === "ok") amount = expected === null ? "PARSED_WHERE_REFERENCE_REFUSES" : p.baseUnits.toString() === expected ? "EXACT" : "WRONG";
    else if (p.kind === "ambiguous") amount = expected === null ? "AMBIGUOUS_AGREED" : "REFUSED_HONEST";
    else amount = "REFUSED_HONEST";

    // terms: what the document states vs what the fixture says it states
    const text = inspectUntrusted(normalizeUntrusted(h.step.doc.text).normalized);
    const t = parseStatedTerms(text);
    const s = ref.statedTerms;
    const statesNothing = s.raw === null && s.netDays === null && s.earlyPay === null;
    let terms: TermsOutcome;
    if (statesNothing) terms = t.found ? "INVENTED" : "NONE_AGREED";
    else if (!t.found) terms = "MISSED";
    else if (t.ambiguous) terms = "FLAGGED_AMBIGUOUS";
    else {
      const sameEarly = (t.earlyPay === null && s.earlyPay === null) || (t.earlyPay !== null && s.earlyPay !== null && t.earlyPay.discountBps === s.earlyPay.discountBps && t.earlyPay.withinDays === s.earlyPay.withinDays);
      terms = t.netDays === s.netDays && sameEarly ? "EXACT" : "WRONG_VALUES";
    }
    if (amount !== "EXACT" && amount !== "AMBIGUOUS_AGREED") disagreements.push({ id: h.id, field: "amount", outcome: amount });
    if (terms !== "EXACT" && terms !== "NONE_AGREED") disagreements.push({ id: h.id, field: "terms", outcome: terms });
    items.push({ id: h.id, amount, terms });
  }
  const tally = <K extends string>(keys: readonly K[], pick: (i: ParserItem) => K): Record<K, number> =>
    Object.fromEntries(keys.map((k) => [k, items.filter((i) => pick(i) === k).length])) as Record<K, number>;
  return {
    version: PARSER_CHECK_VERSION,
    n: items.length,
    amount: tally(AMOUNT_OUTCOMES, (i) => i.amount),
    terms: tally(TERMS_OUTCOMES, (i) => i.terms),
    disagreements,
    items,
  };
}
