// policyHash stability properties (WP-03 acceptance: "hash stable across key order"), 1,000 runs each.
// A random valid policy model is rendered to JSON with a chosen amount spelling; each property compares
// renderings that must (or must not) hash equally.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { formatPolicyAmount, loadPolicy, normalizePolicy } from "../src/index";
import { permuteKeys } from "./helpers";

const RUNS = { numRuns: 1000 };

const AMOUNT_PATHS = [
  "caps.perTxHardCap",
  "caps.dailyCap",
  "caps.weeklyCap",
  "caps.humanApprovalAbove",
  "velocity.maxAmountPerPayeePerDay",
  "newPayee.firstPaymentMax",
  "reserve.floor",
] as const;
type AmountPath = (typeof AMOUNT_PATHS)[number];

interface Model {
  readonly decimals: number;
  readonly amounts: Readonly<Record<AmountPath, bigint>>;
  readonly hourlyCap: bigint | undefined;
  readonly categories: ReadonlyArray<readonly [string, bigint]>;
  readonly rest: Record<string, unknown>;
}

const POOL = ["https://example.com", "https://*.example.org", "https://a-b.c-d.io", "https://edithstudio.vercel.app", "https://*.vercel.app", "https://api.example.net"];

const count = fc.integer({ min: 0, max: 1_000_000 });
const hours = fc.integer({ min: 0, max: 87_600 });

/** Optional section: absent, or present with any subset of its keys (the rest come from defaults). */
function section<T extends Record<string, fc.Arbitrary<unknown>>>(model: T) {
  return fc.option(fc.record(model, { requiredKeys: [] }), { nil: undefined });
}

// Arbitraries that do not depend on `decimals` are built once, outside `chain` (building a stringMatching
// arbitrary parses its regex; doing that per generated value made each run ~100x slower).
const categoryKeyArb = fc.stringMatching(/^[a-z0-9][a-z0-9_-]{0,8}$/);
const restArb = fc.record(
  {
    tenant: fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/),
    treatUsdAsUsdc: fc.boolean(),
    velocityCounts: fc.record({ maxReleasesPerDay: count, maxReleasesPerPayeePerDay: count }),
    alwaysHuman: fc.boolean(),
    lookaheadDays: fc.integer({ min: 0, max: 3650 }),
    timing: section({
      disputeWindowHours: hours,
      payBeforeDueBufferHours: hours,
      allowImmediate: fc.boolean(),
      defaultNetDays: fc.integer({ min: 0, max: 365 }),
      windowSafetyMarginMinutes: fc.integer({ min: 0, max: 525_600 }),
    }),
    treasury: section({ costOfCapitalBps: fc.integer({ min: 0, max: 1_000_000 }) }),
    escalation: section({ maxPerDay: count, maxPerEngagementPerDay: count }),
    limits: section({ maxDocChars: fc.integer({ min: 1, max: 20_000 }) }),
    evidence: section({
      freshnessHours: hours,
      allowOwnerOverride: fc.boolean(),
      urlAllowlist: fc.shuffledSubarray(POOL),
    }),
    extraction: section({ allowSingle: fc.boolean() }),
    screening: section({ required: fc.boolean(), staleAfterHours: hours }),
    reconciliation: section({
      ackWindowHours: fc.oneof(hours, fc.constantFrom(0.17, 0.5, 1.25, 12.75)),
    }),
  },
  { requiredKeys: ["tenant", "treatUsdAsUsdc", "velocityCounts", "alwaysHuman", "lookaheadDays"] },
);

const modelArb: fc.Arbitrary<Model> = fc.integer({ min: 0, max: 18 }).chain((decimals) => {
  const units = fc.bigInt({ min: 0n, max: 10n ** 12n * 10n ** BigInt(decimals) });
  return fc.record({
    decimals: fc.constant(decimals),
    amounts: fc.record({
      "caps.perTxHardCap": units,
      "caps.dailyCap": units,
      "caps.weeklyCap": units,
      "caps.humanApprovalAbove": units,
      "velocity.maxAmountPerPayeePerDay": units,
      "newPayee.firstPaymentMax": units,
      "reserve.floor": units,
    }),
    hourlyCap: fc.option(units, { nil: undefined }),
    categories: fc.uniqueArray(fc.tuple(categoryKeyArb, units), {
      maxLength: 5,
      selector: ([k]) => k,
    }),
    rest: restArb,
  });
});

