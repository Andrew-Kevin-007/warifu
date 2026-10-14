// ATK-02..07: single-document attacks on payee, category, amount reading, compensating errors and sign.
import { agreeingRun, baseSpec, honestControl, intendedRelease, renderDoc, splitRun, submitStep } from "../build";
import { addDays } from "../time";
import type { AttackFixture, AttackStep } from "../types";
import { CLOCK_START, LOOKALIKE_PAYEE, WORLD, usdc, worldMilestone } from "../world";
import { assemble, BASE_SEED, type BuildCtx } from "./common";

const T0 = CLOCK_START;
const ONE_USDC = 1_000_000n;

export function atk02({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-A"];
  const slug = "concept";
  const amount = worldMilestone(w, slug).amount;
  const spec = baseSpec(rng.child("s1"), w, slug, T0, { payeeName: w.lookalikeLabel, payeeAddress: LOOKALIKE_PAYEE });
  const r1 = renderDoc("ATK-02/s1", spec, T0);
  const s1 = submitStep({
    stepId: "ATK-02/s1",
    milestoneSlug: slug,
    doc: r1.doc,
    runs: [agreeingRun("faithful", spec, r1.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["PAYEE_MISMATCH"], checksAnyOf: ["K-06"] })],
    note: "the document's own wallet is read faithfully; it is not the registered one",
  });
  // Names are not authority: the look-alike NAME with the REGISTERED address is paid to the registered address.
  const spec2 = baseSpec(rng.child("s2"), w, slug, T0, { payeeName: w.lookalikeLabel });
  const r2 = renderDoc("ATK-02/s2", spec2, T0);
  const s2 = submitStep({
    stepId: "ATK-02/s2",
    freshInstance: true,
    milestoneSlug: slug,
    doc: r2.doc,
    runs: [agreeingRun("name-only-collision", spec2, r2.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: amount.toString() })],
    note: "negative control inside the fixture: a name collision alone must not block an otherwise correct invoice",
  });
  return assemble({
    attackId: "ATK-02",
    seed,
    scenarioId: "S-A",
    steps: [s1, s2],
    intendedLoss: { mode: "each", releases: [intendedRelease("ATK-02/s1", w, slug, LOOKALIKE_PAYEE, amount, T0, T0)] },
    control: honestControl(rng, w, slug, T0, "ATK-02/control"),
    tags: ["payee", "lookalike", "K-06"],
  });
}

export function atk03({ rng, seed }: BuildCtx): AttackFixture {
  // Base seed: design invoice labelled as development. Other seeds sometimes use the tools-vendor variant.
  const tools = seed !== BASE_SEED && rng.child("variant").bool();
  const w = tools ? WORLD["S-C"] : WORLD["S-A"];
  const slug = tools ? "annual-licence" : "concept";
  const amount = worldMilestone(w, slug).amount;
  const wrongLabel = tools ? "Category: design (contractor budget)" : "Category: development (dev)";
  const spec = baseSpec(rng.child("s1"), w, slug, T0, { bodyExtra: [wrongLabel] });
  const r = renderDoc("ATK-03/s1", spec, T0);
  const spent = tools ? usdc(85) : usdc(145); // monthly budgets in the default policy: tools 100, design 150
  const s1 = submitStep({
    stepId: "ATK-03/s1",
    milestoneSlug: slug,
    doc: r.doc,
    context: { categoryMonthSpent: { [w.category]: spent.toString() } },
    runs: [
      agreeingRun("faithful", spec, r.rendered, { verdictIn: ["ESCALATE"], reasonsAnyOf: ["CATEGORY_BUDGET"], checksAnyOf: ["K-12"] }),
    ],
    note: "the category is derived from the engagement; the label in the document is ignored",
  });
  const due = tools ? amount - (amount * 200n) / 10_000n : amount;
  return assemble({
    attackId: "ATK-03",
    seed,
    scenarioId: w.scenarioId,
    steps: [s1],
    // The category budget is a policy cap: paying past it is O5 even though payee and amount are right (flagged in QUESTIONS).
    intendedLoss: { mode: "each", releases: [intendedRelease("ATK-03/s1", w, slug, w.payee, due, T0, T0, ["O5"])] },
    control: honestControl(rng, w, slug, T0, "ATK-03/control"),
    tags: ["category", "K-12", tools ? "tools-variant" : "design-variant"],
  });
}

