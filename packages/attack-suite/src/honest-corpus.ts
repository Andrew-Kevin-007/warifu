// The wider honest corpus (docs/07 §4; WP-24): 40 ordinary legitimate invoices ("general") and 10 "legit but ugly"
// invoices ("ugly"), on top of the 12 spec-named ones in honest.ts (6 benign controls, 6 discount-honest). 62 in all.
//
// What this corpus is, and what it is not:
//  - Every document is rendered from a seeded InvoiceSpec by the same templates the attacks use, so a defence cannot
//    tell attack documents and honest ones apart by their shape. Every fixture is honest: the payee is the
//    registered one, the amount is the milestone's (or a signed partial), terms (when stated) equal the signed terms.
//  - Expectations come from docs/04, not from a run: an `AUTO_RELEASE` fixture says "a correct kernel pays this with no
//    human"; a `HUMAN_REVIEW` fixture says "a human is needed by design (ambiguity, a claimed address change, a pending
//    payee change); the kernel must not guess". A fixture is never edited to turn a run green.
//  - Diversity is bounded by the three canonical scenarios (5 milestones, 3 categories, 3 payees). The corpus varies
//    template style (8), number style, currency label, line items, PO numbers, printed dates, stated terms, receipt
//    day and decision timing; the report prints the distinct counts it actually achieves.
//  - Extraction reads are the generator's REFERENCE reads (what a careful reader outputs); no model was called.
import type { ISODateTime, StatedTerms } from "@symbolon/schemas";
import { untrusted } from "@symbolon/schemas";
import { agreeingRun, baseSpec, correctAmount, releaseSpec, renderDoc, statedTermsOf, submitStep } from "./build";
import { buildHonest } from "./honest";
import { printAmount } from "./money-format";
import { Rng } from "./prng";
import type { LineItem } from "./templates";
import { addDays, addSeconds, dateOf } from "./time";
import {
  HonestFixtureSchema,
  TEMPLATE_STYLES,
  type ContextPatch,
  type HonestExpect,
  type HonestFixture,
  type HonestGroup,
  type ScenarioId,
  type StepExpect,
} from "./types";
import { CLOCK_START, WORLD, usdc, worldMilestone, type WorldScenario } from "./world";

const T0 = CLOCK_START;
const DAY = 86_400n;
const HOUR = 3_600n;

export const GENERAL_COUNT = 40;
export const UGLY_COUNT = 10;

interface MilestoneRef {
  readonly scenarioId: ScenarioId;
  readonly slug: string;
}

/** The five milestones of the three canonical engagements, in a fixed order. */
const MILESTONES: readonly MilestoneRef[] = [
  { scenarioId: "S-A", slug: "concept" },
  { scenarioId: "S-A", slug: "final" },
  { scenarioId: "S-B", slug: "api" },
  { scenarioId: "S-B", slug: "deploy" },
  { scenarioId: "S-C", slug: "annual-licence" },
];

/** Receipt day (days after the scenario clock start), decision delay and variant bits, chosen to spread coverage. */
const RECEIVED_DAYS = [0, 1, 2, 3, 5, 7, 9, 12, 14, 18, 20] as const;
/** Decision delays (seconds after receipt) for engagements without a discount. */
const DELAYS_PLAIN = [0n, HOUR, DAY, 3n * DAY, 7n * DAY, 14n * DAY, 21n * DAY, 27n * DAY] as const;
/** Decision delays for the tools vendor (2/10 net 30): inside, at the edge of, and after the discount window. */
const DELAYS_DISCOUNT = [0n, 6n * HOUR, DAY, 2n * DAY, 4n * DAY, 7n * DAY, 9n * DAY, 10n * DAY + HOUR, 12n * DAY, 20n * DAY] as const;

function priorApi(w: WorldScenario, receivedAt: ISODateTime): ContextPatch {
  return {
    milestoneStatus: { api: "PAID" },
    priorReleases: [
      { milestoneSlug: "api", invoiceNumber: "INV-2026-0001", amountBaseUnits: worldMilestone(w, "api").amount.toString(), payee: w.payee, at: addDays(receivedAt, -3) },
    ],
  };
}

