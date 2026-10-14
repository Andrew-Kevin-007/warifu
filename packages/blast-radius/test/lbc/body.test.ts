// Certificate body: hand-computed golden values (docs/16 §10 test 1 at certificate level) and digest tests (test 3).
import { describe, expect, it } from "vitest";
import { computeBody } from "../../src/lbc/body";
import { computeConfigHash, computeEngagementsDigest, deriveEngagementInputs } from "../../src/lbc/digest";
import { LbcError } from "../../src/lbc/types";
import type { EngagementState } from "../../src/lbc/types";
import { PAYEE, SIGNER2, T0, USDC, VAULT, engagement, exampleState, h32, headerAt, makeState } from "./helpers/fake-chain";

const OPTS = { vault: VAULT, chainId: 31337n, detectionLatencySeconds: 300 } as const;
const header = headerAt(100n);

describe("computeBody: the docs/16 §3 worked example, computed by hand", () => {
  // B=200, P=100, D=200, H=50, hc=0, N=64. Counted engagements: a (100-20=80), b (50), c (30-10=20) -> sumRemaining 150;
  // `closed` is inactive and `ended` ended before the block, so neither counts. p* = min(100,50) = 50; d* = min(200, 64*50) = 200.
  const body = computeBody(exampleState(), header, OPTS);
  it("inputs", () => {
    expect(body.inputs.sumRemainingBaseUnits).toBe("150000000");
    expect(body.inputs.activeEngagements).toBe(3);
    expect(body.inputs.balanceBaseUnits).toBe("200000000");
    expect(body.inputs.limits).toEqual({ perTxCap: "100000000", dailyCap: "200000000", hourlyCap: "0", humanThreshold: "50000000", ringSize: 64 });
  });
  it("every horizon is min(200, 200*ceil(t/day), 150) = 150 and engagements alone bind", () => {
    expect(body.bounds.T3c.perReleaseUnapproved).toBe("50000000");
    expect(body.bounds.T3c.perDay).toBe("200000000");
    expect(body.bounds.T3c.horizons.map((h) => [h.label, h.seconds, h.value, h.binding])).toEqual([
      ["1m", 60, "150000000", ["engagements"]],
      ["1h", 3600, "150000000", ["engagements"]],
      ["6h", 21600, "150000000", ["engagements"]],
      ["24h", 86400, "150000000", ["engagements"]],
      ["48h", 172800, "150000000", ["engagements"]],
      ["7d", 604800, "150000000", ["engagements"]],
    ]);
  });
  it("time to empty = ceil(min(200,150)/200) = 1 day, limited by engagements; alarmed 300 s = 150; T1/T2", () => {
    expect(body.bounds.T3c.timeToEmpty).toEqual({ days: 1, limitedBy: "engagements" });
    expect(body.bounds.T3c.alarmed).toEqual({ seconds: 300, value: "150000000", assumes: ["A-MON"] });
    expect(body.bounds.T1).toEqual({ unauthorizedLoss: "0", assumes: ["A-EVID"], weakEvidenceExposure: "NOT_COMPUTED" });
    expect(body.bounds.T2).toEqual({ loss: "0", liveness: "censorable" });
    expect(body.bounds.T3_ownerExposed).toEqual(body.bounds.T3c.horizons);
  });
});

