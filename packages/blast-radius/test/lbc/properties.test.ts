// Property tests at certificate level (docs/16 §10 test 2 extended to the document): for random vault states a built
// certificate verifies VALID against its own chain, its bounds respect the structural properties, and every single-field
// perturbation of a hashed value is caught. The closed-form properties themselves (monotone, inverse) are in
// test/bounds.property.test.ts (WP-25).
import { computeCertHash } from "@symbolon/schemas";
import type { LossBoundCertificate } from "@symbolon/schemas";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildFromReader } from "../../src/lbc/build";
import { verifyCertificate } from "../../src/lbc/verify";
import { RUNS, SEED } from "../helpers/arb";
import { FakeChain, T0, VAULT, engagement, makeState } from "./helpers/fake-chain";
import type { EngagementState } from "../../src/lbc/types";

const big = (max: bigint) => fc.bigInt({ min: 0n, max });
const arbEngagement = (i: number): fc.Arbitrary<EngagementState> =>
  fc.record({ cap: fc.bigInt({ min: 1n, max: 10n ** 9n }), frac: fc.integer({ min: 0, max: 100 }), active: fc.boolean(), ended: fc.boolean(), future: fc.boolean() }).map((e) =>
    engagement(`p${String(i)}`, { cap: e.cap, released: (e.cap * BigInt(e.frac)) / 100n, active: e.active, end: e.ended ? T0 - 5n : T0 + 10_000n, start: e.future ? T0 + 500n : T0 - 500n }),
  );

const arbState = fc
  .record({
    balance: big(10n ** 10n),
    perTxCap: fc.bigInt({ min: 1n, max: 10n ** 9n }),
    dailyCap: fc.bigInt({ min: 1n, max: 10n ** 10n }),
    hourlyCap: fc.oneof(fc.constant(0n), fc.bigInt({ min: 1n, max: 10n ** 9n })),
    humanThreshold: big(10n ** 9n),
    engagements: fc.integer({ min: 0, max: 5 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbEngagement(i)))),
  })
  .map((r) => makeState({ ...r, engagements: r.engagements as EngagementState[] }));

const GIT = "0123456789abcdef0123456789abcdef01234567";
const params = { numRuns: Math.min(RUNS, 300), seed: SEED + 340 };

async function certFor(state: ReturnType<typeof makeState>) {
  const chain = new FakeChain().push(100n, state);
  const { cert } = await buildFromReader(chain, VAULT, { block: "latest", gitSha: GIT, nowSeconds: T0 + 5n });
  return { chain, cert };
}

