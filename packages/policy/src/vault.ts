// Kernel policy vs on-chain vault (docs/04 K-12: "policy values must be <= vault values (checked at startup;
// mismatch => refuse to boot)"; docs/08 §4 POLICY_LOOSER_THAN_VAULT).
//
// The vault's limits are immutables (docs/06 A.3, contracts/src/SymbolonVault.sol): perTxCap, dailyCap
// (exact rolling 24 h), hourlyCap (0 = disabled), humanThreshold, tokenDecimals, RING_SIZE = 64 releases
// per rolling 24 h. Rules (a violation is reported for each):
//   DECIMALS_MISMATCH  currency.decimals != tokenDecimals (then no amount is compared: they would be meaningless)
//   PER_TX_CAP         caps.perTxHardCap      > perTxCap
//   DAILY_CAP          caps.dailyCap          > dailyCap
//   HOURLY_CAP         vault hourlyCap > 0 and (policy hourly cap off, or caps.hourlyCap > hourlyCap)
//   HUMAN_THRESHOLD    caps.humanApprovalAbove > humanThreshold
//   RELEASE_COUNT      velocity.maxReleasesPerDay > RING_SIZE
// "Off" is unlimited on both sides: a vault without an hourly cap accepts any policy hourly cap.
import * as z from "zod";
import { DecimalsSchema, MAX_UINT256, Uint256StringSchema } from "@symbolon/schemas";
import { formatPolicyAmount } from "./amounts";
import { PolicyError, failClosed, issuesFromZod } from "./errors";
import type { PolicyIssue } from "./errors";
import { normalizePolicy } from "./policy";
import type { LoadedPolicy } from "./policy";

export type DeploymentProfile = "production" | "sandbox";

/** docs/06 A.3 `RING_SIZE`; Deploy.s.sol reads it back and refuses anything else. */
export const VAULT_RING_SIZE = 64;
const MAX_UINT192 = (1n << 192n) - 1n;

export interface VaultConfig {
  readonly profile: DeploymentProfile;
  readonly tokenDecimals: number;
  readonly perTxCap: bigint;
  readonly dailyCap: bigint;
  /** 0n = disabled (vault convention). */
  readonly hourlyCap: bigint;
  readonly humanThreshold: bigint;
  readonly ringSize: number;
}

export interface VaultConfigInput {
  readonly profile: DeploymentProfile;
  readonly tokenDecimals: number;
  readonly perTxCap: bigint;
  readonly dailyCap: bigint;
  readonly hourlyCap: bigint;
  readonly humanThreshold: bigint;
  /** Defaults to VAULT_RING_SIZE; any other value is refused (only the 64-slot vault exists). */
  readonly ringSize?: number;
}

function vaultIssue(issues: PolicyIssue[], ok: boolean, path: string, message: string): void {
  if (!ok) issues.push({ path, message });
}

function isUint256(v: unknown): v is bigint {
  return typeof v === "bigint" && v >= 0n && v <= MAX_UINT256;
}

/**
 * Validate vault limits read from chain (viem returns bigint for uint256) or from a deployments file.
 * Mirrors the vault constructor: perTxCap > 0, dailyCap > 0, perTxCap fits uint192.
 */
export function makeVaultConfig(input: VaultConfigInput): VaultConfig {
  return failClosed(() => {
    const issues: PolicyIssue[] = [];
    const ringSize = input.ringSize ?? VAULT_RING_SIZE;
    vaultIssue(issues, input.profile === "production" || input.profile === "sandbox", "profile", "expected production or sandbox");
    vaultIssue(issues, DecimalsSchema.safeParse(input.tokenDecimals).success, "tokenDecimals", "expected an integer in [0, 255]");
    for (const key of ["perTxCap", "dailyCap", "hourlyCap", "humanThreshold"] as const) {
      vaultIssue(issues, isUint256(input[key]), key, "expected a bigint in [0, 2^256 - 1]");
    }
    vaultIssue(issues, !isUint256(input.perTxCap) || (input.perTxCap > 0n && input.perTxCap <= MAX_UINT192), "perTxCap", "must be > 0 and fit uint192 (vault constructor)");
    vaultIssue(issues, !isUint256(input.dailyCap) || input.dailyCap > 0n, "dailyCap", "must be > 0 (vault constructor)");
    vaultIssue(issues, ringSize === VAULT_RING_SIZE, "ringSize", `expected ${VAULT_RING_SIZE}`);
    if (issues.length > 0) throw new PolicyError("VAULT_CONFIG_INVALID", issues);
    return Object.freeze({
      profile: input.profile,
      tokenDecimals: input.tokenDecimals,
      perTxCap: input.perTxCap,
      dailyCap: input.dailyCap,
      hourlyCap: input.hourlyCap,
      humanThreshold: input.humanThreshold,
      ringSize,
    });
  }, "VAULT_CONFIG_INVALID");
}

// deployments/<network>.json as written by contracts/script/Deploy.s.sol (`symbolon-deployments/1`):
// money is decimal strings of base units; other fields (addresses, hashes, gitSha) are not policy's concern.
const DeploymentGroupSchema = z.object({
  tokenDecimals: DecimalsSchema,
  caps: z.strictObject({
    perTxCap: Uint256StringSchema,
    dailyCap: Uint256StringSchema,
    hourlyCap: Uint256StringSchema,
    humanThreshold: Uint256StringSchema,
  }),
});

