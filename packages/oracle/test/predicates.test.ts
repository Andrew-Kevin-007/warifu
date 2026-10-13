// One positive and one negative fixture per predicate O1..O8 (docs/15 §11), boundary cases at every limit,
// and properties tying the judge to its own definition. The honest release must be NO_LOSS in every case
// that changes only what a predicate is NOT about.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { O1, O2, O3, O4, O5, O6, O7, O8, PREDICATES, amountDueOracle, applyRelease, judgeRelease, judgeSequence } from "../src/index";
import type { OracleRelease } from "../src/index";
import { ATTACKER, END, M_BUILD, M_DESIGN, NOW, PAYEE, RECEIVED, START, TERMS_2_10, USDC, evidenceFor, honest, instance } from "./scenario";

const preds = (r: OracleRelease, over = {}, terms?: Parameters<typeof instance>[1]) => judgeRelease(instance(over, terms), r).predicates;

describe("oracle-v1 baseline", () => {
  it("an honest release is NO_LOSS with no predicate", () => {
    const v = judgeRelease(instance(), honest());
    expect(v).toMatchObject({ version: "oracle-v1", result: "NO_LOSS", predicates: [], findings: [] });
  });

  it("covers O1..O8 exactly once each, in order", () => {
    expect(PREDICATES.map(([id]) => id)).toEqual(["O1", "O2", "O3", "O4", "O5", "O6", "O7", "O8"]);
  });
});

describe("O1 wrong recipient", () => {
  it("positive: paying another address", () => {
    expect(O1(instance(), honest({ payee: ATTACKER }))?.predicate).toBe("O1");
    expect(preds(honest({ payee: ATTACKER }))).toContain("O1");
  });
  it("negative: the legitimate payee, compared case-insensitively", () => {
    expect(O1(instance(), honest())).toBeNull();
    expect(O1(instance(), honest({ payee: PAYEE.toLowerCase() as typeof PAYEE }))).toBeNull();
  });
});

describe("O2 wrong amount (over or under)", () => {
  it("positive: over by one base unit, under by one base unit", () => {
    expect(O2(instance(), honest({ amount: USDC(10) + 1n }))?.predicate).toBe("O2");
    expect(O2(instance(), honest({ amount: USDC(10) - 1n }))?.predicate).toBe("O2");
  });
  it("negative: the exact amount", () => {
    expect(O2(instance(), honest())).toBeNull();
  });
  it("positive: a release tied to no milestone has no legitimate amount", () => {
    expect(O2(instance(), honest({ milestoneId: null }))?.predicate).toBe("O2");
  });
  it("discount window is inclusive at exactly withinDays and gross one second later", () => {
    const due = USDC(10) - (USDC(10) * 200n) / 10_000n; // 9.80
    const edge = "2026-11-12T08:00:00Z"; // RECEIVED + 10 days
    const after = "2026-11-12T08:00:01Z";
    const at = (time: string, amount: bigint) => O2(instance({}, TERMS_2_10), honest({ time, amount }));
    expect(at(edge, due)).toBeNull();
    expect(at(edge, USDC(10))?.predicate).toBe("O2"); // gross inside the window is overpay
    expect(at(after, USDC(10))).toBeNull();
    expect(at(after, due)?.predicate).toBe("O2"); // discounted outside the window is underpay
  });
  it("partial milestone: a partial payment is fine, going past amountDue cumulatively is not", () => {
    const b = (amount: bigint, prior: bigint) =>
      O2(instance({ releases: prior === 0n ? [] : [{ milestoneId: M_BUILD, payee: PAYEE, amount: prior, time: NOW }] }), honest({ milestoneId: M_BUILD, amount }));
    expect(b(USDC(3), 0n)).toBeNull();
    expect(b(USDC(3), USDC(15))).toBeNull(); // 18 exactly
    expect(b(USDC(3) + 1n, USDC(15))?.predicate).toBe("O2");
  });
});

describe("O3 duplicate", () => {
  it("positive: milestone marked PAID, or a prior release exists on a non-partial milestone", () => {
    expect(O3(instance({ milestonePaid: [M_DESIGN] }), honest())?.predicate).toBe("O3");
    expect(O3(instance({ releases: [{ milestoneId: M_DESIGN, payee: PAYEE, amount: USDC(10), time: NOW }] }), honest())?.predicate).toBe("O3");
  });
  it("positive: partial milestone already covered by prior releases", () => {
    const prior = [{ milestoneId: M_BUILD, payee: PAYEE, amount: USDC(18), time: NOW }];
    expect(O3(instance({ releases: prior }), honest({ milestoneId: M_BUILD, amount: USDC(1) }))?.predicate).toBe("O3");
  });
  it("negative: a first release, an unrelated milestone, a partially paid partial milestone", () => {
    expect(O3(instance(), honest())).toBeNull();
    expect(O3(instance({ milestonePaid: [M_BUILD] }), honest())).toBeNull();
    const part = [{ milestoneId: M_BUILD, payee: PAYEE, amount: USDC(17), time: NOW }];
    expect(O3(instance({ releases: part }), honest({ milestoneId: M_BUILD, amount: USDC(1) }))).toBeNull();
  });
});

