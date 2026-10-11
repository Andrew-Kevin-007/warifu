// Sandbox overrides (docs/15 §2 "small caps") validated against the sandbox vault and the sandbox profile limits.
import { describe, expect, it } from "vitest";
import { SANDBOX_LIMITS, applyPolicyOverrides, buildSandboxPolicy, loadPolicy } from "../src/index";
import { SPEC_YAML, USDC, expectPolicyError, prodVault, sandboxVault } from "./helpers";

const base = loadPolicy(SPEC_YAML); // production-scale: perTx 100, daily 200, hourly 25, human 50, maxDocChars 20000

/** The values the challenge scenarios run with (copied from packages/attack-suite/src/world.ts POLICY_OVERRIDES). */
const SCENARIO_OVERRIDES = {
  caps: { perTxHardCap: "25.000000", dailyCap: "60.000000", weeklyCap: "200.000000", humanApprovalAbove: "20.000000" },
  velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "60.000000" },
  newPayee: { firstPaymentMax: "25.000000", alwaysHuman: false },
  escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 },
  limits: { maxDocChars: 4096 },
};

describe("applyPolicyOverrides", () => {
  it("replaces only the keys an override names, section by section", () => {
    const p = applyPolicyOverrides(base, { caps: { perTxHardCap: "10" }, timing: { defaultNetDays: 15 } });
    expect(p.policy.caps).toEqual({ ...base.policy.caps, perTxHardCap: "10.000000" });
    expect(p.policy.timing).toEqual({ ...base.policy.timing, defaultNetDays: 15 });
    expect(p.policy.velocity).toEqual(base.policy.velocity);
    expect(p.policyHash).not.toBe(base.policyHash);
    expect(applyPolicyOverrides(base, {}).policyHash).toBe(base.policyHash); // control: no override, same policy
  });

  it("does not mutate the base policy", () => {
    applyPolicyOverrides(base, SCENARIO_OVERRIDES);
    expect(base.policy.caps.perTxHardCap).toBe("100.000000");
  });

  it("refuses overrides outside PolicyOverridesSchema, with an `overrides.` path", () => {
    expectPolicyError(() => applyPolicyOverrides(base, { tenant: "other" }), "SCHEMA_INVALID", "overrides.tenant");
    expectPolicyError(() => applyPolicyOverrides(base, { currency: { decimals: 18 } }), "SCHEMA_INVALID", "overrides.currency");
    expectPolicyError(() => applyPolicyOverrides(base, { caps: { perTxHardcap: "1" } }), "SCHEMA_INVALID", "overrides.caps.perTxHardcap");
    expectPolicyError(() => applyPolicyOverrides(base, { caps: { perTxHardCap: 25 } }), "SCHEMA_INVALID", "overrides.caps.perTxHardCap");
    // PolicyOverridesSchema (`.partial()`, frozen in packages/schemas) lets an explicit `undefined` through; the
    // merged policy is re-validated, so it is still refused (an override can never delete a key).
    expectPolicyError(() => applyPolicyOverrides(base, { caps: { hourlyCap: undefined } }), "SCHEMA_INVALID", "caps.hourlyCap");
    expectPolicyError(() => applyPolicyOverrides(base, { caps: { perTxHardCap: undefined } }), "SCHEMA_INVALID", "caps.perTxHardCap");
    for (const junk of [null, [], "x"]) expectPolicyError(() => applyPolicyOverrides(base, junk), "SCHEMA_INVALID");
  });

  it("refuses an override amount that would need rounding", () => {
    expectPolicyError(() => applyPolicyOverrides(base, { caps: { perTxHardCap: "1.0000001" } }), "POLICY_INVALID", "caps.perTxHardCap");
  });

  it("an override can turn the policy hourly cap off ('0'); the vault check is what catches it", () => {
    const off = applyPolicyOverrides(base, { caps: { hourlyCap: "0" } });
    expect(off.amounts.hourlyCap).toBe(0n);
    expect(off.policy.caps.hourlyCap).toBeUndefined();
  });
});