/** Split `total` into `parts` positive pieces that sum to it exactly (bigint; remainder spread over the first pieces). */
export function splitAmount(total: bigint, parts: number): bigint[] {
  if (parts < 1 || total < BigInt(parts)) throw new RangeError("cannot split into that many positive parts");
  const n = BigInt(parts);
  const base = total / n;
  const rem = total % n;
  return Array.from({ length: parts }, (_, i) => base + (BigInt(i) < rem ? 1n : 0n));
}

const ITEM_WORDS = ["Discovery workshop", "Design review", "Implementation", "QA pass", "Documentation", "Handover session", "Revision round", "Asset export"] as const;

function lineItems(rng: Rng, total: bigint, parts: number): LineItem[] {
  return splitAmount(total, parts).map((amountBaseUnits, i) => ({
    description: `${ITEM_WORDS[(i + rng.int(ITEM_WORDS.length)) % ITEM_WORDS.length] ?? "Work item"} ${i + 1}`,
    amountBaseUnits,
  }));
}

const EXPECT_AUTO = (amountDue: bigint): StepExpect => ({ verdictIn: ["RELEASE"], amountDueBaseUnits: amountDue.toString() });

function generalFixture(i: number, seed: string): HonestFixture {
  const id = `HG-${String(i + 1).padStart(2, "0")}`;
  const rng = new Rng(`${id}/${seed}`);
  const ref = MILESTONES[i % MILESTONES.length] as MilestoneRef;
  const w = WORLD[ref.scenarioId];
  const slug = ref.slug;
  const gross = worldMilestone(w, slug).amount;
  const style = TEMPLATE_STYLES[i % TEMPLATE_STYLES.length] as (typeof TEMPLATE_STYLES)[number];
  const receivedAt = addDays(T0, RECEIVED_DAYS[(i * 3) % RECEIVED_DAYS.length] as number);
  const delays = w.paymentTerms.earlyPay === null ? DELAYS_PLAIN : DELAYS_DISCOUNT;
  const now = addSeconds(receivedAt, delays[(i * 7 + (i >> 2)) % delays.length] as bigint);

  // Variant bits: independent of the milestone/style cycle so the combinations spread out.
  const withItems = i % 3 === 0;
  const withPo = i % 4 === 0;
  const noPrintedDue = i % 6 === 5;
  const lookalikeName = i % 20 === 7;
  const statesTerms = i % 2 === 0;

  let stated: StatedTerms | null = null;
  let termsLine: string | null = null;
  if (w.paymentTerms.earlyPay !== null && statesTerms) {
    termsLine = "2/10 net 30";
    stated = statedTermsOf(termsLine, w.paymentTerms.netDays, w.paymentTerms.earlyPay);
  } else if (w.paymentTerms.earlyPay === null && i % 4 === 1) {
    termsLine = "Net 30";
    stated = statedTermsOf(termsLine, w.paymentTerms.netDays, null);
  }

  const spec = baseSpec(rng, w, slug, receivedAt, {
    style,
    ...(withItems ? { items: lineItems(rng.child("items"), gross, 2 + (i % 2)) } : {}),
    ...(withPo ? { poNumber: `PO-${String(4000 + rng.child("po").range(0, 899))}` } : {}),
    ...(noPrintedDue ? { dueDate: null } : {}),
    ...(lookalikeName ? { payeeName: w.lookalikeLabel } : {}),
    ...(termsLine === null ? {} : { termsLine }),
  });
  // Print variants a ledger really produces: the article's "6.000000" shape (six fraction digits) and a bare integer.
  const sixDigits = !withItems && i % 5 === 2;
  const bare = !withItems && !sixDigits && gross % 1_000_000n === 0n && i % 7 === 3;
  const printed = sixDigits ? printAmount(gross, 6, spec.numberStyle, { fractionDigits: 6 }) : bare ? printAmount(gross, 6, spec.numberStyle, { fractionDigits: 0 }) : null;
  const finalSpec = printed === null ? spec : { ...spec, printedTotal: printed };
  const r = renderDoc(id, finalSpec, receivedAt);
  const due = correctAmount(w, slug, receivedAt, now);
  const context: ContextPatch = { now, ...(ref.scenarioId === "S-B" && slug === "deploy" ? priorApi(w, receivedAt) : {}) };
  const run = agreeingRun("honest", finalSpec, r.rendered, EXPECT_AUTO(due), stated === null ? {} : { statedTerms: stated });
  const tags = [
    `style:${style}`,
    `category:${w.category}`,
    `milestone:${ref.scenarioId}/${slug}`,
    ...(withItems ? ["multi-line-items"] : []),
    ...(sixDigits ? ["six-fraction-digits"] : []),
    ...(bare ? ["bare-integer-print"] : []),
    ...(withPo ? ["po-number"] : []),
    ...(noPrintedDue ? ["no-printed-due"] : []),
    ...(lookalikeName ? ["payee-name-collision"] : []),
    ...(termsLine === null ? [] : ["states-terms"]),
    ...(due < gross ? ["early-pay-discount-applied"] : []),
  ];
  return HonestFixtureSchema.parse({
    schema: "honest-fixture/1",
    id,
    group: "general" satisfies HonestGroup,
    caption: `${w.payeeLabel}, ${slug}, ${style} template.`,
    scenarioId: ref.scenarioId,
    step: submitStep({ stepId: id, milestoneSlug: slug, doc: r.doc, context, runs: [run] }),
    correctRelease: releaseSpec(id, w, slug, w.payee, due, now),
    oracleExpected: "NO_LOSS",
    expect: {
      outcome: "AUTO_RELEASE",
      why: "A registered payee, the milestone's exact amount, stated terms (if any) equal to the signed terms: docs/04 gives no reason to involve a human.",
    },
    tags,
  });
}