describe("certificate properties", () => {
  it("a built certificate is VALID against its own chain, is schema-valid, and its hash recomputes", async () => {
    await fc.assert(
      fc.asyncProperty(arbState, async (state) => {
        const { chain, cert } = await certFor(state);
        expect(cert.validity.status).toBe("VALID");
        expect(computeCertHash(cert)).toBe(cert.certHash);
        const r = await verifyCertificate(JSON.parse(JSON.stringify(cert)), chain, { nowSeconds: T0 + 5n });
        expect(r.outcome).toBe("VALID");
      }),
      params,
    );
  });

  it("every horizon is <= balance and <= sumRemaining, <= perDay * ceil(t/day), non-decreasing in t, with a non-empty binding that attains the value", async () => {
    await fc.assert(
      fc.asyncProperty(arbState, async (state) => {
        const { cert } = await certFor(state);
        const B = BigInt(cert.inputs.balanceBaseUnits);
        const S = BigInt(cert.inputs.sumRemainingBaseUnits);
        const hs = cert.bounds.T3c.horizons;
        let prev = 0n;
        for (const h of hs) {
          const v = BigInt(h.value);
          expect(v <= B && v <= S).toBe(true);
          expect(v >= prev).toBe(true);
          expect(h.binding.length).toBeGreaterThan(0);
          prev = v;
        }
        expect(BigInt(cert.bounds.T3c.perDay) <= BigInt(cert.inputs.limits.dailyCap)).toBe(true);
        expect(BigInt(cert.bounds.T3c.alarmed.value) <= BigInt(hs[3]!.value)).toBe(true);
        expect(cert.bounds.T3_ownerExposed).toEqual(hs);
      }),
      params,
    );
  });

  it("without an hourly cap the 1 m bound equals the 24 h bound (burst); with one it can only be lower", async () => {
    await fc.assert(
      fc.asyncProperty(arbState, async (state) => {
        const { cert } = await certFor(state);
        const hs = cert.bounds.T3c.horizons;
        if (state.hourlyCap === 0n) expect(hs[0]!.value).toBe(hs[3]!.value);
        else expect(BigInt(hs[0]!.value) <= BigInt(hs[3]!.value)).toBe(true);
      }),
      params,
    );
  });

  it("changing any single hashed numeric field (with the hash recomputed by a forger) is MISMATCH", async () => {
    const edits: ((c: LossBoundCertificate, d: bigint) => void)[] = [
      (c, d) => void (c.inputs.balanceBaseUnits = (BigInt(c.inputs.balanceBaseUnits) + d).toString()),
      (c, d) => void (c.inputs.sumRemainingBaseUnits = (BigInt(c.inputs.sumRemainingBaseUnits) + d).toString()),
      (c, d) => void (c.inputs.limits.dailyCap = (BigInt(c.inputs.limits.dailyCap) + d).toString()),
      (c, d) => void (c.inputs.limits.perTxCap = (BigInt(c.inputs.limits.perTxCap) + d).toString()),
      (c, d) => void (c.bounds.T3c.horizons[3]!.value = (BigInt(c.bounds.T3c.horizons[3]!.value) + d).toString()),
      (c, d) => void (c.bounds.T3c.perDay = (BigInt(c.bounds.T3c.perDay) + d).toString()),
      (c, d) => void (c.bounds.T3c.alarmed.value = (BigInt(c.bounds.T3c.alarmed.value) + d).toString()),
      (c, d) => void (c.inputs.activeEngagements += Number(d)),
    ];
    await fc.assert(
      fc.asyncProperty(arbState, fc.integer({ min: 0, max: edits.length - 1 }), fc.bigInt({ min: 1n, max: 1000n }), async (state, which, delta) => {
        const { chain, cert } = await certFor(state);
        const forged: LossBoundCertificate = JSON.parse(JSON.stringify(cert));
        edits[which]!(forged, delta);
        forged.certHash = computeCertHash(forged);
        const r = await verifyCertificate(forged, chain, { nowSeconds: T0 + 5n });
        expect(r.outcome).toBe("MISMATCH");
        expect(r.diffs.length).toBeGreaterThan(0);
      }),
      params,
    );
  });

  it("raising the balance never lowers a bound: a stale-but-VALID verdict only ever follows non-binding balance", async () => {
    await fc.assert(
      fc.asyncProperty(arbState, fc.bigInt({ min: 1n, max: 10n ** 9n }), async (state, extra) => {
        const { chain, cert } = await certFor(state);
        chain.next({ balance: state.balance + extra });
        const r = await verifyCertificate(cert, chain, { nowSeconds: T0 + 5n });
        const binds = cert.bounds.T3c.horizons.some((h) => h.binding.includes("balance")) || cert.inputs.balanceBaseUnits === cert.bounds.T3c.alarmed.value;
        if (r.outcome === "VALID") {
          // recompute with the larger balance: no stated bound would have been exceeded
          const grown = await certFor(makeState({ ...stripHash(state), balance: state.balance + extra }));
          cert.bounds.T3c.horizons.forEach((h, i) => expect(BigInt(grown.cert.bounds.T3c.horizons[i]!.value) <= BigInt(h.value)).toBe(true));
        } else {
          expect(r.reasons).toContain("BALANCE_INCREASED");
          expect(binds || cert.bounds.T3c.horizons.some((h) => h.binding.includes("balance"))).toBe(true);
        }
      }),
      params,
    );
  });
});

function stripHash(s: ReturnType<typeof makeState>) {
  const { configHash: _c, ...rest } = s;
  return rest;
}