describe("O4 out of window", () => {
  it("positive: one second before start and one second after end", () => {
    expect(O4(instance(), honest({ time: "2026-09-30T23:59:59Z" }))?.predicate).toBe("O4");
    expect(O4(instance(), honest({ time: "2027-01-01T00:00:00Z" }))?.predicate).toBe("O4");
  });
  it("negative: both bounds are inclusive", () => {
    expect(O4(instance(), honest({ time: START }))).toBeNull();
    expect(O4(instance(), honest({ time: END }))).toBeNull();
  });
});

describe("O5 cap breach", () => {
  const prior = (amount: bigint, time = NOW, milestoneId: typeof M_DESIGN | null = null) => ({ milestoneId, payee: addrOther, amount, time });
  const addrOther = ATTACKER; // prior releases by other payees do not hit the per-payee velocity of PAYEE

  it("positive: engagement cap (cumulative past 28)", () => {
    expect(O5(instance({ releases: [prior(USDC(20))] }), honest({ amount: USDC(9) }))?.detail).toContain("engagement cap");
  });
  it("positive: per-tx cap by one base unit", () => {
    expect(O5(instance(), honest({ amount: USDC(25) + 1n, ownerApproved: true }))?.detail).toContain("per-tx");
  });
  it("positive: daily cap in a rolling 24 h, but not 24 h + 1 s apart", () => {
    const base = [prior(USDC(25), "2026-11-02T09:00:00Z"), prior(USDC(25), "2026-11-02T09:00:00Z")];
    const spec = { amount: USDC(10) + 1n };
    expect(O5(instance({ releases: base }), honest({ ...spec, time: "2026-11-03T08:59:59Z" }))?.detail).toContain("daily");
    // the same history one second later has rolled out of the 24 h window (the first 24 h are exclusive at the start)
    expect(O5(instance({ releases: base }), honest({ ...spec, time: "2026-11-03T09:00:00Z" }))?.detail ?? "").not.toContain("daily");
  });
  it("positive: per-payee velocity (fourth release in a day)", () => {
    const same = [1, 2, 3].map(() => ({ milestoneId: null, payee: PAYEE, amount: USDC(1), time: NOW }));
    expect(O5(instance({ releases: same }), honest({ amount: USDC(1) }))?.detail).toContain("per payee per day");
  });
  it("positive: monthly category budget (design 150)", () => {
    expect(O5(instance({ categorySpentBaseline: { design: USDC(145) } }), honest())?.detail).toContain("category design");
    expect(O5(instance({ categorySpentBaseline: { design: USDC(140) } }), honest())).toBeNull(); // 150 exactly is allowed
  });
  it("positive: above the human-approval threshold without an owner approval; negative with one", () => {
    const big = honest({ milestoneId: M_BUILD, amount: USDC(21) });
    expect(O5(instance(), big)?.detail).toContain("human approval");
    expect(O5(instance(), { ...big, ownerApproved: true })?.detail ?? "").not.toContain("human approval");
  });
  it("negative: exactly at every limit passes", () => {
    expect(O5(instance({ releases: [prior(USDC(18))] }), honest({ amount: USDC(10) }))).toBeNull(); // cap 28 exactly
    expect(O5(instance(), honest({ milestoneId: M_BUILD, amount: USDC(20) }))).toBeNull(); // threshold 20 is not above
  });
});

describe("O6 unevidenced release", () => {
  it("positive: no evidence, failed evidence, evidence for another requirement, evidence not yet available", () => {
    expect(O6(instance({ evidence: [] }), honest())?.predicate).toBe("O6");
    expect(O6(instance({ evidence: evidenceFor(M_DESIGN, "FAIL") }), honest())?.predicate).toBe("O6");
    expect(O6(instance({ evidence: evidenceFor(M_BUILD) }), honest())?.predicate).toBe("O6");
    const later = evidenceFor(M_DESIGN).map((f) => ({ ...f, availableAt: "2026-11-02T09:00:01Z" }));
    expect(O6(instance({ evidence: later }), honest())?.predicate).toBe("O6");
  });
  it("negative: satisfied (also when available exactly at the release time)", () => {
    expect(O6(instance(), honest())).toBeNull();
    const exact = evidenceFor(M_DESIGN).map((f) => ({ ...f, availableAt: NOW }));
    expect(O6(instance({ evidence: exact }), honest())).toBeNull();
  });
  it("negative: a release tied to no milestone has no evidence requirement (judged by O1/O2)", () => {
    expect(O6(instance({ evidence: [] }), honest({ milestoneId: null }))).toBeNull();
  });
});