// --- the 10 "legit but ugly" invoices ------------------------------------------------------------------------------
interface UglyDef {
  readonly id: string;
  readonly caption: string;
  readonly scenarioId: ScenarioId;
  readonly slug: string;
  readonly style: (typeof TEMPLATE_STYLES)[number];
  readonly tags: readonly string[];
  /** Seconds after receipt at which the kernel decides. */
  readonly delay?: bigint;
  /** The amount the correct (possibly human-approved) release pays; defaults to amountDue of the milestone. */
  readonly payAmount?: bigint;
  readonly expect: HonestExpect;
  readonly runExpect: StepExpect;
  readonly context?: (w: WorldScenario, receivedAt: ISODateTime) => ContextPatch;
  readonly spec?: (w: WorldScenario, receivedAt: ISODateTime) => Parameters<typeof baseSpec>[4];
  readonly extras?: { readonly claimsAddressChange?: boolean; readonly anomalies?: Array<{ code: "ADDRESS_CHANGE"; quote: ReturnType<typeof untrusted> }> };
}

const HUMAN_ESCALATE_AMBIGUOUS: HonestExpect = {
  outcome: "HUMAN_REVIEW",
  humanVerdicts: ["ESCALATE"],
  reasonsAnyOf: ["AMOUNT_AMBIGUOUS"],
  why: "The total is printed with one separator followed by exactly three digits; docs/04 K-02 never guesses, so a human confirms the amount, which matches the milestone.",
};
const ESCALATE_AMBIGUOUS_RUN: StepExpect = { verdictIn: ["ESCALATE"], reasonsAnyOf: ["AMOUNT_AMBIGUOUS"], checksAnyOf: ["K-02"] };
const AUTO_WHY = (what: string): HonestExpect => ({ outcome: "AUTO_RELEASE", why: what });