describe("computeBody: other hand-computed shapes", () => {
  it("balance binds when B < sumRemaining and B < d*: 1m..7d all equal B, binding balance", () => {
    // B=40, P=100, D=200, H=50 -> d*=200; sumRemaining = 80 -> min(40, 200, 80) = 40
    const s = makeState({ balance: 40n * USDC, engagements: [engagement("x", { cap: 80n * USDC })] });
    const b = computeBody(s, header, OPTS).bounds.T3c;
    expect(b.horizons.every((h) => h.value === "40000000" && h.binding.length === 1 && h.binding[0] === "balance")).toBe(true);
    expect(b.timeToEmpty).toEqual({ days: 1, limitedBy: "balance" });
  });
  it("daily binds and grows by one daily cap per 24 h: P=H=30, D=50, B=ΣR=1000 -> 1m..24h = 50, 48h = 100, 7d = 350", () => {
    const s = makeState({ perTxCap: 30n * USDC, dailyCap: 50n * USDC, humanThreshold: 30n * USDC, balance: 1000n * USDC, engagements: [engagement("x", { cap: 1000n * USDC })] });
    const h = computeBody(s, header, OPTS).bounds.T3c.horizons.map((x) => x.value);
    expect(h).toEqual(["50000000", "50000000", "50000000", "50000000", "100000000", "350000000"]);
    // d* = min(50, 64*30) = 50; ceil(172800/86400)=2; ceil(604800/86400)=7. TTE = ceil(1000/50) = 20 days.
    expect(computeBody(s, header, OPTS).bounds.T3c.timeToEmpty).toEqual({ days: 20, limitedBy: "balance" });
  });
  it("N*p* < D: 64 releases of p*=1 USDC cap the day at 64 even though D=1000", () => {
    const s = makeState({ perTxCap: 1n * USDC, dailyCap: 1000n * USDC, humanThreshold: 1n * USDC, balance: 1000n * USDC, engagements: [engagement("x", { cap: 1000n * USDC })] });
    expect(computeBody(s, header, OPTS).bounds.T3c.perDay).toBe("64000000");
  });
  it("an hourly cap tightens the short horizons: hc=25 -> 1m=25, 1h=25, 6h=150, 24h=min(200,600)=200 limited by... daily", () => {
    const s = makeState({ hourlyCap: 25n * USDC, balance: 1000n * USDC, engagements: [engagement("x", { cap: 1000n * USDC })] });
    const hz = computeBody(s, header, OPTS).bounds.T3c.horizons;
    expect(hz.map((x) => x.value)).toEqual(["25000000", "25000000", "150000000", "200000000", "400000000", "1000000000"]);
    expect(hz[0]!.binding).toEqual(["hourly"]);
    // 24h: hc*24 = 600 vs d*=200 -> daily; 7d: min(B=1000, ΣR=1000, daily 1400, hourly 4200) = 1000 tied balance+engagements
    expect(hz[3]!.binding).toEqual(["daily"]);
    expect(hz[5]!.binding).toEqual(["balance", "engagements"]);
  });
  it("H=0 means every release needs the owner: nothing can leave without them, all bounds 0, timeToEmpty days null", () => {
    const s = makeState({ humanThreshold: 0n, engagements: [engagement("x")] });
    const b = computeBody(s, header, OPTS).bounds.T3c;
    expect(b.horizons.every((h) => h.value === "0")).toBe(true);
    expect(b.timeToEmpty.days).toBeNull();
  });
  it("zero engagements: sumRemaining 0 and every bound 0 (the minimum is the engagements term)", () => {
    const body = computeBody(makeState(), header, OPTS);
    expect(body.inputs.sumRemainingBaseUnits).toBe("0");
    expect(body.bounds.T3c.horizons.every((h) => h.value === "0" && h.binding.includes("engagements"))).toBe(true);
  });
  it("an engagement starting in the future still counts (no start filter), one ending exactly at the block timestamp counts, one a second earlier does not", () => {
    const s = makeState({
      engagements: [
        engagement("future", { start: T0 + 99_999n, cap: 10n * USDC }),
        engagement("edge", { end: header.timestamp, cap: 20n * USDC }),
        engagement("gone", { end: header.timestamp - 1n, cap: 40n * USDC }),
      ],
    });
    expect(computeBody(s, header, OPTS).inputs.sumRemainingBaseUnits).toBe("30000000");
  });
  it("values beyond 2^53 stay exact decimal strings", () => {
    const big = 10n ** 30n;
    const s = makeState({ perTxCap: big, dailyCap: big, humanThreshold: big, balance: big, engagements: [engagement("x", { cap: big })] });
    expect(computeBody(s, header, OPTS).bounds.T3c.horizons[3]!.value).toBe(big.toString());
  });
});

