// Policy vs vault (docs/04 K-12, docs/08 §4 POLICY_LOOSER_THAN_VAULT). Each rule is tested at the boundary:
// equal passes (positive control), one base unit looser fails. A reference model checks the rule set as a whole.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_UINT256 } from "@symbolon/schemas";
import {
  VAULT_RING_SIZE,
  assertPolicyWithinVault,
  checkPolicyWithinVault,
  loadPolicy,
  makeVaultConfig,
  normalizePolicy,
  vaultConfigFromDeployments,
} from "../src/index";
import type { LoadedPolicy, VaultConfigInput, VaultViolationCode } from "../src/index";
import { SPEC_YAML, USDC, clone, expectPolicyError, prodVault, sandboxVault, specJson } from "./helpers";

const spec = loadPolicy(SPEC_YAML); // perTx 100, daily 200, hourly 25, human 50, maxReleasesPerDay 10

function codes(p: LoadedPolicy, over: Partial<VaultConfigInput> = {}): VaultViolationCode[] {
  return checkPolicyWithinVault(p, prodVault(over)).map((v) => v.code);
}

function policyWith(mut: (j: Record<string, unknown>) => void): LoadedPolicy {
  const j = specJson();
  mut(j);
  return normalizePolicy(j);
}

describe("checkPolicyWithinVault: each rule at its boundary", () => {
  it("control: the spec policy is within a vault with exactly its limits", () => {
    expect(codes(spec)).toEqual([]);
    expect(() => assertPolicyWithinVault(spec, prodVault())).not.toThrow();
  });

  it("PER_TX_CAP: perTxHardCap must be <= vault perTxCap", () => {
    expect(codes(spec, { perTxCap: 100n * USDC })).toEqual([]);
    expect(codes(spec, { perTxCap: 100n * USDC - 1n })).toEqual(["PER_TX_CAP"]);
  });

  it("DAILY_CAP: dailyCap must be <= vault dailyCap", () => {
    expect(codes(spec, { dailyCap: 200n * USDC })).toEqual([]);
    expect(codes(spec, { dailyCap: 200n * USDC - 1n })).toEqual(["DAILY_CAP"]);
  });

  it("HUMAN_THRESHOLD: humanApprovalAbove must be <= vault humanThreshold", () => {
    expect(codes(spec, { humanThreshold: 50n * USDC })).toEqual([]);
    expect(codes(spec, { humanThreshold: 50n * USDC - 1n })).toEqual(["HUMAN_THRESHOLD"]);
  });

  it("HOURLY_CAP: both on => policy <= vault", () => {
    expect(codes(spec, { hourlyCap: 25n * USDC })).toEqual([]);
    expect(codes(spec, { hourlyCap: 25n * USDC - 1n })).toEqual(["HOURLY_CAP"]);
  });

  it("HOURLY_CAP: vault on and policy off is looser (the kernel would sign what the vault reverts)", () => {
    const off = policyWith((j) => delete (j["caps"] as Record<string, unknown>)["hourlyCap"]);
    expect(off.amounts.hourlyCap).toBe(0n);
    const v = checkPolicyWithinVault(off, prodVault({ hourlyCap: 25n * USDC }));
    expect(v.map((x) => x.code)).toEqual(["HOURLY_CAP"]);
    expect(v[0]?.message).toContain("off");
  });

  it("HOURLY_CAP: a vault without an hourly cap accepts any policy hourly cap, or none", () => {
    expect(codes(spec, { hourlyCap: 0n })).toEqual([]);
    const off = policyWith((j) => delete (j["caps"] as Record<string, unknown>)["hourlyCap"]);
    expect(codes(off, { hourlyCap: 0n })).toEqual([]);
    const huge = policyWith((j) => ((j["caps"] as Record<string, unknown>)["hourlyCap"] = "1000000"));
    expect(codes(huge, { hourlyCap: 0n })).toEqual([]);
  });

  it(`RELEASE_COUNT: velocity.maxReleasesPerDay must be <= RING_SIZE (${VAULT_RING_SIZE})`, () => {
    const at = policyWith((j) => ((j["velocity"] as Record<string, unknown>)["maxReleasesPerDay"] = 64));
    const over = policyWith((j) => ((j["velocity"] as Record<string, unknown>)["maxReleasesPerDay"] = 65));
    expect(codes(at)).toEqual([]);
    expect(codes(over)).toEqual(["RELEASE_COUNT"]);
  });

  it("DECIMALS_MISMATCH: reported alone, amounts are not compared", () => {
    const v = checkPolicyWithinVault(spec, prodVault({ tokenDecimals: 18, perTxCap: 1n, dailyCap: 1n }));
    expect(v.map((x) => x.code)).toEqual(["DECIMALS_MISMATCH"]);
    expect(v[0]).toMatchObject({ path: "currency.decimals", policyValue: "6", vaultValue: "18" });
  });

  it("reports every violation together, with values in base units and readable messages", () => {
    const v = checkPolicyWithinVault(spec, prodVault({ perTxCap: 10n * USDC, dailyCap: 20n * USDC, hourlyCap: 5n * USDC, humanThreshold: 1n }));
    expect(v.map((x) => x.code)).toEqual(["PER_TX_CAP", "DAILY_CAP", "HOURLY_CAP", "HUMAN_THRESHOLD"]);
    expect(v[0]).toMatchObject({ path: "caps.perTxHardCap", policyValue: "100000000", vaultValue: "10000000" });
    expect(v[0]?.message).toBe("caps.perTxHardCap 100.000000 (100000000 base units) > vault perTxCap 10.000000 (10000000 base units)");
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v[0])).toBe(true);
  });
});

