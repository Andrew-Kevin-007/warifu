// Adapters over the PUBLIC exports of @symbolon/policy (WP-03). Real loader, real vault-config validation.
import { loadPolicy, makeVaultConfig } from "@symbolon/policy";
import { describe, expect, it } from "vitest";
import { BoundsError, boundT3c } from "../src/bounds";
import { compareLayers, inputsFromPolicy, inputsFromVault } from "../src/vault-inputs";

const M = 1_000_000n;
// docs/04 §7 shape, trimmed to the required keys (the full example lives in packages/policy tests)
const YAML = [
  "version: 1",
  "tenant: acme",
  "currency: { code: USDC, decimals: 6, treatUsdAsUsdc: true }",
  "caps:",
  '  perTxHardCap: "100"',
  '  dailyCap: "200"',
  '  hourlyCap: "25"',
  '  weeklyCap: "600"',
  '  humanApprovalAbove: "50"',
  "velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: \"150\" }",
  "categories: {}",
  "",
].join("\n");

const vault = (o: Partial<Parameters<typeof makeVaultConfig>[0]> = {}) =>
  makeVaultConfig({ profile: "sandbox", tokenDecimals: 6, perTxCap: 100n * M, dailyCap: 200n * M, hourlyCap: 0n, humanThreshold: 50n * M, ...o });

describe("inputsFromVault / inputsFromPolicy", () => {
  it("maps the on-chain limits one to one, with RING_SIZE 64", () => {
    expect(inputsFromVault(vault(), 300n * M, 150n * M)).toEqual({ B: 300n * M, P: 100n * M, D: 200n * M, H: 50n * M, hc: 0n, N: 64n, sumRemaining: 150n * M });
  });
  it("maps the kernel policy: humanApprovalAbove -> H, maxReleasesPerDay -> N, hourlyCap -> hc", () => {
    const loaded = loadPolicy(YAML);
    expect(inputsFromPolicy(loaded, 300n * M, 150n * M)).toEqual({ B: 300n * M, P: 100n * M, D: 200n * M, H: 50n * M, hc: 25n * M, N: 10n, sumRemaining: 150n * M });
  });
  it("feeds bounds.ts: vault without hourly cap vs policy with 25/h differ at 1 h exactly as computed by hand", () => {
    const loaded = loadPolicy(YAML);
    const B = 1000n * M;
    // vault: p* = 50, N = 64 -> d* = min(200, 3200) = 200 ; 1 min: min(1000, 200, 1000) = 200
    expect(boundT3c(inputsFromVault(vault(), B, B), 60n).value).toBe(200n * M);
    // policy: p* = 50, N = 10 -> d* = min(200, 500) = 200 ; hourly 25 -> 1 min: 25
    expect(boundT3c(inputsFromPolicy(loaded, B, B), 60n).value).toBe(25n * M);
  });
  it("a policy that allows zero releases per day is refused, not turned into a zero bound", () => {
    const loaded = loadPolicy(YAML);
    const broken = { ...loaded, policy: { ...loaded.policy, velocity: { ...loaded.policy.velocity, maxReleasesPerDay: 0 } } };
    expect(() => boundT3c(inputsFromPolicy(broken, 1n, 1n), 60n)).toThrow(BoundsError);
  });
});

describe("compareLayers", () => {
  it("returns both layers and no violations when the policy is within the vault", () => {
    const r = compareLayers(loadPolicy(YAML), vault({ hourlyCap: 25n * M }), 1000n * M, 1000n * M);
    expect(r.violations).toEqual([]);
    expect(r.vault.map((b) => b.label)).toEqual(["1m", "1h", "6h", "24h", "48h", "7d"]);
    expect(r.policy[0]?.value).toBe(25n * M);
    expect(r.vault[0]?.value).toBe(25n * M);
  });
  it("flags a policy looser than the vault (POLICY_LOOSER_THAN_VAULT class) and still reports both bounds", () => {
    const r = compareLayers(loadPolicy(YAML), vault({ perTxCap: 40n * M }), 1000n * M, 1000n * M);
    expect(r.violations.map((v) => v.code)).toContain("PER_TX_CAP");
    // vault (no hourly cap): p* = min(40, 50) = 40, d* = min(200, 64*40) = 200 -> 200 in a minute;
    // policy (hourly 25): 25. The layers differ by design and are reported side by side.
    expect(r.vault[0]?.value).toBe(200n * M);
    expect(r.policy[0]?.value).toBe(25n * M);
  });
  it("negative control: positive control without the looser perTxCap has no violation", () => {
    expect(compareLayers(loadPolicy(YAML), vault({ hourlyCap: 25n * M }), 10n, 10n).violations).toHaveLength(0);
  });
  it("a decimals mismatch is a violation, not silently compared", () => {
    const r = compareLayers(loadPolicy(YAML), vault({ tokenDecimals: 18, perTxCap: 100n * 10n ** 18n, dailyCap: 200n * 10n ** 18n, humanThreshold: 50n * 10n ** 18n }), 10n, 10n);
    expect(r.violations.map((v) => v.code)).toEqual(["DECIMALS_MISMATCH"]);
  });
});