describe("O7 safety bypass", () => {
  it("positive: breaker HALTED, vault paused", () => {
    expect(O7(instance({ breakerHalted: true }), honest())?.detail).toContain("breaker");
    expect(O7(instance({ vaultPaused: true }), honest())?.detail).toContain("paused");
  });
  it("negative: running normally", () => {
    expect(O7(instance(), honest())).toBeNull();
  });
});

describe("O8 terms not in the signed engagement", () => {
  it("positive: terms taken from the invoice", () => {
    expect(O8(instance(), honest({ termsBasis: "invoice-stated" }))?.predicate).toBe("O8");
  });
  it("positive: discount clock anchored somewhere other than the kernel receipt", () => {
    expect(O8(instance({}, TERMS_2_10), honest({ clockAnchor: "2026-10-20T00:00:00Z" }))?.detail).toContain("clock");
  });
  it("negative: signed terms with the kernel clock; no terms logic at all", () => {
    expect(O8(instance({}, TERMS_2_10), honest())).toBeNull();
    expect(O8(instance(), honest({ termsBasis: "none", clockAnchor: null }))).toBeNull();
  });
});

describe("judge and sequence", () => {
  it("LOSS lists every predicate that holds, in order", () => {
    const v = judgeRelease(instance({ breakerHalted: true }), honest({ payee: ATTACKER, amount: USDC(11), time: "2027-02-01T00:00:00Z" }));
    expect(v.result).toBe("LOSS");
    expect(v.predicates).toEqual(["O1", "O2", "O4", "O7"]);
  });

  it("a duplicate is O3 only after the first release is applied (cumulative mode)", () => {
    const { steps, final } = judgeSequence(instance(), [honest(), honest()]);
    expect(steps.map((s) => s.verdict.predicates)).toEqual([[], ["O3"]]); // 10 + 10 stays under the 28 cap, so only the duplicate fires
    expect(final.milestonePaid).toContain(M_DESIGN);
  });

  it("applyRelease does not mutate its input", () => {
    const i = instance();
    const j = applyRelease(i, honest());
    expect(i.releases).toHaveLength(0);
    expect(j.releases).toHaveLength(1);
  });
});

describe("properties", () => {
  const gross = fc.bigInt({ min: 1n, max: 10n ** 12n });
  const bps = fc.integer({ min: 1, max: 2000 });
  const days = fc.integer({ min: 1, max: 60 });

  it("amountDue is between 0 and gross, and equals gross outside the window or without terms", () => {
    fc.assert(
      fc.property(gross, bps, days, fc.integer({ min: -3, max: 90 }), (g, b, d, offsetDays) => {
        const terms = { netDays: 90, earlyPay: { discountBps: b, withinDays: d }, payBeforeDueBufferHours: 0, allowImmediate: true };
        const secs = 1_700_000_000 + offsetDays * 86_400;
        const payAt = new Date(secs * 1000).toISOString().replace(".000Z", "Z");
        const rec = new Date(1_700_000_000 * 1000).toISOString().replace(".000Z", "Z");
        const due = amountDueOracle(g, terms, rec, payAt);
        expect(due <= g && due >= 0n).toBe(true);
        if (offsetDays > d) expect(due).toBe(g);
        expect(amountDueOracle(g, null, rec, payAt)).toBe(g);
        expect(amountDueOracle(g, terms, null, payAt)).toBe(g);
      }),
    );
  });

  it("any amount other than the exact one is O2 on a non-partial milestone (and nothing else below the limits)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: USDC(20) }), (amount) => {
        const v = judgeRelease(instance(), honest({ amount }));
        expect(v.predicates.includes("O2")).toBe(amount !== USDC(10));
      }),
    );
  });

  it("windows: O4 holds exactly when the time is outside [start, end]", () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 10 }), (offset) => {
        const base = Date.parse(START) / 1000;
        const t = new Date((base + offset) * 1000).toISOString().replace(".000Z", "Z");
        expect(O4(instance(), honest({ time: t })) !== null).toBe(offset < 0);
      }),
    );
  });

  it("RECEIVED precedes NOW in the fixtures (sanity for the discount tests)", () => {
    expect(Date.parse(RECEIVED)).toBeLessThan(Date.parse(NOW));
  });
});