describe("assertPolicyWithinVault", () => {
  it("throws POLICY_LOOSER_THAN_VAULT listing every violation", () => {
    const err = expectPolicyError(
      () => assertPolicyWithinVault(spec, prodVault({ perTxCap: 10n * USDC, humanThreshold: 1n })),
      "POLICY_LOOSER_THAN_VAULT",
    );
    expect(err.issues.map((i) => i.path)).toEqual(["caps.perTxHardCap", "caps.humanApprovalAbove"]);
    expect(err.issues[0]?.message.startsWith("PER_TX_CAP:")).toBe(true);
  });

  it("refuses a LoadedPolicy whose hash does not match its policy", () => {
    const forged = { ...spec, policyHash: `0x${"00".repeat(32)}` } as LoadedPolicy;
    expectPolicyError(() => assertPolicyWithinVault(forged, prodVault()), "POLICY_INVALID");
  });

  it("ignores tampered bigint amounts: compares the amounts recomputed from the policy JSON", () => {
    const tampered = { ...spec, amounts: { ...spec.amounts, perTxHardCap: 1n } } as LoadedPolicy;
    expect(checkPolicyWithinVault(tampered, prodVault({ perTxCap: 10n * USDC })).map((v) => v.code)).toEqual(["PER_TX_CAP"]);
  });

  it("refuses a policy JSON edited after loading (old hash, smaller caps)", () => {
    const edited = clone(specJson());
    (edited["caps"] as Record<string, unknown>)["perTxHardCap"] = "1";
    const forged = { ...spec, policy: edited } as unknown as LoadedPolicy;
    expectPolicyError(() => checkPolicyWithinVault(forged, prodVault()), "POLICY_INVALID");
  });

  it("refuses a hand-built vault object that skips validation", () => {
    const bogus = { ...prodVault(), perTxCap: 100 } as unknown as ReturnType<typeof prodVault>;
    expectPolicyError(() => checkPolicyWithinVault(spec, bogus), "VAULT_CONFIG_INVALID", "perTxCap");
  });

  it("fails closed on garbage inputs", () => {
    expectPolicyError(() => checkPolicyWithinVault(null as unknown as LoadedPolicy, prodVault()), "INTERNAL");
    expectPolicyError(() => checkPolicyWithinVault(spec, null as unknown as ReturnType<typeof prodVault>), "VAULT_CONFIG_INVALID");
  });
});

