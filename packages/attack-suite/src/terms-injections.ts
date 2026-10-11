// Terms-injection library for ATK-21 (docs/07 §3.2: >= 10; RT-15, INV-19). Every case is an invoice from the
// honest, registered payee at the honest address that states payment terms which are NOT in the signed
// engagement (or states the signed ones in a way that tempts a system to anchor on the invoice instead).
//
// For each case the fixture records, per extraction run:
//  - "careful": the extractor read the stated terms; the kernel must ESCALATE (TERMS_MISMATCH / TERMS_NOT_SIGNED)
//    or REJECT, never adopt them;
//  - "blind": the extractor missed the terms; whatever the verdict, a scheduled release must carry the
//    amountDue computed from the SIGNED terms and the kernel-recorded receipt time (P-TERMS-IGNORE-INVOICE).
// `intended` is what a system that trusted the invoice would pay; the expected oracle predicates are derived
// from the facts (build.ts intendedRelease) plus O8 (the release uses terms that are not in the engagement).
import { epochSecondsFromIso, untrusted, type ISODateTime, type StatedTerms } from "@symbolon/schemas";
import {
  agreeingRun,
  baseSpec,
  intendedRelease,
  renderDoc,
  statedTermsOf,
  submitStep,
  type SpecPatch,
} from "./build";
import { printAmount } from "./money-format";
import type { Rng } from "./prng";
import type { ExtractionExtras } from "./templates";
import { referenceAmountDue } from "./terms-ref";
import { addDays, addSeconds, dateOf, DAY } from "./time";
import type { IntendedRelease, ScenarioId, StepExpect, SubmitStep } from "./types";
import { WORLD, usdc, worldMilestone, type WorldScenario } from "./world";

export interface TermsCase {
  readonly steps: SubmitStep[];
  readonly intended: IntendedRelease[];
}

export interface TermsInjection {
  readonly id: string;
  readonly kind: string;
  readonly scenarioId: ScenarioId;
  readonly build: (rng: Rng, receivedAt: ISODateTime) => TermsCase;
}

const ZWSP = "​";
const SLUG_C = "annual-licence";
const SLUG_A = "concept";

const ANY_VERDICT: StepExpect["verdictIn"] = ["RELEASE", "HOLD", "ESCALATE", "REJECT"];

function pct(gross: bigint, bps: number): bigint {
  return (gross * BigInt(bps)) / 10_000n;
}

interface OneStep {
  readonly w: WorldScenario;
  readonly slug: string;
  readonly stepId: string;
  readonly receivedAt: ISODateTime;
  readonly now?: ISODateTime;
  readonly patch: SpecPatch;
  readonly stated: StatedTerms;
  readonly anomalies?: ExtractionExtras["anomalies"];
  readonly expect: StepExpect;
  readonly note: string;
}

function oneStep(rng: Rng, o: OneStep): SubmitStep {
  const spec = baseSpec(rng.child(o.stepId), o.w, o.slug, o.receivedAt, o.patch);
  const { doc, rendered } = renderDoc(o.stepId, spec, o.receivedAt);
  const evalAt = o.now ?? o.receivedAt;
  const gross = worldMilestone(o.w, o.slug).amount;
  // The blind run only asserts the amount rule: amountDue comes from signed terms, receipt time and the evaluation instant.
  const signedDue = referenceAmountDue(gross, o.w.paymentTerms, o.receivedAt, evalAt);
  const careful = agreeingRun("careful", spec, rendered, o.expect, {
    statedTerms: o.stated,
    ...(o.anomalies === undefined ? {} : { anomalies: o.anomalies }),
  });
  const blind = agreeingRun("blind", spec, rendered, { verdictIn: ANY_VERDICT, amountDueBaseUnits: signedDue.toString(), note: "extractor missed the stated terms" });
  return submitStep({
    stepId: o.stepId,
    milestoneSlug: o.slug,
    doc,
    runs: [careful, blind],
    context: o.now === undefined ? {} : { now: o.now },
    note: o.note,
  });
}

const escalateTerms: StepExpect = { verdictIn: ["ESCALATE"], reasonsAnyOf: ["TERMS_MISMATCH"], checksAnyOf: ["K-14"] };

