// ATK-17: the kernel signer key is compromised. These are CONTRACT-LEVEL steps: the attacker signs
// attestations directly and calls the vault, bypassing the kernel entirely, so the only thing between the
// attacker and the money is the vault (docs/06 release() order). Residual loss is bounded by the Blast Radius
// T3 bound (docs/08); this fixture feeds that analysis. Arguments are symbolic: the harness resolves names to
// the deployed sandbox vault's addresses and ids, and signs with the throwaway sandbox signer key.
import { honestControl, intendedRelease, PER_TX_CAP } from "../build";
import type { AttackFixture, VaultCallStep } from "../types";
import { ATTACKER, CLOCK_START, WORLD, usdc } from "../world";
import { assemble, type BuildCtx } from "./common";

const T0 = CLOCK_START;

function call(label: string, args: VaultCallStep["args"], expectRevert: string | null, note?: string): VaultCallStep {
  return {
    kind: "vault-call",
    stepId: `ATK-17/${label}`,
    label,
    actor: "compromised-kernel-signer",
    call: "release",
    args: { freshInstance: true, ...args },
    expectRevert,
    ...(note === undefined ? {} : { expectRevertNote: note }),
  };
}

export function atk17({ rng, seed }: BuildCtx): AttackFixture {
  const w = WORLD["S-B"]; // cap 28, so a 22.00 release passes every cap and meets only the human threshold (20)
  const tenUsdc = usdc(10).toString();
  const steps: VaultCallStep[] = [
    // (a) pay somewhere the owner and payee never agreed to
    call("a1", { engagement: "S-B", milestone: "api", payee: "ATTACKER", amountBaseUnits: tenUsdc }, "PayeeMismatch"),
    call("a2", { engagement: "UNREGISTERED", milestone: "api", payee: "ATTACKER", amountBaseUnits: tenUsdc }, "NoEngagement"),
    // (b) the registered payee, above the engagement cap (28.00): 10 + 18 are released, then one more USDC
    call(
      "b",
      {
        engagement: "S-B",
        preReleases: [
          { milestone: "api", amountBaseUnits: tenUsdc },
          { milestone: "deploy", amountBaseUnits: usdc(18).toString() },
        ],
        milestone: "deploy",
        payee: "REGISTERED",
        amountBaseUnits: usdc(1).toString(),
      },
      "EngagementCap",
    ),
    // (c) per-transaction cap, then the rolling daily cap across the three engagements
    call("c1", { engagement: "S-B", milestone: "deploy", payee: "REGISTERED", amountBaseUnits: (PER_TX_CAP + 1n).toString() }, "PerTxCap"),
    call(
      "c2",
      {
        preReleases: [
          { engagement: "S-A", milestone: "concept", amountBaseUnits: usdc(8).toString() },
          { engagement: "S-A", milestone: "final", amountBaseUnits: usdc(12).toString() },
          { engagement: "S-B", milestone: "api", amountBaseUnits: tenUsdc },
          { engagement: "S-B", milestone: "deploy", amountBaseUnits: usdc(18).toString() },
        ],
        engagement: "S-C",
        milestone: "annual-licence",
        payee: "REGISTERED",
        amountBaseUnits: usdc(20).toString(),
      },
      "DailyCap",
      "48.00 already released in 24 h; a further 20.00 passes the per-tx and engagement caps but exceeds the 60.00 daily cap",
    ),
    // (d) reuse an intentId
    call("d", { engagement: "S-B", preReleases: [{ milestone: "api", amountBaseUnits: tenUsdc, intentLabel: "I1" }], reuseIntent: "I1", milestone: "api", payee: "REGISTERED", amountBaseUnits: tenUsdc }, "AlreadyUsed"),
    // (e) above the human threshold (20.00) with no owner approval at all
    call("e", { engagement: "S-B", milestone: "deploy", payee: "REGISTERED", amountBaseUnits: usdc(22).toString(), ownerApproval: null }, "ApprovalRequired"),
    // (f) create a new payee: registerEngagement needs the owner's and the payee's signatures
    {
      kind: "vault-call",
      stepId: "ATK-17/f",
      label: "f",
      actor: "compromised-kernel-signer",
      call: "registerEngagement",
      args: { freshInstance: true, payee: "ATTACKER", capBaseUnits: usdc(100).toString(), ownerSig: null, payeeSig: null },
      expectRevert: null,
      expectRevertNote: "must revert: the kernel signer cannot create a payee without the owner's and the payee's signatures (INV-2/INV-7). The custom error name is defined by the vault (WP-07); the harness asserts a revert and records the name.",
    },
  ];
  const releases = [
    intendedRelease("ATK-17/a1", w, null, ATTACKER, usdc(10), T0, T0),
    intendedRelease("ATK-17/b", w, null, w.payee, usdc(1), T0, T0, ["O5"]),
    intendedRelease("ATK-17/c1", w, null, w.payee, PER_TX_CAP + 1n, T0, T0),
    intendedRelease("ATK-17/c2", WORLD["S-C"], null, WORLD["S-C"].payee, usdc(20), T0, T0, ["O5"]),
    intendedRelease("ATK-17/d", w, null, w.payee, usdc(10), T0, T0, ["O3"]),
    intendedRelease("ATK-17/e", w, null, w.payee, usdc(22), T0, T0, ["O5"]),
  ];
  return assemble({
    attackId: "ATK-17",
    seed,
    scenarioId: "S-B",
    steps,
    intendedLoss: { mode: "each", releases },
    control: honestControl(rng, w, "api", T0, "ATK-17/control"),
    tags: ["signer-compromise", "contract-level", "vault", "blast-radius-T3"],
  });
}
