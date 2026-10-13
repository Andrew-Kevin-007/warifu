// The honest-corpus evaluator (WP-24): classification, rates, percentiles and the gates, exercised with stub targets
// whose behaviour is known, plus the real Symbolon unit target. The oracle is the real one (no mock of the judge).
import { describe, expect, it } from "vitest";
import { buildHonestCorpus } from "../src/honest-corpus";
import { b1Target } from "../src/harness/b1";
import { makeSymbolonUnitTarget } from "../src/harness/symbolon-unit";
import type { DecideInput, Target, TargetDecision } from "../src/harness/target";
import { HONEST_CLASSES, classify, evaluateHonestCorpus, evaluateHonestItem, percentile, rate, summarizeHonest, summarizeLatency, type Clock } from "../src/harness/honest-eval";
import { milestoneId, WORLD } from "../src/world";
import type { HonestExpect, HonestFixture } from "../src/types";

const fixtures = buildHonestCorpus();
const tick = (): Clock => {
  let t = 0;
  return { now: () => (t += 1) };
};

const base = { id: "symbolon" as const, label: "stub", provenance: "stub", fault: () => ({ status: "not-run" as const, reason: "", signals: [] }), cannotRun: () => null, unimplementedChecks: () => [] };

function stub(decide: (i: DecideInput) => TargetDecision): Target {
  return { ...base, decide };
}

const decision = (action: TargetDecision["action"], extra: Partial<TargetDecision> = {}): TargetDecision => ({
  action,
  release: null,
  checksFired: [],
  reasons: [],
  note: "",
  heldByUnimplementedChecks: false,
  ...extra,
});

/** A release exactly as the fixture says a correct system pays it. */
function correctRelease(h: HonestFixture, amount?: bigint): TargetDecision {
  const w = WORLD[h.scenarioId];
  return decision("RELEASE", {
    release: {
      milestoneId: milestoneId(w, h.step.milestoneSlug ?? ""),
      payee: h.correctRelease.payee,
      amount: amount ?? BigInt(h.correctRelease.amountBaseUnits),
      time: h.correctRelease.time,
      invoiceReceivedAt: h.step.doc.receivedAt,
      termsBasis: "signed",
      clockAnchor: h.step.doc.receivedAt,
      ownerApproved: false,
    },
  });
}

const byId = (id: string): HonestFixture => {
  const h = fixtures.find((x) => x.id === id);
  if (h === undefined) throw new Error(id);
  return h;
};

describe("classify", () => {
  const auto: HonestExpect = { outcome: "AUTO_RELEASE", why: "x" };
  const human: HonestExpect = { outcome: "HUMAN_REVIEW", humanVerdicts: ["ESCALATE"], reasonsAnyOf: ["AMOUNT_AMBIGUOUS"], why: "x" };
  it("covers every verdict for an invoice that should pay", () => {
    expect(classify(auto, decision("ESCALATE"), null, null).cls).toBe("FALSE_ESCALATION");
    expect(classify(auto, decision("HOLD"), null, null).cls).toBe("FALSE_HOLD");
    expect(classify(auto, decision("REJECT"), null, null).cls).toBe("WRONGFUL_REJECT");
    expect(classify(auto, decision("REPLAY"), null, null).cls).toBe("OTHER");
    expect(classify(auto, decision("HOLD", { heldByUnimplementedChecks: true }), null, null).cls).toBe("PENDING_CHECKS");
  });
  it("a release is only a success when the oracle says NO_LOSS and the amount is the correct one", () => {
    const rel = decision("RELEASE", { release: {} as never });
    expect(classify(auto, rel, "NO_LOSS", true).cls).toBe("AUTO_RELEASED");
    expect(classify(auto, rel, "NO_LOSS", false).cls).toBe("WRONG_RELEASE");
    expect(classify(auto, rel, "LOSS", true).cls).toBe("WRONG_RELEASE");
    expect(classify(human, rel, "NO_LOSS", true).cls).toBe("RELEASED_WHEN_HUMAN_EXPECTED");
  });
  it("for an invoice that needs a human, only the expected verdicts count, and the reason code is tracked", () => {
    expect(classify(human, decision("ESCALATE", { reasons: ["AMOUNT_AMBIGUOUS"] }), null, null)).toEqual({ cls: "CORRECTLY_SENT_TO_HUMAN", reasonMatches: true });
    expect(classify(human, decision("ESCALATE", { reasons: ["OTHER" as never] }), null, null)).toEqual({ cls: "CORRECTLY_SENT_TO_HUMAN", reasonMatches: false });
    expect(classify(human, decision("HOLD"), null, null).cls).toBe("WRONG_HUMAN_VERDICT");
    expect(classify(human, decision("REJECT"), null, null).cls).toBe("WRONGFUL_REJECT");
  });
});

