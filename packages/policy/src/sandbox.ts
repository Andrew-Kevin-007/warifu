// Sandbox (challenge) policy: base policy + scenario overrides (docs/15 §2 `ChallengeScenario.policy`,
// "small caps, e.g. perTx 25, daily 60"), validated against the SANDBOX vault (INV-16).
//
// Overrides may move a value in either direction (the scenarios set `newPayee.alwaysHuman: false`), so the
// guarantee does not come from "overrides only tighten" but from the result: the effective sandbox policy must
// be within the sandbox profile limits AND within the sandbox vault, and that vault must itself be a sandbox
// deployment within the same limits (so passing a production vault by mistake is refused).
import { PolicyOverridesSchema } from "@symbolon/schemas";
import type { PolicyOverrides } from "@symbolon/schemas";
import { formatPolicyAmount } from "./amounts";
import { PolicyError, failClosed, issuesFromZod } from "./errors";
import type { PolicyIssue } from "./errors";
import { normalizePolicy } from "./policy";
import type { LoadedPolicy } from "./policy";
import { assertPolicyWithinVault, makeVaultConfig } from "./vault";
import type { VaultConfig } from "./vault";

/**
 * Sandbox profile limits. Caps in whole tokens, as enforced at deploy by contracts/script/Deploy.s.sol
 * (`checkLimits`: sandbox perTx <= 25, daily <= 60); document text per docs/04 K-01 / §7 (challenge 4096).
 */
export const SANDBOX_LIMITS = Object.freeze({ perTxCapWhole: 25n, dailyCapWhole: 60n, maxDocChars: 4096 });

/** Apply validated overrides section by section (keys present in an override replace the base's). */
export function applyPolicyOverrides(base: LoadedPolicy, overrides: unknown): LoadedPolicy {
  return failClosed(() => {
    const r = PolicyOverridesSchema.safeParse(overrides);
    if (!r.success) throw new PolicyError("SCHEMA_INVALID", issuesFromZod(r.error.issues, "overrides"));
    const merged: Record<string, unknown> = structuredClone(base.policy) as unknown as Record<string, unknown>;
    const o: PolicyOverrides = r.data;
    for (const [section, values] of Object.entries(o)) {
      merged[section] = { ...(merged[section] as Record<string, unknown>), ...values };
    }
    return normalizePolicy(merged);
  });
}

function limitIssue(issues: PolicyIssue[], ok: boolean, path: string, message: string): void {
  if (!ok) issues.push({ path, message });
}

/**
 * Effective sandbox policy = base + overrides, refused (SANDBOX_LIMIT or POLICY_LOOSER_THAN_VAULT) unless
 * the vault is a sandbox deployment within SANDBOX_LIMITS and the policy is within both the limits and the vault.
 */
export function buildSandboxPolicy(base: LoadedPolicy, overrides: unknown, sandboxVault: VaultConfig): LoadedPolicy {
  return failClosed(() => {
    const vault = makeVaultConfig(sandboxVault);
    const issues: PolicyIssue[] = [];
    limitIssue(issues, vault.profile === "sandbox", "vault.profile", `expected a sandbox vault, got ${vault.profile}`);
    const vaultUnit = 10n ** BigInt(vault.tokenDecimals);
    const maxPerTxVault = SANDBOX_LIMITS.perTxCapWhole * vaultUnit;
    const maxDailyVault = SANDBOX_LIMITS.dailyCapWhole * vaultUnit;
    limitIssue(issues, vault.perTxCap <= maxPerTxVault, "vault.perTxCap", `sandbox vault perTxCap must be <= ${SANDBOX_LIMITS.perTxCapWhole} tokens`);
    limitIssue(issues, vault.dailyCap <= maxDailyVault, "vault.dailyCap", `sandbox vault dailyCap must be <= ${SANDBOX_LIMITS.dailyCapWhole} tokens`);

    const policy = applyPolicyOverrides(base, overrides);
    const d = policy.decimals;
    const unit = 10n ** BigInt(d);
    const maxPerTx = SANDBOX_LIMITS.perTxCapWhole * unit;
    const maxDaily = SANDBOX_LIMITS.dailyCapWhole * unit;
    limitIssue(issues, policy.amounts.perTxHardCap <= maxPerTx, "caps.perTxHardCap", `sandbox perTxHardCap must be <= ${formatPolicyAmount(maxPerTx, d)}`);
    limitIssue(issues, policy.amounts.dailyCap <= maxDaily, "caps.dailyCap", `sandbox dailyCap must be <= ${formatPolicyAmount(maxDaily, d)}`);
    limitIssue(
      issues,
      policy.policy.limits.maxDocChars <= SANDBOX_LIMITS.maxDocChars,
      "limits.maxDocChars",
      `sandbox maxDocChars must be <= ${SANDBOX_LIMITS.maxDocChars}`,
    );
    if (issues.length > 0) throw new PolicyError("SANDBOX_LIMIT", issues);
    assertPolicyWithinVault(policy, vault);
    return policy;
  });
}