describe("computeBody refuses states no vault can have (fail closed)", () => {
  const refuses = (s: ReturnType<typeof makeState>, code: string): void => {
    try {
      computeBody(s, header, OPTS);
    } catch (e) {
      expect(e).toBeInstanceOf(LbcError);
      expect((e as LbcError).code).toBe(code);
      return;
    }
    throw new Error("expected a refusal");
  };
  it("perTxCap 0, dailyCap 0", () => {
    refuses(makeState({ perTxCap: 0n }), "INVALID_STATE");
    refuses(makeState({ dailyCap: 0n }), "INVALID_STATE");
  });
  it("released > cap", () => refuses(makeState({ engagements: [engagement("x", { released: 101n * USDC })] }), "INVALID_STATE"));
  it("vault tokenDecimals differs from token.decimals()", () => refuses(makeState({ tokenContractDecimals: 18 }), "INVALID_STATE"));
  it("configHash view disagrees with the getters", () => refuses({ ...makeState(), configHash: h32("lie") }, "CONFIG_HASH_INCONSISTENT"));
  it("state read at a different block than the header", () => refuses(makeState({ blockNumber: 99n }), "INVALID_STATE"));
  it("duplicate engagement ids", () => {
    const e = engagement("dup");
    expect(() => computeEngagementsDigest([e, { ...e }])).toThrow(LbcError);
  });
});

describe("configHash", () => {
  it("is keccak256(abi.encode(...)) of the getters and changes with every field", () => {
    const s = makeState();
    const h = computeConfigHash(s);
    const variants: Partial<typeof s>[] = [
      { owner: SIGNER2 }, { kernelSigner: SIGNER2 }, { guardian: SIGNER2 }, { token: SIGNER2 }, { tokenDecimals: 18, tokenContractDecimals: 18 },
      { perTxCap: s.perTxCap + 1n }, { dailyCap: s.dailyCap + 1n }, { hourlyCap: 1n }, { humanThreshold: 1n }, { payeeChangeDelay: 1n }, { signerChangeDelay: 1n },
    ];
    for (const v of variants) expect(computeConfigHash({ ...s, ...v })).not.toBe(h);
  });
});

describe("engagementsDigest (docs/16 §10 test 3)", () => {
  const a = engagement("a");
  const b = engagement("b");
  const d = (list: EngagementState[]) => computeEngagementsDigest(list);
  it("is independent of registration order", () => expect(d([a, b])).toBe(d([b, a])));
  it("is unchanged by `released`", () => expect(d([a, b])).toBe(d([{ ...a, released: 5n * USDC }, b])));
  it("changes with payee, cap, start, end, termsHash and active", () => {
    const base = d([a, b]);
    for (const change of [{ payee: SIGNER2 }, { cap: a.cap + 1n }, { start: a.start + 1n }, { end: a.end + 1n }, { termsHash: h32("other") }, { active: false }, { id: h32("other-id") }]) {
      expect(d([{ ...a, ...change }, b]), JSON.stringify(Object.keys(change))).not.toBe(base);
    }
  });
  it("changes when an engagement is added or removed", () => {
    expect(d([a])).not.toBe(d([a, b]));
    expect(d([])).not.toBe(d([a]));
  });
  it("deriveEngagementInputs matches the hand sum and ignores released only through the digest", () => {
    const r = deriveEngagementInputs([a, { ...b, released: 40n * USDC }, engagement("c", { active: false })], { timestamp: T0 });
    expect(r.sumRemaining).toBe(100n * USDC + 60n * USDC);
    expect(r.activeEngagements).toBe(2);
    expect(PAYEE).toBeTruthy();
  });
});