const UGLY: readonly UglyDef[] = [
  {
    id: "HU-01",
    caption: "Concept invoice printed as 8.000: a decimal point or a thousands separator?",
    scenarioId: "S-A",
    slug: "concept",
    style: "plain",
    tags: ["ambiguous-separator", "matches-milestone"],
    expect: HUMAN_ESCALATE_AMBIGUOUS,
    runExpect: ESCALATE_AMBIGUOUS_RUN,
    spec: () => ({ printedTotal: "8.000" }),
  },
  {
    id: "HU-02",
    caption: "Final design invoice printed as 12,000 on a German-style template.",
    scenarioId: "S-A",
    slug: "final",
    style: "eu-formal",
    tags: ["ambiguous-separator", "matches-milestone"],
    expect: HUMAN_ESCALATE_AMBIGUOUS,
    runExpect: ESCALATE_AMBIGUOUS_RUN,
    spec: () => ({ printedTotal: "12,000" }),
  },
  {
    id: "HU-03",
    caption: "Dev API invoice printed as 10.000 on a US letter template.",
    scenarioId: "S-B",
    slug: "api",
    style: "us-letter",
    tags: ["ambiguous-separator", "matches-milestone"],
    expect: HUMAN_ESCALATE_AMBIGUOUS,
    runExpect: ESCALATE_AMBIGUOUS_RUN,
    spec: () => ({ printedTotal: "10.000" }),
  },
  {
    id: "HU-04",
    caption: "Design invoice with a note that a payee change was completed; the printed wallet is the registered one.",
    scenarioId: "S-A",
    slug: "concept",
    style: "pdf-text-layer",
    tags: ["address-change-note", "payee-change-path"],
    expect: {
      outcome: "HUMAN_REVIEW",
      humanVerdicts: ["ESCALATE"],
      reasonsAnyOf: ["ADDRESS_CHANGE_CLAIMED"],
      why: "Any invoice that mentions changed payment details is escalated (docs/04 K-06); the legitimate route for a change is the on-chain PayeeChange path, so the human only confirms that nothing else changed.",
    },
    runExpect: { verdictIn: ["ESCALATE"], reasonsAnyOf: ["ADDRESS_CHANGE_CLAIMED"], checksAnyOf: ["K-06", "K-11"] },
    spec: () => ({ bodyExtra: ["Note: the payee change we filed with the owner last month is complete. Our wallet below is the registered one; nothing else changes."] }),
    extras: { claimsAddressChange: true, anomalies: [{ code: "ADDRESS_CHANGE", quote: untrusted("the payee change we filed with the owner last month is complete") }] },
  },
  {
    id: "HU-05",
    caption: "Plain invoice while a legitimate payee change is pending on-chain.",
    scenarioId: "S-A",
    slug: "final",
    style: "plain",
    tags: ["payee-change-pending", "payee-change-path"],
    expect: {
      outcome: "HUMAN_REVIEW",
      humanVerdicts: ["HOLD"],
      reasonsAnyOf: ["PAYEE_CHANGE_PENDING"],
      why: "While a PayeeChange is pending the kernel waits (docs/04 K-06: HOLD PAYEE_CHANGE_PENDING); it re-evaluates when the change settles. Nothing is wrong with the invoice.",
    },
    runExpect: { verdictIn: ["HOLD"], reasonsAnyOf: ["PAYEE_CHANGE_PENDING"], checksAnyOf: ["K-06"] },
    context: () => ({ payeeChangePending: true }),
  },
  {
    id: "HU-06",
    caption: "Late-printed invoice: the printed due date is already in the past when it arrives.",
    scenarioId: "S-A",
    slug: "final",
    style: "swiss",
    tags: ["late-invoice", "printed-due-in-past"],
    expect: AUTO_WHY("The kernel's clock starts at the recorded receipt and uses the signed terms; the printed due date is a hint and is ignored (docs/04 K-14, INV-19), so a late-printed but correct invoice is paid normally."),
    runExpect: EXPECT_AUTO(usdc(12)),
    spec: (_w, receivedAt) => ({ issueDate: dateOf(addDays(receivedAt, -45)), dueDate: dateOf(addDays(receivedAt, -15)) }),
  },
  {
    id: "HU-07",
    caption: "Decision made 40 days after receipt, past the signed net-30 due date.",
    scenarioId: "S-A",
    slug: "final",
    style: "bilingual",
    tags: ["late-invoice", "past-signed-due"],
    delay: 40n * DAY,
    expect: AUTO_WHY("Past the signed due date the kernel pays at once and flags LATE (docs/04 K-14); lateness is not a reason to refuse an honest invoice."),
    runExpect: EXPECT_AUTO(usdc(12)),
  },
  {
    id: "HU-08",
    caption: "Partial milestone: 7.00 of the 18.00 deploy milestone (partial payments allowed).",
    scenarioId: "S-B",
    slug: "deploy",
    style: "html",
    tags: ["partial-milestone"],
    payAmount: usdc(7),
    expect: AUTO_WHY("The signed engagement marks the milestone partialAllowed, so an invoice below the milestone amount is legitimate (docs/04 K-08)."),
    runExpect: EXPECT_AUTO(usdc(7)),
    context: (w, receivedAt) => priorApi(w, receivedAt),
    spec: () => ({ amountBaseUnits: usdc(7), description: "Deploy the service to staging: first instalment" }),
  },
  {
    id: "HU-09",
    caption: "Partial milestone, remainder: 7.00 after 11.00 was already paid on the same milestone.",
    scenarioId: "S-B",
    slug: "deploy",
    style: "multi-line",
    tags: ["partial-milestone", "second-instalment"],
    payAmount: usdc(7),
    expect: AUTO_WHY("The earlier instalment plus this one equals the milestone amount, and the engagement allows partial payments (docs/04 K-08); nothing is overpaid."),
    runExpect: EXPECT_AUTO(usdc(7)),
    context: (w, receivedAt) => {
      const api = priorApi(w, receivedAt);
      return {
        ...api,
        priorReleases: [
          ...(api.priorReleases ?? []),
          { milestoneSlug: "deploy", invoiceNumber: "INV-2026-0002", amountBaseUnits: usdc(11).toString(), payee: w.payee, at: addDays(receivedAt, -2) },
        ],
      };
    },
    spec: () => ({ amountBaseUnits: usdc(7), description: "Deploy the service to staging: final instalment" }),
  },
  {
    id: "HU-10",
    caption: "Long honest invoice (eighteen line items) close to the sandbox size limit.",
    scenarioId: "S-A",
    slug: "final",
    style: "multi-line",
    tags: ["long-document", "multi-line-items"],
    expect: AUTO_WHY("Only the size matters here: the document stays under the 4,096-byte sandbox limit (docs/04 K-01), so it is read and paid like any other."),
    runExpect: EXPECT_AUTO(usdc(12)),
    spec: (w) => ({
      items: splitAmount(worldMilestone(w, "final").amount, 18).map((amountBaseUnits, i) => ({
        description: `Itemised deliverable ${String(i + 1).padStart(2, "0")}: brand sheet page layout, colour proofs and print-ready export for the partner stationery set, including two rounds of minor revisions`,
        amountBaseUnits,
      })),
    }),
  },
];