describe("buildSandboxPolicy", () => {
  it("accepts the challenge scenario overrides against a sandbox vault with the same caps", () => {
    const p = buildSandboxPolicy(base, SCENARIO_OVERRIDES, sandboxVault());
    expect(p.amounts).toMatchObject({ perTxHardCap: 25n * USDC, dailyCap: 60n * USDC, humanApprovalAbove: 20n * USDC, hourlyCap: 25n * USDC });
    expect(p.policy.limits.maxDocChars).toBe(4096);
    expect(p.policy.newPayee.alwaysHuman).toBe(false);
    expect(p.policyHash).not.toBe(base.policyHash);
  });

  it("refuses the production-scale base without overrides (profile limits)", () => {
    const err = expectPolicyError(() => buildSandboxPolicy(base, {}, sandboxVault()), "SANDBOX_LIMIT");
    expect(err.issues.map((i) => i.path).sort()).toEqual(["caps.dailyCap", "caps.perTxHardCap", "limits.maxDocChars"]);
  });

  it("each profile limit at its boundary", () => {
    const at = { ...SCENARIO_OVERRIDES, caps: { ...SCENARIO_OVERRIDES.caps } };
    expect(() => buildSandboxPolicy(base, at, sandboxVault())).not.toThrow();
    expectPolicyError(
      () => buildSandboxPolicy(base, { ...at, caps: { ...at.caps, perTxHardCap: "25.000001" } }, sandboxVault()),
      "SANDBOX_LIMIT",
      "caps.perTxHardCap",
    );
    expectPolicyError(
      () => buildSandboxPolicy(base, { ...at, caps: { ...at.caps, dailyCap: "60.000001" } }, sandboxVault()),
      "SANDBOX_LIMIT",
      "caps.dailyCap",
    );
    expectPolicyError(() => buildSandboxPolicy(base, { ...at, limits: { maxDocChars: 4097 } }, sandboxVault()), "SANDBOX_LIMIT", "limits.maxDocChars");
    expect(SANDBOX_LIMITS).toEqual({ perTxCapWhole: 25n, dailyCapWhole: 60n, maxDocChars: 4096 });
  });

  it("refuses a production vault (wrong deployment group), even one with small caps", () => {
    expectPolicyError(
      () => buildSandboxPolicy(base, SCENARIO_OVERRIDES, prodVault({ perTxCap: 25n * USDC, dailyCap: 60n * USDC, humanThreshold: 20n * USDC })),
      "SANDBOX_LIMIT",
      "vault.profile",
    );
  });

  it("refuses a sandbox vault above the sandbox profile limits", () => {
    expectPolicyError(() => buildSandboxPolicy(base, SCENARIO_OVERRIDES, sandboxVault({ perTxCap: 25n * USDC + 1n })), "SANDBOX_LIMIT", "vault.perTxCap");
    expectPolicyError(() => buildSandboxPolicy(base, SCENARIO_OVERRIDES, sandboxVault({ dailyCap: 60n * USDC + 1n })), "SANDBOX_LIMIT", "vault.dailyCap");
  });

  it("refuses a sandbox policy looser than a smaller sandbox vault", () => {
    const err = expectPolicyError(
      () => buildSandboxPolicy(base, SCENARIO_OVERRIDES, sandboxVault({ perTxCap: 10n * USDC, humanThreshold: 10n * USDC })),
      "POLICY_LOOSER_THAN_VAULT",
    );
    expect(err.issues.map((i) => i.path)).toEqual(["caps.perTxHardCap", "caps.humanApprovalAbove"]);
  });

  it("refuses a policy hourly cap turned off when the sandbox vault enforces one", () => {
    const over = { ...SCENARIO_OVERRIDES, caps: { ...SCENARIO_OVERRIDES.caps, hourlyCap: "0" } };
    expectPolicyError(() => buildSandboxPolicy(base, over, sandboxVault({ hourlyCap: 10n * USDC })), "POLICY_LOOSER_THAN_VAULT", "caps.hourlyCap");
    const within = { ...SCENARIO_OVERRIDES, caps: { ...SCENARIO_OVERRIDES.caps, hourlyCap: "10" } };
    expect(() => buildSandboxPolicy(base, within, sandboxVault({ hourlyCap: 10n * USDC }))).not.toThrow(); // control
  });

  it("refuses a sandbox vault whose token decimals differ from the policy", () => {
    expectPolicyError(
      () => buildSandboxPolicy(base, SCENARIO_OVERRIDES, sandboxVault({ tokenDecimals: 18, perTxCap: 25n * 10n ** 18n, dailyCap: 60n * 10n ** 18n, humanThreshold: 20n * 10n ** 18n })),
      "POLICY_LOOSER_THAN_VAULT",
      "currency.decimals",
    );
  });

  it("re-validates the vault object and fails closed on garbage", () => {
    expectPolicyError(() => buildSandboxPolicy(base, SCENARIO_OVERRIDES, { ...sandboxVault(), dailyCap: 0n }), "VAULT_CONFIG_INVALID", "dailyCap");
    expectPolicyError(() => buildSandboxPolicy(base, SCENARIO_OVERRIDES, null as unknown as ReturnType<typeof sandboxVault>), "VAULT_CONFIG_INVALID");
    expectPolicyError(() => buildSandboxPolicy(null as unknown as typeof base, SCENARIO_OVERRIDES, sandboxVault()), "INTERNAL");
  });
});
