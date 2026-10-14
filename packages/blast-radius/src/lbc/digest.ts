// Digests and derived inputs of a Loss Bound Certificate (docs/16 §2.1, §2.4, §3). Pure: no I/O, no clock.
//
// configHash        keccak256(abi.encode(token, tokenDecimals, owner, kernelSigner, guardian, perTxCap, dailyCap,
//                   hourlyCap, humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)), exactly the vault's
//                   `configHash()`. We recompute it from the getters and compare: a vault whose getters and hash
//                   disagree is not a vault we know.
// engagementsDigest keccak256(UTF-8(JCS([...engagements sorted by id...]))) where each element is
//                   { id, payee, cap, start, end, termsHash, active } and
//                   - id, payee, termsHash are lowercase 0x-hex strings,
//                   - cap, start, end are canonical decimal strings (base units / epoch seconds),
//                   - active is a boolean.
//                   `released` is EXCLUDED on purpose: payments only tighten the bound (docs/16 §3, §5.2).
//                   The exact form is fixed here and in docs/QUESTIONS.md (WP-34) so an independent implementation
//                   (reference.py, WP-29) can reproduce it.
import { hashJcs } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import { encodeAbiParameters, keccak256 } from "viem";
import { LbcError } from "./types";
import type { BlockHeader, EngagementState, VaultState } from "./types";

const CONFIG_PARAMS = [
  { type: "address" },
  { type: "uint8" },
  { type: "address" },
  { type: "address" },
  { type: "address" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint256" },
  { type: "uint32" },
  { type: "uint32" },
  { type: "uint8" },
] as const;

/** The vault's `configHash()` recomputed from its public getters. */
export function computeConfigHash(s: Pick<VaultState, "token" | "tokenDecimals" | "owner" | "kernelSigner" | "guardian" | "perTxCap" | "dailyCap" | "hourlyCap" | "humanThreshold" | "payeeChangeDelay" | "signerChangeDelay" | "ringSize">): Hex32 {
  const encoded = encodeAbiParameters(CONFIG_PARAMS, [
    s.token,
    s.tokenDecimals,
    s.owner,
    s.kernelSigner,
    s.guardian,
    s.perTxCap,
    s.dailyCap,
    s.hourlyCap,
    s.humanThreshold,
    Number(s.payeeChangeDelay),
    Number(s.signerChangeDelay),
    Number(s.ringSize),
  ]);
  return keccak256(encoded);
}

export interface DigestEngagement {
  readonly id: string;
  readonly payee: string;
  readonly cap: string;
  readonly start: string;
  readonly end: string;
  readonly termsHash: string;
  readonly active: boolean;
}

export function digestEntries(engagements: readonly EngagementState[]): DigestEngagement[] {
  const entries = engagements.map((e) => ({
    id: e.id.toLowerCase(),
    payee: e.payee.toLowerCase(),
    cap: e.cap.toString(),
    start: e.start.toString(),
    end: e.end.toString(),
    termsHash: e.termsHash.toLowerCase(),
    active: e.active,
  }));
  entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.id === entries[i - 1]!.id) throw new LbcError("INVALID_STATE", "duplicate engagement id");
  }
  return entries;
}

/** Independent of registration order and of `released` (docs/16 §10 test 3). */
export function computeEngagementsDigest(engagements: readonly EngagementState[]): Hex32 {
  return hashJcs(digestEntries(engagements));
}

/** An engagement counts toward the bound iff `active && end >= blockTimestamp`; no filter on `start` (docs/16 §2.2). */
export function countsTowardBound(e: EngagementState, blockTimestamp: bigint): boolean {
  return e.active && e.end >= blockTimestamp;
}

export interface DerivedEngagementInputs {
  /** Σ (cap − released) over the engagements that count */
  readonly sumRemaining: bigint;
  readonly activeEngagements: number;
  readonly counted: readonly EngagementState[];
}

export function deriveEngagementInputs(engagements: readonly EngagementState[], header: Pick<BlockHeader, "timestamp">): DerivedEngagementInputs {
  let sum = 0n;
  const counted: EngagementState[] = [];
  for (const e of engagements) {
    if (e.released > e.cap) throw new LbcError("INVALID_STATE", "an engagement has released more than its cap");
    if (countsTowardBound(e, header.timestamp)) {
      sum += e.cap - e.released;
      counted.push(e);
    }
  }
  return { sumRemaining: sum, activeEngagements: counted.length, counted };
}