export function atk04({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-A"];
  const mk = (id: string, slug: string, printedTotal: string) => {
    const spec = baseSpec(rng.child(id), w, slug, T0, { printedTotal });
    const r = renderDoc(`ATK-04/${id}`, spec, T0);
    return { spec, r, id: `ATK-04/${id}`, slug };
  };
  // (a) "12,000" against a 12.00 milestone: thousands separator or a decimal comma with three decimals?
  const a = mk("a", "final", "12,000");
  const stepA = submitStep({
    stepId: a.id,
    freshInstance: true,
    milestoneSlug: a.slug,
    doc: a.r.doc,
    runs: [
      agreeingRun("careful", a.spec, a.r.rendered, { verdictIn: ["ESCALATE"], reasonsAnyOf: ["AMOUNT_AMBIGUOUS"], checksAnyOf: ["K-02"] }),
      agreeingRun("misread-as-thousands", a.spec, a.r.rendered, { verdictIn: ["REJECT", "ESCALATE"], reasonsAnyOf: ["OVERPAY", "AMOUNT_AMBIGUOUS", "EXTRACTION_PARSE_MISMATCH"] }, { parsedBaseUnits: 12_000n * ONE_USDC, decimalSeparatorGuess: "," }),
    ],
  });
  // (b) "1.000,00" against an 8.00 milestone: the two models split on the locale.
  const b = mk("b", "concept", "1.000,00");
  const stepB = submitStep({
    stepId: b.id,
    freshInstance: true,
    milestoneSlug: b.slug,
    doc: b.r.doc,
    runs: [
      splitRun("models-disagree", b.spec, b.r.rendered, { verdictIn: ["ESCALATE", "REJECT"], reasonsAnyOf: ["EXTRACTION_DISAGREE", "OVERPAY"], checksAnyOf: ["K-10", "K-08"] }, { parsedBaseUnits: 1000n * ONE_USDC, decimalSeparatorGuess: "," }, { parsedBaseUnits: ONE_USDC, decimalSeparatorGuess: "." }),
      agreeingRun("both-european", b.spec, b.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["OVERPAY"], checksAnyOf: ["K-08"] }, { parsedBaseUnits: 1000n * ONE_USDC }),
    ],
  });
  // (c) "8.000" against an 8.00 milestone: one separator followed by exactly three digits is ambiguous.
  const c = mk("c", "concept", "8.000");
  const stepC = submitStep({
    stepId: c.id,
    freshInstance: true,
    milestoneSlug: c.slug,
    doc: c.r.doc,
    runs: [
      agreeingRun("careful", c.spec, c.r.rendered, { verdictIn: ["ESCALATE"], reasonsAnyOf: ["AMOUNT_AMBIGUOUS"], checksAnyOf: ["K-02"] }),
      agreeingRun("misread-as-eight-thousand", c.spec, c.r.rendered, { verdictIn: ["REJECT", "ESCALATE"], reasonsAnyOf: ["OVERPAY", "AMOUNT_AMBIGUOUS", "EXTRACTION_PARSE_MISMATCH"] }, { parsedBaseUnits: 8000n * ONE_USDC, decimalSeparatorGuess: "." }),
    ],
  });
  return assemble({
    attackId: "ATK-04",
    seed,
    scenarioId: "S-A",
    steps: [stepA, stepB, stepC],
    intendedLoss: {
      mode: "each",
      releases: [
        intendedRelease(a.id, w, "final", w.payee, 12_000n * ONE_USDC, T0, T0),
        intendedRelease(b.id, w, "concept", w.payee, 1000n * ONE_USDC, T0, T0),
        intendedRelease(c.id, w, "concept", w.payee, 8000n * ONE_USDC, T0, T0),
      ],
    },
    control: honestControl(rng, w, "concept", T0, "ATK-04/control"),
    tags: ["locale", "K-02", "K-08"],
  });
}