describe("makeVaultConfig", () => {
  const base: VaultConfigInput = {
    profile: "production",
    tokenDecimals: 6,
    perTxCap: 100n * USDC,
    dailyCap: 200n * USDC,
    hourlyCap: 0n,
    humanThreshold: 50n * USDC,
  };

  it("accepts valid limits, defaults ringSize to 64 and freezes the result", () => {
    const v = makeVaultConfig(base);
    expect(v.ringSize).toBe(64);
    expect(Object.isFrozen(v)).toBe(true);
    expect(makeVaultConfig({ ...base, ringSize: 64 })).toEqual(v);
    expect(makeVaultConfig({ ...base, profile: "sandbox" }).profile).toBe("sandbox");
    expect(makeVaultConfig({ ...base, perTxCap: (1n << 192n) - 1n, dailyCap: MAX_UINT256, humanThreshold: MAX_UINT256 }).dailyCap).toBe(MAX_UINT256);
  });

  const bad: Array<[string, Partial<Record<keyof VaultConfigInput, unknown>>, string]> = [
    ["unknown profile", { profile: "prod" }, "profile"],
    ["decimals above 255", { tokenDecimals: 256 }, "tokenDecimals"],
    ["negative decimals", { tokenDecimals: -1 }, "tokenDecimals"],
    ["fractional decimals", { tokenDecimals: 1.5 }, "tokenDecimals"],
    ["cap as a number", { perTxCap: 100 }, "perTxCap"],
    ["cap as a string", { dailyCap: "200" }, "dailyCap"],
    ["negative cap", { hourlyCap: -1n }, "hourlyCap"],
    ["cap above uint256", { humanThreshold: MAX_UINT256 + 1n }, "humanThreshold"],
    ["zero perTxCap (constructor refuses it)", { perTxCap: 0n }, "perTxCap"],
    ["perTxCap above uint192", { perTxCap: 1n << 192n }, "perTxCap"],
    ["zero dailyCap", { dailyCap: 0n }, "dailyCap"],
    ["ring size other than 64", { ringSize: 65 }, "ringSize"],
  ];
  for (const [name, over, path] of bad) {
    it(`refuses ${name}`, () => {
      expectPolicyError(() => makeVaultConfig({ ...base, ...over } as VaultConfigInput), "VAULT_CONFIG_INVALID", path);
    });
  }
  it("refuses null input", () => {
    expectPolicyError(() => makeVaultConfig(null as unknown as VaultConfigInput), "VAULT_CONFIG_INVALID");
  });
});

describe("vaultConfigFromDeployments (deployments/<network>.json from Deploy.s.sol)", () => {
  // Shape written by contracts/script/Deploy.s.sol writeDeployment(); addresses are placeholders.
  const group = (perTx: string, daily: string, hourly: string, human: string) => ({
    vault: "0x0000000000000000000000000000000000000001",
    token: "0x0000000000000000000000000000000000000002",
    tokenDecimals: 6,
    owner: "0x0000000000000000000000000000000000000003",
    kernelSigner: "0x0000000000000000000000000000000000000004",
    guardian: "0x0000000000000000000000000000000000000005",
    caps: { perTxCap: perTx, dailyCap: daily, hourlyCap: hourly, humanThreshold: human },
    payeeChangeDelay: 172800,
    signerChangeDelay: 86400,
    deployer: "0x0000000000000000000000000000000000000006",
    chainId: 5042002,
    configHash: `0x${"ab".repeat(32)}`,
    runtimeCodeHash: `0x${"cd".repeat(32)}`,
    artifactPath: "contracts/out/SymbolonVault.sol/SymbolonVault.json",
    gitSha: "dabe055",
  });
  const file = () => ({
    schema: "symbolon-deployments/1",
    network: "testnet",
    chainId: 5042002,
    production: group("100000000", "200000000", "0", "50000000"),
    sandbox: group("25000000", "60000000", "0", "20000000"),
  });

  it("reads each profile's limits as bigint", () => {
    expect(vaultConfigFromDeployments(file(), "production")).toEqual(prodVault());
    expect(vaultConfigFromDeployments(file(), "sandbox")).toEqual(sandboxVault());
    expect(() => assertPolicyWithinVault(spec, vaultConfigFromDeployments(file(), "production"))).not.toThrow();
  });

  it("refuses a missing (null) group", () => {
    expectPolicyError(() => vaultConfigFromDeployments({ ...file(), sandbox: null }, "sandbox"), "VAULT_CONFIG_INVALID", "sandbox");
    expectPolicyError(() => vaultConfigFromDeployments({ ...file(), production: null }, "production"), "VAULT_CONFIG_INVALID", "production");
  });

  it("refuses malformed files", () => {
    const f1 = { ...file(), schema: "symbolon-deployments/2" };
    expectPolicyError(() => vaultConfigFromDeployments(f1, "production"), "VAULT_CONFIG_INVALID", "schema");
    const f2 = file();
    (f2.production.caps as Record<string, unknown>)["perTxCap"] = 100000000;
    expectPolicyError(() => vaultConfigFromDeployments(f2, "production"), "VAULT_CONFIG_INVALID", "production.caps.perTxCap");
    const f3 = file();
    (f3.production.caps as Record<string, unknown>)["extra"] = "1";
    expectPolicyError(() => vaultConfigFromDeployments(f3, "production"), "VAULT_CONFIG_INVALID", "production.caps.extra");
    const f4 = file();
    f4.production.caps.dailyCap = "0200000000";
    expectPolicyError(() => vaultConfigFromDeployments(f4, "production"), "VAULT_CONFIG_INVALID", "production.caps.dailyCap");
    const f5 = file();
    f5.sandbox.caps.perTxCap = "0";
    expectPolicyError(() => vaultConfigFromDeployments(f5, "sandbox"), "VAULT_CONFIG_INVALID", "perTxCap");
    for (const junk of [null, [], "x", 5]) expectPolicyError(() => vaultConfigFromDeployments(junk, "production"), "VAULT_CONFIG_INVALID", "$");
  });
});

