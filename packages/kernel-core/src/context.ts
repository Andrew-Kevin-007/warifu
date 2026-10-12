// KernelContext: everything the kernel may know (docs/04 §2), assembled by services/kernel (WP-10).
// kernel-core never reads a clock, the network, the DB or the chain: all of it arrives here. Money is
// bigint base units (INV-10). Text that came from outside the trust boundary is Untrusted (INV-15).
//
// WP-04 additions to the docs/04 §2 list (each is an input the spec's checks need but the list omits;
// recorded in docs/QUESTIONS.md "WP-04"):
//   chain.vaultTokenDecimals  K-07 compares token decimals with the vault-stored decimals.
//   engagementOnChain         K-05 "indexed from on-chain EngagementRegistered with matching termsHash".
//   reevaluation              TOCTOU re-evaluation at payAt (docs/04 §5): the scheduled decision whose
//                             release amount K-08 re-checks and whose own intentId K-04 must not REPLAY.
import { hashJcs } from "@symbolon/schemas";
import type {
  Address,
  Eip712Message,
  Engagement,
  Evidence,
  Hex32,
  ISODateTime,
  Milestone,
  PaymentTerms,
  Profile,
  UUID,
  Untrusted,
  Verdict,
} from "@symbolon/schemas";
import { attempt } from "./result";
import type { Result } from "./result";

export interface ChainContext {
  readonly tokenAddress: Address;
  /** ERC-20 `decimals()` of the settlement token, verified at deploy (V-04). */
  readonly tokenDecimals: number;
  /** The vault's immutable `tokenDecimals` (read from the vault). */
  readonly vaultTokenDecimals: number;
}

/** The engagement as indexed from chain events (EngagementRegistered, PayeeChangeExecuted, EngagementClosed). */
export interface EngagementOnChain {
  readonly engagementId: Hex32;
  readonly payee: Address;
  readonly capBaseUnits: bigint;
  readonly start: ISODateTime;
  readonly end: ISODateTime;
  readonly termsHash: Hex32;
  readonly active: boolean;
}

/**
 * A prior decision of this tenant (last 90 days), as K-04 needs it. The service passes the current head of each
 * supersedes chain; a decision whose verdict is RELEASE counts as released-or-pending (race guard).
 */
export interface DecisionSummary {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  readonly verdict: Verdict;
  readonly docHash: Hex32;
  readonly engagementId: Hex32 | null;
  readonly milestoneId: Hex32 | null;
  /** Payout address (the engagement payee), or null when the decision had none. */
  readonly payee: Address | null;
  readonly normInvoiceNo: string | null;
  /** GROSS invoiced amount. */
  readonly amountBaseUnits: bigint | null;
  readonly releaseAmountBaseUnits: bigint | null;
  readonly createdAt: ISODateTime;
}

/** Totals INCLUDING decided-but-unsettled amounts (race guard). */
export interface ReleasedTotals {
  readonly engagementTotal: bigint;
  readonly tenantDay: bigint;
  readonly tenantWeek: bigint;
  readonly payeeDay: bigint;
  readonly payeeCountDay: number;
  readonly categoryMonth: Readonly<Record<string, bigint>>;
}

export interface ScreeningState {
  readonly status: "CLEAR" | "HIT" | "UNKNOWN";
  readonly checkedAt: ISODateTime;
  readonly provider: string;
}

export interface Balances {
  readonly vaultAvailable: bigint;
  readonly pendingReleases: bigint;
  readonly obligations14d: bigint;
}

export interface PayeeHistory {
  readonly priorPayments: number;
  readonly onTime: number;
  readonly disputes: number;
}

/** The kernel-stored document record (NOT from the extractor; INV-23: text plus hashes, never a blob). */
export interface KernelDocument {
  readonly hash: Hex32;
  /** keccak256 of the UTF-8 bytes of normalizedText (docs/QUESTIONS WP-01 item 2). */
  readonly normalizedHash: Hex32;
  readonly normalizedText: Untrusted<string>;
  readonly zeroWidthCount: number;
}

export interface EscalationCounts {
  readonly today: number;
  readonly todayByEngagement: Readonly<Record<string, number>>;
}

export interface BreakerState {
  readonly halted: boolean;
  readonly reason: string | null;
}

/** The scheduled decision being re-evaluated at its payAt (docs/04 §5). */
export interface Reevaluation {
  readonly decisionId: UUID;
  readonly intentId: Hex32;
  /** The scheduled payment instant. */
  readonly payAt: ISODateTime;
  /** The scheduled release amount (what the attestation would carry). */
  readonly releaseAmountBaseUnits: bigint;
}

export interface KernelContext {
  /** Injected; kernel-core never reads a clock. */
  readonly now: ISODateTime;
  readonly tenantId: UUID;
  readonly vaultAddress: Address;
  readonly chainId: number;
  readonly chain: ChainContext;
  /** Loaded by intent.engagementId; must match the on-chain registration. */
  readonly engagement: Engagement | null;
  readonly engagementOnChain: EngagementOnChain | null;
  readonly milestone: Milestone | null;
  readonly priorDecisions: readonly DecisionSummary[];
  readonly released: ReleasedTotals;
  /** Collected by kernel collectors only. */
  readonly evidence: readonly Evidence[];
  /** Signature already verified by the service. */
  readonly ownerApproval: Eip712Message<"OwnerApproval"> | null;
  readonly screening: ScreeningState | null;
  readonly balances: Balances;
  readonly payeeHistory: PayeeHistory;
  readonly doc: KernelDocument;
  /** Recorded by the kernel when the document was accepted; starts the discount clock (INV-19). */
  readonly invoiceReceivedAt: ISODateTime;
  /** From the dual-signed engagement (inside termsHash); null => policy defaults, no discount. */
  readonly paymentTerms: PaymentTerms | null;
  readonly escalations: EscalationCounts;
  readonly profile: Profile;
  readonly breaker: BreakerState;
  readonly payeeChangePending: boolean;
  /** Non-null only when the service re-evaluates a scheduled decision at its payAt. */
  readonly reevaluation: Reevaluation | null;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** JSON-safe copy: bigint -> decimal string, everything else as-is (JCS then refuses anything non-JSON). */
export function toJsonSafe(value: unknown): Json {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v: unknown) => toJsonSafe(v));
  if (typeof value === "object" && value !== null) {
    const out: { [key: string]: Json } = {};
    for (const [k, v] of Object.entries(value)) out[k] = toJsonSafe(v);
    return out;
  }
  return value as Json;
}

/** contextHash = keccak256(JCS(context with bigints as decimal strings)) (docs/05 Decision.contextHash). */
export function contextHash(ctx: KernelContext): Result<Hex32> {
  return attempt(() => hashJcs(toJsonSafe(ctx)), "CONTEXT_INVALID", "context is not canonicalizable (JCS)");
}