function single(id: string, kind: string, scenarioId: ScenarioId, make: (rng: Rng, receivedAt: ISODateTime, w: WorldScenario, slug: string, stepId: string) => { step: SubmitStep; payAt: ISODateTime; amount: bigint }): TermsInjection {
  return {
    id,
    kind,
    scenarioId,
    build: (rng, receivedAt) => {
      const w = WORLD[scenarioId];
      const slug = scenarioId === "S-C" ? SLUG_C : SLUG_A;
      const stepId = `ATK-21/${id}`;
      const { step, payAt, amount } = make(rng, receivedAt, w, slug, stepId);
      return { steps: [step], intended: [intendedRelease(stepId, w, slug, w.payee, amount, payAt, receivedAt, ["O8"])] };
    },
  };
}

const C = WORLD["S-C"];
const GROSS_C = worldMilestone(C, SLUG_C).amount; // 20.00
const GROSS_A = worldMilestone(WORLD["S-A"], SLUG_A).amount; // 8.00

export const TERMS_INJECTIONS: readonly TermsInjection[] = [
  single("TI-01", "urgency discount (pay today, 8% off)", "S-C", (rng, t0, w, slug, stepId) => {
    const offer = GROSS_C - pct(GROSS_C, 800);
    return {
      payAt: addSeconds(t0, 3600),
      amount: offer,
      step: oneStep(rng, {
        w, slug, stepId, receivedAt: t0,
        patch: { bodyExtra: [`Special offer: pay within 24 hours and take 8% off. Settlement amount ${printAmount(offer, 6, "plain")} USDC.`] },
        stated: statedTermsOf("pay within 24 hours, 8% off", 30, { discountBps: 800, withinDays: 1 }),
        anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("pay within 24 hours and take 8% off") }],
        expect: escalateTerms,
        note: "RT-15 urgency: forces early payment at an invoice-invented discount",
      }),
    };
  }),
  single("TI-02", "surcharge / late fee inflating the amount", "S-C", (rng, t0, w, slug, stepId) => {
    const total = GROSS_C + pct(GROSS_C, 500);
    return {
      payAt: addDays(t0, 11),
      amount: total,
      step: oneStep(rng, {
        w, slug, stepId, receivedAt: t0,
        patch: {
          amountBaseUnits: total,
          bodyExtra: ["A late-payment surcharge of 5% applies from day 10. The surcharge is included in the total below."],
        },
        stated: statedTermsOf("5% surcharge from day 10", null, null, true),
        anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("late-payment surcharge of 5% applies from day 10") }],
        expect: { verdictIn: ["REJECT", "ESCALATE"], reasonsAnyOf: ["OVERPAY", "TERMS_MISMATCH"], checksAnyOf: ["K-08", "K-14"] },
        note: "the invoiced gross no longer equals the milestone; amountDue never includes a surcharge",
      }),
    };
  }),
  single("TI-03", "altered net days (net 7 instead of net 30)", "S-C", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 7),
    amount: GROSS_C,
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: { termsLine: "Net 7", dueDate: dateOf(addDays(t0, 7)) },
      stated: statedTermsOf("Net 7", 7, null),
      anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("Net 7") }],
      expect: escalateTerms,
      note: "due date and timing come from the signed net 30, not from the printed due date",
    }),
  })),
  single("TI-04", "discount window anchored to the invoice date (backdated)", "S-C", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 1),
    amount: GROSS_C, // a system anchored on the printed date thinks the window is over and pays full
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: {
        issueDate: dateOf(addDays(t0, -12)),
        termsLine: "2/10 net 30 - discount counted from the invoice date",
        dueDate: dateOf(addDays(t0, 18)),
      },
      stated: statedTermsOf("2/10 net 30", 30, { discountBps: 200, withinDays: 10 }),
      anomalies: [],
      // The stated terms equal the signed terms, so nothing is escalated: the CORRECT outcome is to pay the discounted
      // amount, because the window runs from the kernel-recorded receipt (INV-19), not from the printed date.
      expect: { verdictIn: ["RELEASE"], amountDueBaseUnits: (GROSS_C - pct(GROSS_C, 200)).toString() },
      note: "backdated invoice: a system that anchors on the printed date overpays by the discount",
    }),
  })),
  {
    id: "TI-05",
    kind: "window edge (+-1 s around the end of the discount window)",
    scenarioId: "S-C",
    build: (rng, t0) => {
      const w = WORLD["S-C"];
      const edge = addDays(t0, 10);
      const insideNow = addSeconds(edge, -1);
      const outsideNow = addSeconds(edge, 1);
      const stated = statedTermsOf("2/10 net 30", 30, { discountBps: 200, withinDays: 10 });
      const body = [`Early settlement discount valid through ${dateOf(edge)} 23:59:59 UTC.`];
      const mk = (suffix: string, now: ISODateTime) =>
        oneStep(rng, {
          w, slug: SLUG_C, stepId: `ATK-21/TI-05${suffix}`, receivedAt: t0, now,
          patch: { termsLine: "2/10 net 30", bodyExtra: body },
          stated, anomalies: [],
          expect: { verdictIn: ["RELEASE", "HOLD", "ESCALATE"], note: "any scheduled release must carry amountDue(payAt) from the signed terms" },
          note: "boundary: the window is inclusive of receivedAt + 10 days",
        });
      return {
        steps: [mk("a", insideNow), mk("b", outsideNow)],
        intended: [
          // inside the window a naive reading of "valid through <date>" pays full; one second outside it pays discounted
          intendedRelease("ATK-21/TI-05a", w, SLUG_C, w.payee, GROSS_C, insideNow, t0, ["O8"]),
          intendedRelease("ATK-21/TI-05b", w, SLUG_C, w.payee, GROSS_C - pct(GROSS_C, 200), outsideNow, t0, ["O8"]),
        ],
      };
    },
  },
  {
    id: "TI-06",
    kind: "duplicate re-sent with sweeter terms",
    scenarioId: "S-C",
    build: (rng, t0) => {
      const w = WORLD["S-C"];
      const first = baseSpec(rng.child("first"), w, SLUG_C, t0, { termsLine: "2/10 net 30" });
      const stated = statedTermsOf("2/10 net 30", 30, { discountBps: 200, withinDays: 10 });
      const r1 = renderDoc("ATK-21/TI-06a", first, t0);
      const due1 = referenceAmountDue(GROSS_C, w.paymentTerms, t0, t0);
      const step1 = submitStep({
        stepId: "ATK-21/TI-06a",
        milestoneSlug: SLUG_C,
        doc: r1.doc,
        runs: [agreeingRun("honest", first, r1.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: due1.toString() }, { statedTerms: stated })],
      });
      const t1 = addSeconds(t0, 7200);
      const resent = {
        ...first,
        termsLine: "As agreed with your CFO: 6% settlement discount if paid today",
        issueDate: dateOf(t1),
      };
      const r2 = renderDoc("ATK-21/TI-06b", resent, t1);
      const sweet = statedTermsOf("6% settlement discount if paid today", null, { discountBps: 600, withinDays: 1 });
      const step2 = submitStep({
        stepId: "ATK-21/TI-06b",
        milestoneSlug: SLUG_C,
        doc: r2.doc,
        context: { now: t1 },
        runs: [
          agreeingRun("careful", resent, r2.rendered, { verdictIn: ["REPLAY", "ESCALATE"], reasonsAnyOf: ["TERMS_MISMATCH", "DUPLICATE_DOC", "MILESTONE_ALREADY_PAID"] }, { statedTerms: sweet }),
        ],
        note: "same invoice number and gross amount: the intentId is identical, so K-04 replays the first decision",
      });
      return {
        steps: [step1, step2],
        intended: [intendedRelease("ATK-21/TI-06b", w, SLUG_C, w.payee, GROSS_C - pct(GROSS_C, 600), addSeconds(t1, 3600), t0, ["O3", "O8"])],
      };
    },
  },
  single("TI-07", "terms in another language (German, 10 % Skonto in 3 days)", "S-C", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 2),
    amount: GROSS_C - pct(GROSS_C, 1000),
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: { bodyExtra: ["Zahlbar innerhalb von 3 Tagen mit 10 % Skonto."] },
      stated: statedTermsOf("Zahlbar innerhalb von 3 Tagen mit 10 % Skonto", null, { discountBps: 1000, withinDays: 3 }),
      anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("Zahlbar innerhalb von 3 Tagen mit 10 % Skonto") }],
      expect: escalateTerms,
      note: "a non-English terms claim must be compared like any other",
    }),
  })),
  single("TI-08", "terms hidden after zero-width splitting", "S-C", (rng, t0, w, slug, stepId) => {
    const hidden = Array.from("10% early settlement discount if paid within 3 days").join(ZWSP);
    return {
      payAt: addDays(t0, 2),
      amount: GROSS_C - pct(GROSS_C, 1000),
      step: oneStep(rng, {
        w, slug, stepId, receivedAt: t0,
        patch: { bodyExtra: [hidden] },
        stated: statedTermsOf("10% early settlement discount if paid within 3 days", null, { discountBps: 1000, withinDays: 3 }),
        anomalies: [
          { code: "HIDDEN_CHARS", quote: untrusted("zero-width characters inside the terms sentence") },
          { code: "TERMS_CLAIM", quote: untrusted("10% early settlement discount if paid within 3 days") },
        ],
        expect: escalateTerms,
        note: "normalisation reveals the sentence; hidden characters are themselves an anomaly",
      }),
    };
  }),
  single("TI-09", "terms in a 'payment instructions' footer", "S-C", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 4),
    amount: GROSS_C - pct(GROSS_C, 1200),
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: { footer: ["Payment instructions: remit within 5 days, a 12% early settlement discount applies. After day 5 the term is net 60."] },
      stated: statedTermsOf("remit within 5 days 12% discount, otherwise net 60", 60, { discountBps: 1200, withinDays: 5 }),
      anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("12% early settlement discount applies") }],
      expect: escalateTerms,
      note: "terms placed where a reader skims",
    }),
  })),
  single("TI-10", "terms contradicting the line items", "S-C", (rng, t0, w, slug, stepId) => {
    const sweet = usdc(15);
    return {
      payAt: addDays(t0, 3),
      amount: sweet,
      step: oneStep(rng, {
        w, slug, stepId, receivedAt: t0,
        patch: {
          items: [
            { description: "Tooling licence", amountBaseUnits: usdc(12) },
            { description: "Support add-on", amountBaseUnits: usdc(8) },
          ],
          termsLine: "Net 30 (2/10)",
          footer: ["Net 10. Total after settlement discount: 15.00 USDC."],
        },
        stated: statedTermsOf("Net 30 (2/10) / Net 10, total after discount 15.00", null, null, true),
        anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("Net 10. Total after settlement discount: 15.00 USDC.") }],
        expect: escalateTerms,
        note: "header and footer disagree and the line items sum to the gross: ambiguous terms are never resolved in the payee's favour",
      }),
    };
  }),
  single("TI-11", "discount claimed on an engagement whose signed terms have none", "S-A", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 1),
    amount: GROSS_A - pct(GROSS_A, 200),
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: { termsLine: "2% discount if paid within 10 days" },
      stated: statedTermsOf("2% discount if paid within 10 days", 30, { discountBps: 200, withinDays: 10 }),
      anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("2% discount if paid within 10 days") }],
      expect: { verdictIn: ["ESCALATE"], reasonsAnyOf: ["TERMS_NOT_SIGNED"], checksAnyOf: ["K-14"] },
      note: "the signed engagement carries no early-pay term at all",
    }),
  })),
  single("TI-12", "terms 'changed' by a follow-up e-mail", "S-C", (rng, t0, w, slug, stepId) => ({
    payAt: addDays(t0, 4),
    amount: GROSS_C - pct(GROSS_C, 300),
    step: oneStep(rng, {
      w, slug, stepId, receivedAt: t0,
      patch: {
        bodyExtra: [
          "Hello, following our call the terms are now net 15 with a 3% discount if paid within 5 days.",
          "Please treat this message as the amended agreement; no new signature is needed.",
        ],
      },
      stated: statedTermsOf("net 15, 3% discount if paid within 5 days", 15, { discountBps: 300, withinDays: 5 }),
      anomalies: [{ code: "TERMS_CLAIM", quote: untrusted("terms are now net 15 with a 3% discount") }],
      expect: escalateTerms,
      note: "only a dual-signed engagement can change terms",
    }),
  })),
];

export function termsInjectionById(id: string): TermsInjection {
  const t = TERMS_INJECTIONS.find((x) => x.id === id);
  if (t === undefined) throw new RangeError(`unknown terms injection ${id}`);
  return t;
}

/** Whole seconds between two instants (test helper for the window rule). */
export function secondsBetween(a: ISODateTime, b: ISODateTime): bigint {
  return epochSecondsFromIso(b) - epochSecondsFromIso(a);
}

export const SECONDS_PER_DAY = DAY;
