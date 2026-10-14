// The computed part of a certificate: subject, asOf, inputs, bounds. ONE function, used by build (to write them) and by
// verify (to recompute them and compare), so the two cannot drift (docs/16 §1.5, INV-18). Pure: a VaultState and a block
// header in, strings and numbers out. Every anomaly throws LbcError: a certificate is never produced from state no vault
// can have, and a smaller number is never substituted for a failure (docs/16 §1.2).
import type { Address, LossBoundCertificate } from "@symbolon/schemas";
import { BoundsError, boundAlarmed, boundsAtHorizons, perDay, perReleaseUnapproved, timeToEmpty } from "../bounds";
import type { Bound, BoundInputs, Term } from "../bounds";
import { computeConfigHash, computeEngagementsDigest, deriveEngagementInputs } from "./digest";
import { computeWeakEvidenceExposure } from "./terms";
import type { ParsedTerms, WeakEvidenceResult } from "./terms";
import { LbcError } from "./types";
import type { BlockHeader, EngagementState, VaultState } from "./types";

type Cert = LossBoundCertificate;
export type Horizon = Cert["bounds"]["T3c"]["horizons"][number];

export interface BodyOptions {
  readonly vault: Address;
  readonly chainId: bigint;
  readonly detectionLatencySeconds: number;
  /** parsed engagement-terms documents; undefined = not supplied (weak-evidence exposure is then NOT_COMPUTED) */
  readonly terms?: readonly ParsedTerms[] | undefined;
}

export interface Body {
  readonly subject: Cert["subject"];
  readonly asOf: Cert["asOf"];
  /** `inputs` WITHOUT policyHash (that comes from an off-chain file); policyHash is set to null here */
  readonly inputs: Cert["inputs"];
  readonly bounds: Cert["bounds"];
  /** the exact inputs handed to bounds.ts */
  readonly boundInputs: BoundInputs;
  readonly alarmedBinding: readonly Term[];
  readonly counted: readonly EngagementState[];
  readonly weakEvidence: WeakEvidenceResult | null;
}

function safeNumber(v: bigint, what: string): number {
  if (v < 0n || v > BigInt(Number.MAX_SAFE_INTEGER)) throw new LbcError("VALUE_OUT_OF_RANGE", `${what} does not fit a safe integer`);
  return Number(v);
}

/** The `bounds` section from the inputs handed to bounds.ts. Shared by build, verify and the latest-with-digest-equality mode. */
export function computeBounds(inputs: BoundInputs, detectionLatencySeconds: number, weakEvidenceExposure: string): { bounds: Cert["bounds"]; alarmedBinding: readonly Term[] } {
  const horizons: Horizon[] = boundsAtHorizons(inputs).map((b) => ({
    label: b.label as Horizon["label"],
    seconds: safeNumber(b.horizonSeconds, "horizon"),
    value: b.value.toString(),
    binding: [...b.binding],
  }));
  const alarmed: Bound = boundAlarmed(inputs, BigInt(detectionLatencySeconds));
  const tte = timeToEmpty(inputs);
  return {
    alarmedBinding: alarmed.binding,
    bounds: {
      T1: { unauthorizedLoss: "0", assumes: ["A-EVID"], weakEvidenceExposure },
      T2: { loss: "0", liveness: "censorable" },
      T3c: {
        perReleaseUnapproved: perReleaseUnapproved(inputs).toString(),
        perDay: perDay(inputs).toString(),
        horizons,
        timeToEmpty: { days: tte.days === null ? null : safeNumber(tte.days, "timeToEmpty.days"), limitedBy: tte.limitedBy },
        alarmed: { seconds: detectionLatencySeconds, value: alarmed.value.toString(), assumes: ["A-MON"] },
      },
      T3_ownerExposed: horizons.map((h) => ({ ...h, binding: [...h.binding] })),
    },
  };
}

/** Cross-checks that make a VaultState trustworthy enough to compute from. */
export function assertVaultState(state: VaultState, header: BlockHeader): void {
  if (state.blockNumber !== header.number) throw new LbcError("INVALID_STATE", "vault state was read at a different block than the header");
  if (state.tokenDecimals !== state.tokenContractDecimals) {
    throw new LbcError("INVALID_STATE", "the vault's tokenDecimals differs from token.decimals() (V-04)");
  }
  if (computeConfigHash(state).toLowerCase() !== state.configHash.toLowerCase()) {
    throw new LbcError("CONFIG_HASH_INCONSISTENT", "the vault's getters do not hash to its own configHash()");
  }
}

export function computeBody(state: VaultState, header: BlockHeader, o: BodyOptions): Body {
  assertVaultState(state, header);
  if (o.chainId < 1n || o.chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new LbcError("INVALID_STATE", "chain id out of range");
  if (!Number.isSafeInteger(o.detectionLatencySeconds) || o.detectionLatencySeconds < 0) throw new LbcError("INVALID_OPTION", "detectionLatencySeconds must be a non-negative safe integer");

  const derived = deriveEngagementInputs(state.engagements, header);
  const inputs: BoundInputs = {
    B: state.balance,
    P: state.perTxCap,
    D: state.dailyCap,
    H: state.humanThreshold,
    hc: state.hourlyCap,
    N: state.ringSize,
    sumRemaining: derived.sumRemaining,
  };

  try {
    const weak = o.terms === undefined ? null : computeWeakEvidenceExposure(derived.counted, o.terms);
    const { bounds, alarmedBinding } = computeBounds(inputs, o.detectionLatencySeconds, weak === null ? "NOT_COMPUTED" : weak.total.toString());
    const body: Body = {
      subject: { vault: o.vault, chainId: safeNumber(o.chainId, "chainId"), token: state.token, tokenDecimals: state.tokenDecimals },
      asOf: { blockNumber: safeNumber(header.number, "block number"), blockHash: header.hash, timestamp: safeNumber(header.timestamp, "block timestamp") },
      inputs: {
        configHash: state.configHash.toLowerCase() as Cert["inputs"]["configHash"],
        engagementsDigest: computeEngagementsDigest(state.engagements),
        policyHash: null,
        balanceBaseUnits: state.balance.toString(),
        limits: {
          perTxCap: state.perTxCap.toString(),
          dailyCap: state.dailyCap.toString(),
          hourlyCap: state.hourlyCap.toString(),
          humanThreshold: state.humanThreshold.toString(),
          ringSize: safeNumber(state.ringSize, "ringSize"),
        },
        sumRemainingBaseUnits: derived.sumRemaining.toString(),
        activeEngagements: derived.activeEngagements,
      },
      bounds,
      boundInputs: inputs,
      alarmedBinding,
      counted: derived.counted,
      weakEvidence: weak,
    };
    return body;
  } catch (e) {
    if (e instanceof BoundsError) throw new LbcError("INVALID_STATE", `the chain state is not a vault state the closed form accepts (${e.code})`, { cause: e });
    throw e;
  }
}
