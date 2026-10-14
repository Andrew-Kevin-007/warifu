// P-K12-CAPS (docs/04 §9, docs/13 §4.1 K-12), 1,000 runs: random SEQUENCES of intents are evaluated one after another
// with the released totals a correct service would pass (context.ts ReleasedTotals: rolling 24 h / 7 d windows ending
// at ctx.now over the earlier RELEASE decisions, pending included; the calendar month per category). Afterwards an
// independent checker walks every window that ends at a RELEASE and asserts the cumulative RELEASE amounts and counts
// stay within the policy caps. Releases and cap refusals are counted so the property cannot pass vacuously, and a
// negative control (the same sequences with under-reported totals) shows the checker does find violations.
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { deriveEntityId, deriveMilestoneId, epochSecondsFromIso, isoFromEpochSeconds, keccak256Utf8 } from "@symbolon/schemas";
import type { Address, Engagement, Hex32, Milestone } from "@symbolon/schemas";
import { evaluate, summarizeEvaluation } from "../src/index";
import { issuesOf } from "../src/verdict";
import type { DecisionSummary, Evaluation, KernelContext, ReleasedTotals } from "../src/index";
import { ATTACKER, NOW, PAYEE, TENANT, context, engagement, intent, milestone, ownerAck, policy, withDoc } from "./helpers";
import { PROPERTY_TIMEOUT_MS, RUNS, eachExtraction } from "./props-common";
import { printAmount } from "./scenario";

vi.setConfig({ testTimeout: PROPERTY_TIMEOUT_MS });
/** A sequence property evaluates about 10,000 intents; give it room under coverage instrumentation on a loaded machine. */
const CAPS_TIMEOUT_MS = 4 * PROPERTY_TIMEOUT_MS;

const USDC = 1_000_000n;
const DAY = 86_400n;
const WEEK = 7n * DAY;

// Tighter than the fixture policy so that every limit binds within a short sequence: the per-payee amount (2,500)
// binds before the daily cap (4,000), the payee count (2/day) and the tenant count (5/day) bind in bursts, the weekly
// cap (6,000) and the monthly category budgets (3,500 each) bind over longer runs. Amounts above 1,500 need a human.
const CAPS = policy({
  caps: { perTxHardCap: "2000", dailyCap: "4000", weeklyCap: "6000", humanApprovalAbove: "1500" },
  velocity: { maxReleasesPerDay: 5, maxReleasesPerPayeePerDay: 2, maxAmountPerPayeePerDay: "2500" },
  categories: { design: "3500", dev: "3500" },
});
const L = CAPS.amounts;
const V = CAPS.policy.velocity;

const PAYEES: readonly Address[] = [PAYEE, ATTACKER];
const ENGAGEMENT_IDS: readonly Hex32[] = [deriveEntityId({ tenantId: TENANT, slug: "caps-a" }), deriveEntityId({ tenantId: TENANT, slug: "caps-b" })];

interface Step {
  readonly payee: 0 | 1;
  /** Gross in base units: 100.00 .. 2,100.99 USDC (some above the human gate and the per-tx cap). */
  readonly gross: bigint;
  /** Seconds after the previous step: bursts (<= 2 h) and gaps (<= 36 h). */
  readonly gap: bigint;
  readonly category: "design" | "dev";
}

const stepArb: fc.Arbitrary<Step> = fc.record({
  payee: fc.constantFrom<0 | 1>(0, 1),
  gross: fc.tuple(fc.integer({ min: 100, max: 2100 }), fc.integer({ min: 0, max: 99 })).map(([whole, cents]) => BigInt(whole) * USDC + BigInt(cents) * 10_000n),
  gap: fc.oneof(fc.bigInt({ min: 0n, max: 2n * 3_600n }), fc.bigInt({ min: 0n, max: 36n * 3_600n })),
  category: fc.constantFrom<"design" | "dev">("design", "dev"),
});

interface Release {
  readonly at: bigint;
  readonly month: string;
  readonly gross: bigint;
  readonly payee: 0 | 1;
  readonly category: string;
}

