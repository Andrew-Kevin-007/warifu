// Adapters from the published shapes of @symbolon/policy (WP-03) to bounds.ts inputs. Public exports only.
//
// docs/08 §4: "T1 bound uses policy; T3 bound uses vault. The report shows both numbers side by side." and
// "Kernel policy values p_k <= vault values p_v, else the policy is decorative -> POLICY_LOOSER_THAN_VAULT".
//  - inputsFromVault:  the on-chain limits (immutables) are what holds when the kernel signer is stolen (T3c);
//  - inputsFromPolicy: the kernel-layer limits are what holds while the kernel is honest (what the policy
//    allows through if the agent or the evidence is fooled). It is a different layer, labelled as such.
// Balance and sumRemaining come from chain reads (the certificate, WP-34) or from the caller (what-if sliders).
import { checkPolicyWithinVault } from "@symbolon/policy";
import type { LoadedPolicy, VaultConfig, VaultViolation } from "@symbolon/policy";
import { boundsAtHorizons } from "./bounds";
import type { Bound, BoundInputs } from "./bounds";

export function inputsFromVault(vault: VaultConfig, balance: bigint, sumRemaining: bigint): BoundInputs {
  return Object.freeze({
    B: balance,
    P: vault.perTxCap,
    D: vault.dailyCap,
    H: vault.humanThreshold,
    hc: vault.hourlyCap,
    N: BigInt(vault.ringSize),
    sumRemaining,
  });
}

/** Kernel-layer limits: humanApprovalAbove plays the role of H and maxReleasesPerDay the role of the ring size. */
export function inputsFromPolicy(loaded: LoadedPolicy, balance: bigint, sumRemaining: bigint): BoundInputs {
  const a = loaded.amounts;
  return Object.freeze({
    B: balance,
    P: a.perTxHardCap,
    D: a.dailyCap,
    H: a.humanApprovalAbove,
    hc: a.hourlyCap,
    N: BigInt(loaded.policy.velocity.maxReleasesPerDay),
    sumRemaining,
  });
}

export interface LayerComparison {
  /** What stays true if the kernel signer is stolen: on-chain limits. */
  readonly vault: readonly (Bound & { readonly label: string })[];
  /** What the kernel policy would let through: kernel-layer limits (not a T3 number). */
  readonly policy: readonly (Bound & { readonly label: string })[];
  /** Empty when the policy is within the vault; otherwise POLICY_LOOSER_THAN_VAULT-class findings. */
  readonly violations: readonly VaultViolation[];
}

/** Both layers side by side (docs/08 §4). Throws if either side is malformed; never returns a partial answer. */
export function compareLayers(loaded: LoadedPolicy, vault: VaultConfig, balance: bigint, sumRemaining: bigint): LayerComparison {
  const violations = checkPolicyWithinVault(loaded, vault);
  return Object.freeze({
    vault: boundsAtHorizons(inputsFromVault(vault, balance, sumRemaining)),
    policy: boundsAtHorizons(inputsFromPolicy(loaded, balance, sumRemaining)),
    violations,
  });
}