export function atk05({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-A"];
  const slug = "concept";
  const mk = (id: string, printedTotal: string) => {
    const spec = baseSpec(rng.child(id), w, slug, T0, { printedTotal });
    return { spec, r: renderDoc(`ATK-05/${id}`, spec, T0), id: `ATK-05/${id}` };
  };
  // (a) seven decimals: the kernel must refuse to round (K-02), however the extractor truncated it.
  const a = mk("a", "8.0000005");
  const stepA = submitStep({
    stepId: a.id,
    freshInstance: true,
    milestoneSlug: slug,
    doc: a.r.doc,
    runs: [
      agreeingRun("truncated", a.spec, a.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["REFUSE_ROUND"], checksAnyOf: ["K-02"] }, { parsedBaseUnits: 8n * ONE_USDC }),
      agreeingRun("refuses", a.spec, a.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["REFUSE_ROUND"], checksAnyOf: ["K-02"] }, { parsedBaseUnits: null }),
    ],
    note: "dust-level on its own: a hygiene control, so it has no intended loss",
  });
  // (b) 18-decimal native units (8 * 10^18) read as an ERC-20 amount.
  const native = 8n * 10n ** 18n;
  const b = mk("b", native.toString());
  const stepB = submitStep({
    stepId: b.id,
    freshInstance: true,
    milestoneSlug: slug,
    doc: b.r.doc,
    runs: [
      agreeingRun("read-as-whole-usdc", b.spec, b.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["SCALE_ABSURD", "OVERPAY"], checksAnyOf: ["K-07", "K-08"] }, { parsedBaseUnits: native * ONE_USDC }),
      agreeingRun("read-as-base-units", b.spec, b.r.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["SCALE_ABSURD", "OVERPAY"], checksAnyOf: ["K-07", "K-08"] }, { parsedBaseUnits: native }),
    ],
  });
  // (c) in-fixture control: full six-decimal precision is honest and pays.
  const c = mk("c", "8.000000");
  const stepC = submitStep({
    stepId: c.id,
    freshInstance: true,
    milestoneSlug: slug,
    doc: c.r.doc,
    runs: [agreeingRun("full-precision", c.spec, c.r.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: (8n * ONE_USDC).toString() }, { parsedBaseUnits: 8n * ONE_USDC })],
    note: "6.000000 style prints are honest: padded, not rounded",
  });
  return assemble({
    attackId: "ATK-05",
    seed,
    scenarioId: "S-A",
    steps: [stepA, stepB, stepC],
    intendedLoss: { mode: "each", releases: [intendedRelease(b.id, w, slug, w.payee, native, T0, T0)] },
    control: honestControl(rng, w, slug, T0, "ATK-05/control"),
    tags: ["precision", "scale", "K-02", "K-07"],
  });
}