describe("reference model (1,000 runs): violations == exactly the rules where the policy is looser", () => {
  it("matches an independent restatement of docs/04 K-12 + docs/06 A.3", () => {
    const u = fc.bigInt({ min: 0n, max: 500n * USDC });
    fc.assert(
      fc.property(
        fc.record({ perTx: u, daily: u, hourly: fc.option(u, { nil: undefined }), human: u, releases: fc.integer({ min: 0, max: 200 }) }),
        fc.record({ perTx: fc.bigInt({ min: 1n, max: 500n * USDC }), daily: fc.bigInt({ min: 1n, max: 500n * USDC }), hourly: u, human: u }),
        (p, v) => {
          const j = specJson();
          const caps = j["caps"] as Record<string, unknown>;
          caps["perTxHardCap"] = (p.perTx / USDC).toString() + "." + (p.perTx % USDC).toString().padStart(6, "0");
          caps["dailyCap"] = (p.daily / USDC).toString() + "." + (p.daily % USDC).toString().padStart(6, "0");
          caps["humanApprovalAbove"] = (p.human / USDC).toString() + "." + (p.human % USDC).toString().padStart(6, "0");
          if (p.hourly === undefined) delete caps["hourlyCap"];
          else caps["hourlyCap"] = (p.hourly / USDC).toString() + "." + (p.hourly % USDC).toString().padStart(6, "0");
          (j["velocity"] as Record<string, unknown>)["maxReleasesPerDay"] = p.releases;
          const loaded = normalizePolicy(j);
          const got = checkPolicyWithinVault(loaded, prodVault({ perTxCap: v.perTx, dailyCap: v.daily, hourlyCap: v.hourly, humanThreshold: v.human })).map((x) => x.code);

          const policyHourly = p.hourly ?? 0n; // "0" and absent both mean off
          const expected: VaultViolationCode[] = [];
          if (p.perTx > v.perTx) expected.push("PER_TX_CAP");
          if (p.daily > v.daily) expected.push("DAILY_CAP");
          if (v.hourly !== 0n && (policyHourly === 0n || policyHourly > v.hourly)) expected.push("HOURLY_CAP");
          if (p.human > v.human) expected.push("HUMAN_THRESHOLD");
          if (p.releases > 64) expected.push("RELEASE_COUNT");
          expect(got).toEqual(expected);
          // assert agrees with check
          if (expected.length === 0) expect(() => assertPolicyWithinVault(loaded, prodVault({ perTxCap: v.perTx, dailyCap: v.daily, hourlyCap: v.hourly, humanThreshold: v.human }))).not.toThrow();
        },
      ),
      { numRuns: 1000 },
    );
  }, 120_000); // a few seconds normally; coverage instrumentation is several times slower
});