const sum = (rs: readonly Release[]): bigint => rs.reduce((s, r) => s + r.gross, 0n);

/** The released totals a correct service passes at `now` (the model under which the kernel must keep the caps). */
function totals(history: readonly Release[], now: bigint, month: string, payee: 0 | 1): ReleasedTotals {
  const day = history.filter((r) => r.at > now - DAY && r.at <= now);
  const categoryMonth: Record<string, bigint> = {};
  for (const r of history) if (r.month === month) categoryMonth[r.category] = (categoryMonth[r.category] ?? 0n) + r.gross;
  return {
    engagementTotal: sum(history.filter((r) => r.payee === payee)), // one engagement per payee
    tenantDay: sum(day),
    tenantWeek: sum(history.filter((r) => r.at > now - WEEK && r.at <= now)),
    payeeDay: sum(day.filter((r) => r.payee === payee)),
    payeeCountDay: day.filter((r) => r.payee === payee).length,
    tenantCountDay: day.length,
    categoryMonth,
  };
}

const NO_TOTALS: ReleasedTotals = context().released;

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** One engagement per payee holding a milestone per step (amount = that step's gross, so K-08 passes). */
function engagements(steps: readonly Step[], ids: readonly Hex32[]): readonly Engagement[] {
  return [0, 1].map((p) => {
    const ms: Milestone[] = [];
    steps.forEach((s, i) => {
      if (s.payee === p) ms.push(milestone(ids[i] as Hex32, `step-${i}`, { amountBaseUnits: s.gross.toString(), category: s.category }));
    });
    if (ms.length === 0) ms.push(milestone(keccak256Utf8(`unused ${p}`), "unused"));
    return engagement({ engagementId: ENGAGEMENT_IDS[p] as Hex32, payee: PAYEES[p] as Address, capBaseUnits: (1_000_000n * USDC).toString(), milestones: ms });
  });
}

/**
 * Evaluate the steps in order. `honest`: the service passes the true totals and prior decisions; otherwise it passes
 * zeros and no priors (an under-reporting service). Returns the RELEASEs and every evaluation.
 */
function simulate(steps: readonly Step[], honest: boolean): { readonly history: readonly Release[]; readonly evaluations: readonly Evaluation[] } {
  const milestoneIds = steps.map((_, i) => deriveMilestoneId({ tenantId: TENANT, uuid: uuid(i + 1) }));
  const es = engagements(steps, milestoneIds);
  const history: Release[] = [];
  const evaluations: Evaluation[] = [];
  const priors: DecisionSummary[] = [];
  let t = epochSecondsFromIso(NOW);
  steps.forEach((s, i) => {
    t += s.gap;
    const now = isoFromEpochSeconds(t);
    const month = now.slice(0, 7);
    const e = es[s.payee] as Engagement;
    const m = e.milestones.find((x) => x.milestoneId === milestoneIds[i]) as Milestone;
    const printed = printAmount(s.gross, "us");
    const docHash = keccak256Utf8(`caps document ${i}`);
    const raw = eachExtraction({ ...intent(), docHash, engagementId: e.engagementId, milestoneId: m.milestoneId }, (x) => {
      x.invoiceNumber = `INV-${1000 + i}`;
      x.amount.printed = printed;
      x.amount.parsedBaseUnits = s.gross.toString();
      x.lineItems = [];
      x.payee.walletAddress = e.payee;
    });
    const base = context({
      engagement: e,
      milestone: m,
      now,
      invoiceReceivedAt: isoFromEpochSeconds(t - 3_600n),
      evidence: [ownerAck(m.milestoneId, { collectedAt: isoFromEpochSeconds(t - 1_800n) })],
      priorDecisions: honest ? [...priors] : [],
      released: honest ? totals(history, t, month, s.payee) : NO_TOTALS,
    });
    const ctx: KernelContext = withDoc({ ...base, doc: { ...base.doc, hash: docHash } }, `INVOICE INV-${1000 + i}\nTotal: ${printed} USDC\n`);
    const ev = evaluate(raw, ctx, CAPS);
    evaluations.push(ev);
    if (ev.verdict === "RELEASE") {
      expect(ev.amountBaseUnits).toBe(s.gross.toString());
      history.push({ at: t, month, gross: s.gross, payee: s.payee, category: s.category });
    }
    const summary = summarizeEvaluation(ev, { decisionId: uuid(9_000 + i), createdAt: now });
    if (summary.ok) priors.push(summary.value);
  });
  return { history, evaluations };
}

/**
 * Independent cap checker: every rolling window that ENDS at a release (the maximum over any window is attained there)
 * and every calendar month per category. Returns the names of the limits that were exceeded.
 */
function violations(history: readonly Release[]): readonly string[] {
  const out = new Set<string>();
  for (const end of history) {
    const day = history.filter((r) => r.at > end.at - DAY && r.at <= end.at);
    const week = history.filter((r) => r.at > end.at - WEEK && r.at <= end.at);
    if (end.gross > L.perTxHardCap) out.add("perTx");
    if (end.gross > L.humanApprovalAbove) out.add("humanGate"); // no approvals exist in this world
    if (sum(day) > L.dailyCap) out.add("daily");
    if (sum(week) > L.weeklyCap) out.add("weekly");
    if (day.length > V.maxReleasesPerDay) out.add("tenantCount");
    for (const p of [0, 1] as const) {
      const mine = day.filter((r) => r.payee === p);
      if (sum(mine) > L.maxAmountPerPayeePerDay) out.add("payeeAmount");
      if (mine.length > V.maxReleasesPerPayeePerDay) out.add("payeeCount");
    }
    for (const c of ["design", "dev"]) if (sum(history.filter((r) => r.month === end.month && r.category === c)) > (L.categories[c] as bigint)) out.add("category");
  }
  return [...out].sort();
}

describe("P-K12-CAPS: cumulative RELEASE amounts within any window stay within the caps (random sequences)", () => {
  it("per-tx, rolling 24 h and 7 d tenant caps, per-payee amount and count, tenant count, monthly category budgets", () => {
    let releases = 0;
    const refused = new Map<string, number>();
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 20 }), (steps) => {
        const { history, evaluations } = simulate(steps, true);
        releases += history.length;
        for (const ev of evaluations) {
          const k12 = ev.checks.find((c) => c.id === "K-12");
          for (const code of new Set(k12 === undefined ? [] : issuesOf(k12).map((x) => x.code))) refused.set(code, (refused.get(code) ?? 0) + 1);
        }
        expect(violations(history)).toEqual([]);
      }),
      RUNS,
    );
    // Not vacuous. Measured on one run: about 3,500 releases; every limit refused something (CAP_WEEKLY least, ~170).
    expect(releases).toBeGreaterThan(2_000);
    for (const code of ["CAP_PER_TX", "CAP_DAILY", "CAP_WEEKLY", "VELOCITY", "CATEGORY_BUDGET", "HUMAN_REQUIRED"]) expect(refused.get(code) ?? 0, code).toBeGreaterThan(50);
  }, CAPS_TIMEOUT_MS);

  it("negative control: the same checker finds violations when the service under-reports the totals (zeros, no priors)", () => {
    // K-12 is only as good as the totals it is given (binding on KERNEL-SVC); this shows violations() can fail.
    const found = new Map<string, number>();
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 8, maxLength: 20 }), (steps) => {
        for (const v of violations(simulate(steps, false).history)) found.set(v, (found.get(v) ?? 0) + 1);
      }),
      { numRuns: 200 },
    );
    // Measured on one run (200 sequences): every rolling-window and monthly limit broken in 51..147 of them. Per-tx and
    // the human gate never are (K-12 reads them from the intent, not from the totals).
    for (const v of ["daily", "weekly", "payeeAmount", "payeeCount", "tenantCount", "category"]) expect(found.get(v) ?? 0, v).toBeGreaterThan(20);
    expect([found.get("perTx") ?? 0, found.get("humanGate") ?? 0]).toEqual([0, 0]);
  }, CAPS_TIMEOUT_MS);
});
