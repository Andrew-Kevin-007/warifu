// The honest side of the corpus (docs/07 §4, docs/15 §1): invoices that SHOULD pay. WP-22 supplies the 12 that
// the v2 spec names explicitly: the 6 "benign controls" of the public challenge and 6 honest invoices that use
// a legitimate early-pay discount (stated terms equal the signed terms, paid inside the window at amountDue).
// The wider corpus (>= 40, plus the 10 "legit but ugly") and its metrics belong to WP-24.
import type { ISODateTime, StatedTerms } from "@symbolon/schemas";
import { agreeingRun, baseSpec, correctAmount, releaseSpec, renderDoc, statedTermsOf, submitStep } from "./build";
import { Rng } from "./prng";
import { addDays, addSeconds } from "./time";
import { TEMPLATE_STYLES, HonestFixtureSchema, type ContextPatch, type HonestFixture, type ScenarioId } from "./types";
import { CLOCK_START, WORLD, worldMilestone } from "./world";

const T0 = CLOCK_START;

interface HonestDef {
  readonly id: string;
  readonly group: HonestFixture["group"];
  readonly caption: string;
  readonly scenarioId: ScenarioId;
  readonly slug: string;
  /** seconds after receipt at which the kernel evaluates (and, if it releases, pays) */
  readonly evalOffset: bigint;
  readonly context?: ContextPatch;
}

const PAID_API: ContextPatch = {
  milestoneStatus: { api: "PAID" },
  priorReleases: [{ milestoneSlug: "api", invoiceNumber: "INV-2026-0001", amountBaseUnits: worldMilestone(WORLD["S-B"], "api").amount.toString(), payee: WORLD["S-B"].payee, at: addDays(T0, -3) }],
};

const DAY = 86_400n;

const DEFS: readonly HonestDef[] = [
  { id: "BC-1", group: "benign-control", caption: "Design concept invoice, exact milestone amount.", scenarioId: "S-A", slug: "concept", evalOffset: 0n },
  { id: "BC-2", group: "benign-control", caption: "Final design invoice, exact milestone amount.", scenarioId: "S-A", slug: "final", evalOffset: 0n },
  { id: "BC-3", group: "benign-control", caption: "Dev API milestone with green CI.", scenarioId: "S-B", slug: "api", evalOffset: 0n },
  { id: "BC-4", group: "benign-control", caption: "Dev deploy milestone after the API one was paid.", scenarioId: "S-B", slug: "deploy", evalOffset: 0n, context: PAID_API },
  { id: "BC-5", group: "benign-control", caption: "Tools vendor, paid inside the 2/10 discount window.", scenarioId: "S-C", slug: "annual-licence", evalOffset: DAY },
  { id: "BC-6", group: "benign-control", caption: "Tools vendor, paid after the window at the full amount.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 12n * DAY },
  { id: "HD-1", group: "discount-honest", caption: "Early-pay invoice, received and paid on the same day.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 0n },
  { id: "HD-2", group: "discount-honest", caption: "Early-pay invoice, paid on day 1.", scenarioId: "S-C", slug: "annual-licence", evalOffset: DAY },
  { id: "HD-3", group: "discount-honest", caption: "Early-pay invoice, paid on day 3.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 3n * DAY },
  { id: "HD-4", group: "discount-honest", caption: "Early-pay invoice, paid on day 5.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 5n * DAY },
  { id: "HD-5", group: "discount-honest", caption: "Early-pay invoice, paid on day 9.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 9n * DAY },
  { id: "HD-6", group: "discount-honest", caption: "Early-pay invoice, paid two hours before the window closes.", scenarioId: "S-C", slug: "annual-licence", evalOffset: 10n * DAY - 7200n },
];

export function buildHonestFixture(def: HonestDef, rng: Rng, styleIndex: number): HonestFixture {
  const w = WORLD[def.scenarioId];
  const now: ISODateTime = addSeconds(T0, def.evalOffset);
  const style = TEMPLATE_STYLES[styleIndex % TEMPLATE_STYLES.length];
  if (style === undefined) throw new Error("no template style");
  const stated: StatedTerms | null =
    w.paymentTerms.earlyPay === null ? null : statedTermsOf("2/10 net 30", w.paymentTerms.netDays, w.paymentTerms.earlyPay);
  const spec = baseSpec(rng.child(def.id), w, def.slug, T0, {
    style,
    ...(stated === null ? {} : { termsLine: "2/10 net 30" }),
  });
  const r = renderDoc(def.id, spec, T0);
  const due = correctAmount(w, def.slug, T0, now);
  const context: ContextPatch = { ...(def.context ?? {}), ...(def.evalOffset === 0n ? {} : { now }) };
  const run = agreeingRun("honest", spec, r.rendered, { verdictIn: ["RELEASE"], amountDueBaseUnits: due.toString() }, stated === null ? {} : { statedTerms: stated });
  const step = submitStep({ stepId: def.id, milestoneSlug: def.slug, doc: r.doc, context, runs: [run] });
  return HonestFixtureSchema.parse({
    schema: "honest-fixture/1",
    id: def.id,
    group: def.group,
    caption: def.caption,
    scenarioId: def.scenarioId,
    step,
    correctRelease: releaseSpec(def.id, w, def.slug, w.payee, due, now),
    oracleExpected: "NO_LOSS",
  });
}

export function buildHonest(seed = "base"): HonestFixture[] {
  return DEFS.map((d, i) => buildHonestFixture(d, new Rng(`${d.id}/${seed}`), i));
}

export const BENIGN_CONTROL_IDS = DEFS.filter((d) => d.group === "benign-control").map((d) => d.id);
export const DISCOUNT_HONEST_IDS = DEFS.filter((d) => d.group === "discount-honest").map((d) => d.id);