/** One legal spelling of `units`: the canonical one with `k % (d + 1)` trailing zeros dropped. */
function spell(units: bigint, d: number, k: number): string {
  let s = formatPolicyAmount(units, d);
  for (let i = 0; i < k % (d + 1) && s.includes(".") && s.endsWith("0"); i++) s = s.slice(0, -1);
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function render(m: Model, seed: number): Record<string, unknown> {
  let k = seed;
  const next = (): number => {
    k = (k * 1103515245 + 12345) % 2147483648;
    return k;
  };
  const amt = (p: AmountPath): string => spell(m.amounts[p], m.decimals, next());
  const r = m.rest as {
    tenant: string;
    treatUsdAsUsdc: boolean;
    velocityCounts: { maxReleasesPerDay: number; maxReleasesPerPayeePerDay: number };
    alwaysHuman: boolean;
    lookaheadDays: number;
  } & Record<string, unknown>;
  const out: Record<string, unknown> = {
    version: 1,
    tenant: r.tenant,
    currency: { code: "USDC", decimals: m.decimals, treatUsdAsUsdc: r.treatUsdAsUsdc },
    caps: {
      perTxHardCap: amt("caps.perTxHardCap"),
      dailyCap: amt("caps.dailyCap"),
      weeklyCap: amt("caps.weeklyCap"),
      humanApprovalAbove: amt("caps.humanApprovalAbove"),
      ...(m.hourlyCap === undefined ? {} : { hourlyCap: spell(m.hourlyCap, m.decimals, next()) }),
    },
    velocity: { ...r.velocityCounts, maxAmountPerPayeePerDay: amt("velocity.maxAmountPerPayeePerDay") },
    newPayee: { alwaysHuman: r.alwaysHuman, firstPaymentMax: amt("newPayee.firstPaymentMax") },
    categories: Object.fromEntries(m.categories.map(([name, u]) => [name, spell(u, m.decimals, next())])),
    reserve: { floor: amt("reserve.floor"), lookaheadDays: r.lookaheadDays },
  };
  for (const s of ["timing", "treasury", "escalation", "limits", "evidence", "extraction", "screening", "reconciliation"]) {
    if (r[s] !== undefined) out[s] = structuredClone(r[s]);
  }
  return out;
}

function picker(seed: number): (n: number) => number {
  let k = seed >>> 0;
  return (n) => {
    k = (k * 1664525 + 1013904223) >>> 0;
    return k % n;
  };
}

describe("policyHash properties", () => {
  it("is stable across key order at every level (JSON input)", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (m, spellSeed, orderSeed) => {
        const p = render(m, spellSeed);
        expect(normalizePolicy(permuteKeys(p, picker(orderSeed))).policyHash).toBe(normalizePolicy(p).policyHash);
      }),
      RUNS,
    );
  });

  it("is stable across key order and between YAML and JSON input", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (m, spellSeed, orderSeed) => {
        const p = render(m, spellSeed);
        const yamlText = stringify(permuteKeys(p, picker(orderSeed)), { lineWidth: 0 });
        expect(loadPolicy(yamlText).policyHash).toBe(normalizePolicy(p).policyHash);
      }),
      RUNS,
    );
  });

  it("depends on amount values, not their spelling", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.nat(), (m, s1, s2) => {
        expect(normalizePolicy(render(m, s1)).policyHash).toBe(normalizePolicy(render(m, s2)).policyHash);
      }),
      RUNS,
    );
  });

  it("changes when any amount changes by one base unit (control for the equalities)", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), fc.constantFrom(...AMOUNT_PATHS), (m, seed, path) => {
        const bumped: Model = { ...m, amounts: { ...m.amounts, [path]: m.amounts[path] + 1n } };
        expect(normalizePolicy(render(bumped, seed)).policyHash).not.toBe(normalizePolicy(render(m, seed)).policyHash);
      }),
      RUNS,
    );
  });

  it("is idempotent, and the bigint amounts equal the model's base units", () => {
    fc.assert(
      fc.property(modelArb, fc.nat(), (m, seed) => {
        const loaded = normalizePolicy(render(m, seed));
        const again = normalizePolicy(loaded.policy);
        expect(again.policyHash).toBe(loaded.policyHash);
        expect(again.policy).toEqual(loaded.policy);
        expect(loaded.amounts.perTxHardCap).toBe(m.amounts["caps.perTxHardCap"]);
        expect(loaded.amounts.dailyCap).toBe(m.amounts["caps.dailyCap"]);
        expect(loaded.amounts.weeklyCap).toBe(m.amounts["caps.weeklyCap"]);
        expect(loaded.amounts.humanApprovalAbove).toBe(m.amounts["caps.humanApprovalAbove"]);
        expect(loaded.amounts.maxAmountPerPayeePerDay).toBe(m.amounts["velocity.maxAmountPerPayeePerDay"]);
        expect(loaded.amounts.firstPaymentMax).toBe(m.amounts["newPayee.firstPaymentMax"]);
        expect(loaded.amounts.reserveFloor).toBe(m.amounts["reserve.floor"]);
        expect(loaded.amounts.hourlyCap).toBe(m.hourlyCap ?? 0n);
        for (const [name, u] of m.categories) expect(loaded.amounts.categories[name]).toBe(u);
      }),
      RUNS,
    );
  });
});
