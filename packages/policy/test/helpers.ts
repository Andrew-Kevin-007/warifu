// Shared test helpers for @symbolon/policy (not a test file: vitest only runs *.test.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { PolicyError, makeVaultConfig } from "../src/index";
import type { PolicyErrorCode, VaultConfig, VaultConfigInput } from "../src/index";

/** docs/04 §7 policy.yaml, extracted verbatim from the spec. */
export const SPEC_YAML = readFileSync(fileURLToPath(new URL("./fixtures/spec-04-section7.yaml", import.meta.url)), "utf8");

/** The same policy as SPEC_YAML, as a JSON object (key order as in the spec). */
export function specJson(): Record<string, unknown> {
  return {
    version: 1,
    tenant: "edith-studio",
    currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
    caps: {
      perTxHardCap: "100.000000",
      dailyCap: "200.000000",
      hourlyCap: "25.000000",
      weeklyCap: "600.000000",
      humanApprovalAbove: "50.000000",
    },
    velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "150.000000" },
    newPayee: { firstPaymentMax: "25.000000", alwaysHuman: true },
    categories: { design: "150.000000", dev: "300.000000", tools: "100.000000" },
    reserve: { floor: "10.000000", lookaheadDays: 14 },
    timing: {
      disputeWindowHours: 0,
      payBeforeDueBufferHours: 24,
      allowImmediate: true,
      defaultNetDays: 30,
      windowSafetyMarginMinutes: 60,
    },
    treasury: { costOfCapitalBps: 0 },
    escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 },
    limits: { maxDocChars: 20000 },
    evidence: {
      freshnessHours: 72,
      allowOwnerOverride: true,
      urlAllowlist: ["https://*.vercel.app", "https://edithstudio.vercel.app"],
    },
    extraction: { allowSingle: false },
    screening: { required: false, staleAfterHours: 24 },
    reconciliation: { ackWindowHours: 72 },
  };
}

/** The smallest policy the loader accepts: only the keys without defaults. */
export function minimalJson(): Record<string, unknown> {
  return {
    version: 1,
    tenant: "acme",
    currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
    caps: { perTxHardCap: "100", dailyCap: "200", weeklyCap: "600", humanApprovalAbove: "50" },
    categories: {},
  };
}

export const MINIMAL_YAML = [
  "version: 1",
  "tenant: acme",
  "currency: { code: USDC, decimals: 6, treatUsdAsUsdc: true }",
  "caps:",
  '  perTxHardCap: "100"',
  '  dailyCap: "200"',
  '  weeklyCap: "600"',
  '  humanApprovalAbove: "50"',
  "categories: {}",
  "",
].join("\n");

export function expectPolicyError(fn: () => unknown, code: PolicyErrorCode, pathPart?: string): PolicyError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected a PolicyError ${code}`).toBeInstanceOf(PolicyError);
  const err = caught as PolicyError;
  expect(err.code, err.message).toBe(code);
  if (pathPart !== undefined) {
    expect(
      err.issues.some((i) => i.path.includes(pathPart)),
      `no issue at a path containing "${pathPart}": ${JSON.stringify(err.issues)}`,
    ).toBe(true);
  }
  return err;
}

export const USDC = 1_000_000n;

/** Production vault matching the spec policy exactly at its limits (perTx 100, daily 200, human 50, no hourly). */
export function prodVault(over: Partial<VaultConfigInput> = {}): VaultConfig {
  return makeVaultConfig({
    profile: "production",
    tokenDecimals: 6,
    perTxCap: 100n * USDC,
    dailyCap: 200n * USDC,
    hourlyCap: 0n,
    humanThreshold: 50n * USDC,
    ...over,
  });
}

/** Sandbox vault as the challenge scenarios need it (QUESTIONS WP-22 item 4: perTx 25, daily 60, human 20). */
export function sandboxVault(over: Partial<VaultConfigInput> = {}): VaultConfig {
  return makeVaultConfig({
    profile: "sandbox",
    tokenDecimals: 6,
    perTxCap: 25n * USDC,
    dailyCap: 60n * USDC,
    hourlyCap: 0n,
    humanThreshold: 20n * USDC,
    ...over,
  });
}

/** Deep copy with object keys re-inserted in a permuted order (arrays keep their order). */
export function permuteKeys(value: unknown, pick: (n: number) => number): unknown {
  if (Array.isArray(value)) return value.map((v) => permuteKeys(v, pick));
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const order: string[] = [];
    while (keys.length > 0) order.push(keys.splice(pick(keys.length), 1)[0] as string);
    const out: Record<string, unknown> = {};
    for (const k of order) out[k] = permuteKeys((value as Record<string, unknown>)[k], pick);
    return out;
  }
  return value;
}

export function clone<T>(v: T): T {
  return structuredClone(v);
}

/** String made of one code unit, built from a number so test sources stay ASCII. */
export function ch(code: number): string {
  return String.fromCharCode(code);
}