const DeploymentsFileSchema = z.object({
  schema: z.literal("symbolon-deployments/1"),
  production: DeploymentGroupSchema.nullable(),
  sandbox: DeploymentGroupSchema.nullable(),
});

/** Read one profile's vault limits from a parsed `deployments/<network>.json` object. */
export function vaultConfigFromDeployments(deployments: unknown, profile: DeploymentProfile): VaultConfig {
  return failClosed(() => {
    const r = DeploymentsFileSchema.safeParse(deployments);
    if (!r.success) throw new PolicyError("VAULT_CONFIG_INVALID", issuesFromZod(r.error.issues));
    const group = profile === "sandbox" ? r.data.sandbox : r.data.production;
    if (group === null) {
      throw new PolicyError("VAULT_CONFIG_INVALID", [{ path: profile, message: `no ${profile} deployment in the file` }]);
    }
    return makeVaultConfig({
      profile,
      tokenDecimals: group.tokenDecimals,
      perTxCap: BigInt(group.caps.perTxCap),
      dailyCap: BigInt(group.caps.dailyCap),
      hourlyCap: BigInt(group.caps.hourlyCap),
      humanThreshold: BigInt(group.caps.humanThreshold),
    });
  }, "VAULT_CONFIG_INVALID");
}

export type VaultViolationCode =
  | "DECIMALS_MISMATCH"
  | "PER_TX_CAP"
  | "DAILY_CAP"
  | "HOURLY_CAP"
  | "HUMAN_THRESHOLD"
  | "RELEASE_COUNT";

export interface VaultViolation {
  readonly code: VaultViolationCode;
  readonly path: string;
  readonly policyValue: string;
  readonly vaultValue: string;
  readonly message: string;
}

/**
 * Every way `loaded` is looser than `vault`; empty means consistent. Fail closed on its inputs: the policy is
 * re-normalized from its JSON (a LoadedPolicy whose hash does not match its policy is refused, and the bigint
 * amounts used are the recomputed ones) and the vault config is re-validated. Throws PolicyError on invalid input.
 */
export function checkPolicyWithinVault(loaded: LoadedPolicy, vault: VaultConfig): readonly VaultViolation[] {
  return failClosed(() => {
    const policy = normalizePolicy(loaded.policy);
    if (policy.policyHash !== loaded.policyHash) {
      throw new PolicyError("POLICY_INVALID", [{ path: "$", message: "policyHash does not match the policy" }]);
    }
    const v = makeVaultConfig(vault);
    const d = policy.decimals;
    if (d !== v.tokenDecimals) {
      return [
        {
          code: "DECIMALS_MISMATCH",
          path: "currency.decimals",
          policyValue: String(d),
          vaultValue: String(v.tokenDecimals),
          message: `currency.decimals ${d} != vault tokenDecimals ${v.tokenDecimals} (V-04); amounts not compared`,
        },
      ];
    }
    const show = (units: bigint): string => `${formatPolicyAmount(units, d)} (${units} base units)`;
    const out: VaultViolation[] = [];
    const cmp = (code: VaultViolationCode, path: string, vaultName: string, p: bigint, limit: bigint): void => {
      if (p > limit) {
        out.push({
          code,
          path,
          policyValue: p.toString(),
          vaultValue: limit.toString(),
          message: `${path} ${show(p)} > vault ${vaultName} ${show(limit)}`,
        });
      }
    };
    const a = policy.amounts;
    cmp("PER_TX_CAP", "caps.perTxHardCap", "perTxCap", a.perTxHardCap, v.perTxCap);
    cmp("DAILY_CAP", "caps.dailyCap", "dailyCap", a.dailyCap, v.dailyCap);
    if (v.hourlyCap > 0n) {
      if (a.hourlyCap === 0n) {
        out.push({
          code: "HOURLY_CAP",
          path: "caps.hourlyCap",
          policyValue: "0",
          vaultValue: v.hourlyCap.toString(),
          message: `caps.hourlyCap is off but the vault enforces hourlyCap ${show(v.hourlyCap)}`,
        });
      } else {
        cmp("HOURLY_CAP", "caps.hourlyCap", "hourlyCap", a.hourlyCap, v.hourlyCap);
      }
    }
    cmp("HUMAN_THRESHOLD", "caps.humanApprovalAbove", "humanThreshold", a.humanApprovalAbove, v.humanThreshold);
    const releases = BigInt(policy.policy.velocity.maxReleasesPerDay);
    if (releases > BigInt(v.ringSize)) {
      out.push({
        code: "RELEASE_COUNT",
        path: "velocity.maxReleasesPerDay",
        policyValue: releases.toString(),
        vaultValue: String(v.ringSize),
        message: `velocity.maxReleasesPerDay ${releases} > vault RING_SIZE ${v.ringSize} releases per rolling 24 h`,
      });
    }
    return Object.freeze(out.map((x) => Object.freeze(x)));
  });
}

/** Refuse (throw POLICY_LOOSER_THAN_VAULT listing every violation) unless the policy is within the vault. */
export function assertPolicyWithinVault(loaded: LoadedPolicy, vault: VaultConfig): void {
  const violations = checkPolicyWithinVault(loaded, vault);
  if (violations.length > 0) {
    throw new PolicyError(
      "POLICY_LOOSER_THAN_VAULT",
      violations.map((x) => ({ path: x.path, message: `${x.code}: ${x.message}` })),
    );
  }
}