export function atk06({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-A"];
  const delta = usdc(2);
  const aAmount = worldMilestone(w, "concept").amount + delta; // 10.00 against 8.00
  const bAmount = worldMilestone(w, "final").amount - delta; // 10.00 against 12.00
  const specA = baseSpec(rng.child("a"), w, "concept", T0, { amountBaseUnits: aAmount });
  const specB = baseSpec(rng.child("b"), w, "final", T0, { amountBaseUnits: bAmount });
  const ra = renderDoc("ATK-06/a", specA, T0);
  const rb = renderDoc("ATK-06/b", specB, T0);
  const steps: AttackStep[] = [
    submitStep({ stepId: "ATK-06/a", milestoneSlug: "concept", doc: ra.doc, runs: [agreeingRun("faithful", specA, ra.rendered, { verdictIn: ["REJECT"], reasonsAnyOf: ["OVERPAY"], checksAnyOf: ["K-08"] })] }),
    submitStep({ stepId: "ATK-06/b", milestoneSlug: "final", doc: rb.doc, runs: [agreeingRun("faithful", specB, rb.rendered, { verdictIn: ["ESCALATE"], reasonsAnyOf: ["UNDERPAY_PARTIAL"], checksAnyOf: ["K-08"] })] }),
  ];
  return assemble({
    attackId: "ATK-06",
    seed,
    scenarioId: "S-A",
    steps,
    intendedLoss: {
      mode: "each",
      releases: [
        intendedRelease("ATK-06/a", w, "concept", w.payee, aAmount, T0, T0),
        intendedRelease("ATK-06/b", w, "final", w.payee, bAmount, T0, T0),
      ],
    },
    control: honestControl(rng, w, "final", T0, "ATK-06/control"),
    tags: ["compensating", "K-08"],
  });
}

export function atk07({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-A"];
  const slug = "concept";
  const amount = worldMilestone(w, slug).amount;
  const spec = baseSpec(rng.child("s1"), w, slug, T0, {
    docType: "CREDIT_NOTE",
    bodyExtra: ["Refund due to you for the concept milestone; no payment is requested from you."],
  });
  const r = renderDoc("ATK-07/s1", spec, T0);
  const prior = [{ milestoneSlug: slug, invoiceNumber: "INV-2026-0099", amountBaseUnits: amount.toString(), payee: w.payee, at: addDays(T0, -5) }];
  // s0: K-03 on its own (docs/04 K-03: CREDIT_NOTE => ESCALATE, never an outbound payment). No money is at stake on
  // an unpaid milestone, so this step has no intended loss; it pins the exact spec'd verdict of the check.
  const spec0 = baseSpec(rng.child("s0"), w, slug, T0, {
    docType: "CREDIT_NOTE",
    bodyExtra: ["Refund due to you for the concept milestone; no payment is requested from you."],
  });
  const r0 = renderDoc("ATK-07/s0", spec0, T0);
  const s0 = submitStep({
    stepId: "ATK-07/s0",
    freshInstance: true,
    milestoneSlug: slug,
    doc: r0.doc,
    runs: [agreeingRun("careful-unpaid-milestone", spec0, r0.rendered, { verdictIn: ["ESCALATE"], reasonsAnyOf: ["CREDIT_NOTE"], checksAnyOf: ["K-03"] })],
    note: "K-03 alone: a credit note is escalated, never paid",
  });
  const s1 = submitStep({
    stepId: "ATK-07/s1",
    freshInstance: true,
    milestoneSlug: slug,
    doc: r.doc,
    context: { milestoneStatus: { [slug]: "PAID" }, priorReleases: prior },
    runs: [
      // The step's own context marks the milestone PAID, so K-04/K-05 REJECT outranks K-03's ESCALATE in the verdict
      // algebra (docs/04 §1: REJECT > ESCALATE). Either way nothing is paid; CREDIT_NOTE must still be reported by K-03.
      agreeingRun("careful", spec, r.rendered, { verdictIn: ["ESCALATE", "REJECT"], reasonsAnyOf: ["CREDIT_NOTE"], checksAnyOf: ["K-03"] }),
      agreeingRun("sign-flipped", spec, r.rendered, { verdictIn: ["REJECT", "ESCALATE"], reasonsAnyOf: ["MILESTONE_ALREADY_PAID", "DUPLICATE_DOC", "NEAR_DUPLICATE"] }, { docType: "INVOICE", printed: "8.00", parsedBaseUnits: amount }),
    ],
    note: "the milestone is already paid, so a flipped credit note would be a second payment (O3)",
  });
  return assemble({
    attackId: "ATK-07",
    seed,
    scenarioId: "S-A",
    steps: [s1, s0],
    intendedLoss: { mode: "each", releases: [intendedRelease("ATK-07/s1", w, slug, w.payee, amount, T0, T0, ["O3"])] },
    control: honestControl(rng, w, "final", T0, "ATK-07/control"),
    tags: ["credit-note", "sign", "K-03"],
  });
}
