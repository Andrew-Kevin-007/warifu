// oracle-v1 input and output shapes (docs/15 §2). Pure data: bigint money (INV-10), ISO instants as strings,
// no clock, no I/O. The oracle never sees a kernel verdict: it judges a RELEASE (or a simulated vault release)
// against the scenario's ground truth and the state of the scenario instance. A non-release is never a loss.
import type { Address, ChallengeScenario, EvidenceFixture, Hex32, ISODateTime, OraclePredicate } from "@symbolon/schemas";

export const ORACLE_VERSION = "oracle-v1" as const;

/**
 * Money limits the scenario runs with, resolved to base units by the caller (the oracle cannot import the policy
 * package, so the caller reads the effective sandbox policy and passes numbers). "any policy cap" in docs/15 O5
 * is read as: per-tx hard cap, daily cap, weekly cap, per-payee velocity, monthly category budget, and the
 * human-approval threshold (a release above it needs an owner approval). See docs/QUESTIONS.md "WP-23" item 1.
 */
export interface OracleLimits {
  readonly perTxCap: bigint;
  readonly dailyCap: bigint;
  readonly weeklyCap: bigint;
  readonly humanApprovalAbove: bigint;
  readonly maxReleasesPerDay: number;
  readonly maxReleasesPerPayeePerDay: number;
  readonly maxAmountPerPayeePerDay: bigint;
  /** monthly budget per category key (absent key = no budget) */
  readonly categoryBudgets: Readonly<Record<string, bigint>>;
}

/** A release that already happened in this scenario instance (seeded by the fixture or made earlier in the run). */
export interface PriorRelease {
  readonly milestoneId: Hex32 | null;
  readonly payee: Address;
  readonly amount: bigint;
  readonly time: ISODateTime;
}

/** The state of one scenario instance at decision time. Build a fresh one per attempt. */
export interface OracleInstance {
  readonly scenario: ChallengeScenario;
  readonly limits: OracleLimits;
  /** Releases already made, in order. */
  readonly releases: readonly PriorRelease[];
  /** Milestones whose status is PAID (seeded by a context patch or set by applyRelease). */
  readonly milestonePaid: readonly Hex32[];
  /** category key -> already booked this month before any release in `releases` (a context patch). */
  readonly categorySpentBaseline: Readonly<Record<string, bigint>>;
  /** Evidence fixtures visible to the kernel at decision time (the scenario's own, filtered by the run). */
  readonly evidence: readonly EvidenceFixture[];
  readonly breakerHalted: boolean;
  readonly vaultPaused: boolean;
}

export type TermsBasis = "signed" | "invoice-stated" | "none";

/** One RELEASE decision (or simulated vault release) to be judged. */
export interface OracleRelease {
  /** null = the release is not tied to a milestone of the engagement (e.g. an unregistered vendor). */
  readonly milestoneId: Hex32 | null;
  readonly payee: Address;
  readonly amount: bigint;
  /** The instant the money would move. */
  readonly time: ISODateTime;
  /** Kernel-recorded receipt time of the invoice (INV-19); null when the target recorded none. */
  readonly invoiceReceivedAt: ISODateTime | null;
  /** Where the terms behind `amount`/`time` came from: the signed engagement, the invoice text, or nowhere. */
  readonly termsBasis: TermsBasis;
  /** The instant the discount clock started for this release, if the target had a clock at all. */
  readonly clockAnchor: ISODateTime | null;
  /** A valid owner approval accompanied the release. */
  readonly ownerApproved: boolean;
}

export interface PredicateFinding {
  readonly predicate: OraclePredicate;
  /** One short factual line, no document text. */
  readonly detail: string;
}

export interface OracleVerdict {
  readonly version: typeof ORACLE_VERSION;
  readonly result: "LOSS" | "NO_LOSS";
  /** Predicates that hold, in O1..O8 order. */
  readonly predicates: readonly OraclePredicate[];
  readonly findings: readonly PredicateFinding[];
}
