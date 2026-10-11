// @symbolon/policy (owner: KERNEL-CORE, WP-03): load policy.yaml safely, validate it against the frozen
// PolicySchema (packages/schemas), apply docs/04 §7 defaults, convert amounts to bigint base units (INV-10),
// compute policyHash = keccak256(JCS(canonical policy)) and refuse a policy looser than its vault (K-12).
// Pure: no I/O, clock, randomness or env; the caller reads files and chain state and passes them in.
export const PACKAGE_NAME = "@symbolon/policy" as const;

export { PolicyError } from "./errors";
export type { PolicyErrorCode, PolicyIssue } from "./errors";
export { formatPolicyAmount, parsePolicyAmount } from "./amounts";
export { MAX_POLICY_DEPTH, MAX_POLICY_SOURCE_CHARS, parseStrictYaml } from "./yaml";
export type { JsonValue } from "./yaml";
export {
  POLICY_DEFAULTS,
  REQUIRED_POLICY_KEYS,
  applyPolicyDefaults,
  categoryBudget,
  loadPolicy,
  normalizePolicy,
  policyHash,
} from "./policy";
export type { LoadedPolicy, PolicyAmounts } from "./policy";
export {
  VAULT_RING_SIZE,
  assertPolicyWithinVault,
  checkPolicyWithinVault,
  makeVaultConfig,
  vaultConfigFromDeployments,
} from "./vault";
export type { DeploymentProfile, VaultConfig, VaultConfigInput, VaultViolation, VaultViolationCode } from "./vault";
export { SANDBOX_LIMITS, applyPolicyOverrides, buildSandboxPolicy } from "./sandbox";