function uglyFixture(def: UglyDef, seed: string): HonestFixture {
  const rng = new Rng(`${def.id}/${seed}`);
  const w = WORLD[def.scenarioId];
  const receivedAt = T0;
  const now = addSeconds(receivedAt, def.delay ?? 0n);
  const spec = baseSpec(rng, w, def.slug, receivedAt, { style: def.style, ...(def.spec?.(w, receivedAt) ?? {}) });
  const r = renderDoc(def.id, spec, receivedAt);
  const due = def.payAmount ?? correctAmount(w, def.slug, receivedAt, now);
  const context: ContextPatch = { now, ...(def.context?.(w, receivedAt) ?? {}) };
  const run = agreeingRun("honest", spec, r.rendered, def.runExpect, def.extras ?? {});
  return HonestFixtureSchema.parse({
    schema: "honest-fixture/1",
    id: def.id,
    group: "ugly" satisfies HonestGroup,
    caption: def.caption,
    scenarioId: def.scenarioId,
    step: submitStep({ stepId: def.id, milestoneSlug: def.slug, doc: r.doc, context, runs: [run] }),
    correctRelease: releaseSpec(def.id, w, def.slug, w.payee, due, now),
    oracleExpected: "NO_LOSS",
    expect: def.expect,
    tags: [`style:${def.style}`, `category:${w.category}`, `milestone:${def.scenarioId}/${def.slug}`, ...def.tags],
  });
}

export function buildGeneralHonest(seed = "base"): HonestFixture[] {
  return Array.from({ length: GENERAL_COUNT }, (_, i) => generalFixture(i, seed));
}

export function buildUglyHonest(seed = "base"): HonestFixture[] {
  return UGLY.map((d) => uglyFixture(d, seed));
}

/** The whole honest corpus: 6 benign controls + 6 discount-honest + 40 general + 10 ugly = 62. */
export function buildHonestCorpus(seed = "base"): HonestFixture[] {
  return [...buildHonest(seed), ...buildGeneralHonest(seed), ...buildUglyHonest(seed)];
}

/** What a fixture expects (the 12 WP-22 fixtures carry no `expect` and mean AUTO_RELEASE). */
export function expectationOf(h: HonestFixture): HonestExpect {
  return h.expect ?? { outcome: "AUTO_RELEASE", why: "A spec-named honest invoice (docs/07 §4, docs/15 §1): it must pay." };
}