describe("evaluation with known targets", () => {
  it("a target that rejects everything has a 100% wrongful-reject rate and fails both gates (the cost of safety is visible)", () => {
    const items = evaluateHonestCorpus(fixtures, stub(() => decision("REJECT")), tick()).map((e) => e.item);
    const s = summarizeHonest("stub", items, true);
    expect(s.classes.WRONGFUL_REJECT).toBe(fixtures.length);
    expect(s.wrongfulReject.rate).toBe(1);
    expect(s.autoRelease.rate).toBe(0);
    expect(s.gates.filter((g) => g.name.startsWith("wrongful-reject")).map((g) => g.status)).toEqual(["UNMET", "UNMET"]);
    expect(s.gates.find((g) => g.name === "auto-release rate")?.status).toBe("UNMET");
  });

  it("a target that pays every honest invoice at the correct amount is judged NO_LOSS by the real oracle", () => {
    const items = evaluateHonestCorpus(fixtures, stub((i) => correctRelease(fixtures.find((f) => f.id === i.fixtureAttackId) as HonestFixture)), tick()).map((e) => e.item);
    for (const i of items) {
      expect(i.oracle, i.id).toBe("NO_LOSS");
      expect(i.amountMatches, i.id).toBe(true);
    }
    const s = summarizeHonest("stub", items, true);
    expect(s.classes.AUTO_RELEASED + s.classes.RELEASED_WHEN_HUMAN_EXPECTED).toBe(fixtures.length);
    expect(s.classes.WRONG_RELEASE).toBe(0);
  });

  it("paying the invoice's gross inside the discount window is a WRONG_RELEASE (O2), not a pass", () => {
    const h = byId("HD-2"); // tools vendor, paid on day 1, discounted amount is due
    const gross = 20_000_000n;
    expect(BigInt(h.correctRelease.amountBaseUnits)).toBeLessThan(gross);
    const e = evaluateHonestItem(h, stub(() => correctRelease(h, gross)), tick());
    expect(e.item.class).toBe("WRONG_RELEASE");
    expect(e.item.oracle).toBe("LOSS");
    expect(e.item.oraclePredicates).toContain("O2");
    expect(e.item.amountMatches).toBe(false);
  });

  it("each honest invoice is evaluated on a fresh instance: the target sees the fixture's own context only", () => {
    const seen: number[] = [];
    evaluateHonestCorpus(fixtures, stub((i) => (seen.push(i.state.releases.length), decision("HOLD"))), tick());
    // only fixtures with prior releases in their patch start with any (HD..: none; BC-4, HG-deploy, HU-08/09 do)
    const withPrior = fixtures.filter((f) => (f.step.context.priorReleases ?? []).length > 0).map((f) => (f.step.context.priorReleases ?? []).length);
    expect(seen.filter((n) => n > 0)).toEqual(withPrior);
  });

  it("latency is measured around the decision with the injected clock, and every other field ignores it", () => {
    const a = evaluateHonestCorpus(fixtures, makeSymbolonUnitTarget(), tick());
    expect(a.every((e) => e.latencyMs === 1)).toBe(true);
    const b = evaluateHonestCorpus(fixtures, makeSymbolonUnitTarget(), { now: () => 0 });
    expect(a.map((e) => e.item)).toEqual(b.map((e) => e.item));
  });
});

describe("the real targets on the real corpus", () => {
  const symbolon = makeSymbolonUnitTarget();
  const items = evaluateHonestCorpus(fixtures, symbolon, tick()).map((e) => e.item);
  const summary = summarizeHonest("symbolon", items, symbolon.observedUnimplemented().length === 0);

  it("never releases anything wrongly and never counts a missing-check HOLD as a success", () => {
    expect(summary.classes.WRONG_RELEASE).toBe(0);
    for (const i of items.filter((x) => x.class === "PENDING_CHECKS")) {
      expect(i.released).toBe(false);
      expect(i.heldByUnimplementedChecks).toBe(true);
    }
    expect(summary.classes.AUTO_RELEASED).toBe(summary.releasePathAvailable ? summary.classes.AUTO_RELEASED : 0);
  });

  it("without a release path the release gates are INCONCLUSIVE, never MET", () => {
    if (summary.releasePathAvailable) return;
    for (const name of ["auto-release rate", "wrong releases"]) expect(summary.gates.find((g) => g.name === name)?.status).toBe("INCONCLUSIVE");
  });

  it("every class is accounted for exactly once", () => {
    expect(HONEST_CLASSES.reduce((s, c) => s + summary.classes[c], 0)).toBe(fixtures.length);
  });

  it("B1 pays the face amount of every early-pay invoice and is caught by the oracle", () => {
    const b1 = evaluateHonestCorpus(fixtures, b1Target, tick()).map((e) => e.item);
    const discounted = fixtures.filter((f) => f.scenarioId === "S-C" && BigInt(f.correctRelease.amountBaseUnits) < 20_000_000n).map((f) => f.id);
    expect(discounted.length).toBeGreaterThanOrEqual(10);
    for (const id of discounted) expect(b1.find((i) => i.id === id)?.class, id).toBe("WRONG_RELEASE");
  });
});

describe("rates, percentiles and latency summaries", () => {
  it("rate carries n, k and a Wilson interval, and has no rate for n = 0", () => {
    const r = rate(0, 62);
    expect(r).toMatchObject({ k: 0, n: 62, rate: 0, wilsonLower: 0 });
    expect(r.wilsonUpper).toBeGreaterThan(0.05);
    expect(r.wilsonUpper).toBeLessThan(0.07);
    expect(rate(1, 62).wilsonUpper).toBeGreaterThan(rate(0, 62).wilsonUpper as number);
    expect(rate(0, 0)).toEqual({ k: 0, n: 0, rate: null, wilsonLower: null, wilsonUpper: null });
  });

  it("percentile is nearest-rank on a sorted sample", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile(s, 10)).toBe(1);
    expect(percentile(s, 100)).toBe(10);
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile(s, 0)).toThrow(RangeError);
    expect(() => percentile(s, 101)).toThrow(RangeError);
  });

  it("summarizeLatency sorts, rounds to 3 places and handles the empty sample", () => {
    expect(summarizeLatency([])).toBeNull();
    expect(summarizeLatency([5.12345, 1, 3, 2, 4])).toEqual({ unit: "ms", samples: 5, p50: 3, p95: 5.123, max: 5.123 });
  });
});
