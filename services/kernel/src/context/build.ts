// buildContext(): assemble the KernelContext (docs/04 s2) from the database and the chain. The service only gathers
// facts; every judgement is kernel-core's. Rules:
//  - tenant scoped: every DB read carries the tenant id from the verified token;
//  - fail closed: a missing tenant/vault/document/policy, a policy that is not the stored hash or is looser than the
//    vault, an unreadable engagement row or any RPC failure throws ContextError (the route answers 503, no decision
//    is written, nothing can RELEASE);
//  - nothing text-shaped from the proposal is trusted here: ids are only PEEKED (regex-checked) to know which rows to
//    load; K-01 still parses the whole proposal strictly;
//  - the clock is injected (`now`), and `invoiceReceivedAt` is the kernel-recorded `documents.received_at` (INV-19).
import { normalizePolicy } from "@symbolon/policy";
import type { LoadedPolicy } from "@symbolon/policy";
import { checkPolicyWithinVault, makeVaultConfig } from "@symbolon/policy";
import { AddressSchema, Hex32Schema, UUIDSchema, untrusted } from "@symbolon/schemas";
import type { Address, Hex32, ISODateTime, UUID } from "@symbolon/schemas";
import type { KernelContext } from "@symbolon/kernel-core";
import type { ChainReader, OnChainEngagement, VaultSnapshot } from "../chain/reader";
import type { Queryable } from "../db/pool";
import * as repo from "../db/repo";
import { isoFromEpochSecondsBig } from "../time";
import type { Profile } from "../boot";

export type ContextErrorCode =
  | "NO_TENANT"
  | "NO_VAULT"
  | "NO_DOCUMENT"
  | "BAD_POLICY"
  | "POLICY_LOOSER_THAN_VAULT"
  | "CHAIN_MISMATCH"
  | "CHAIN_UNAVAILABLE"
  | "DB_ROW_INVALID";

export class ContextError extends Error {
  readonly code: ContextErrorCode;
  constructor(code: ContextErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ContextError";
    this.code = code;
  }
}

/** What a proposal says about which rows to load. Regex-checked; garbage becomes null and K-01 rejects it later. */
export interface IntentPeek {
  readonly documentId: UUID | null;
  readonly engagementId: Hex32 | null;
  readonly milestoneId: Hex32 | null;
  readonly tenantId: string | null;
}

export function peekIntent(raw: unknown): IntentPeek {
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const id = (v: unknown): Hex32 | null => {
    const p = Hex32Schema.safeParse(v);
    return p.success ? p.data : null;
  };
  const doc = UUIDSchema.safeParse(o["documentId"]);
  return {
    documentId: doc.success ? doc.data.toLowerCase() : null,
    engagementId: id(o["engagementId"]),
    milestoneId: id(o["milestoneId"]),
    tenantId: typeof o["tenantId"] === "string" ? o["tenantId"].toLowerCase() : null,
  };
}

export interface ChainData {
  readonly snapshot: VaultSnapshot;
  readonly onChain: OnChainEngagement | null;
  readonly payeeChangePending: boolean;
}

export interface TenantVault {
  readonly vault: Address;
  readonly chainId: number;
}

/** Resolve the vault the tenant is bound to, and refuse a chain-id mismatch with the RPC the service is configured for. */
export async function resolveTenantVault(q: Queryable, tenantId: string, chain: ChainReader): Promise<TenantVault> {
  const t = await repo.getTenant(q, tenantId);
  if (t === null) throw new ContextError("NO_TENANT", "unknown tenant");
  const vault = AddressSchema.safeParse(t.vaultAddress);
  if (!vault.success) throw new ContextError("NO_VAULT", "tenant has no registered vault");
  if (t.chainId !== chain.chainId) throw new ContextError("CHAIN_MISMATCH", "tenant chain differs from the configured RPC chain");
  return { vault: vault.data, chainId: t.chainId };
}

/** Phase 1 (no DB transaction held): everything that needs the network. */
export async function readChain(chain: ChainReader, vault: Address, peek: IntentPeek): Promise<ChainData> {
  try {
    const [snapshot, onChain, payeeChangePending] = await Promise.all([
      chain.snapshot(vault),
      peek.engagementId === null ? Promise.resolve(null) : chain.engagement(vault, peek.engagementId),
      peek.engagementId === null ? Promise.resolve(false) : chain.payeeChangeLive(vault, peek.engagementId),
    ]);
    return { snapshot, onChain, payeeChangePending };
  } catch (cause) {
    throw new ContextError("CHAIN_UNAVAILABLE", "could not read the vault", { cause });
  }
}

/** The tenant's stored policy, verified against its stored hash and against the vault's actual limits. */
export async function loadTenantPolicy(q: Queryable, tenantId: string, profile: Profile, snapshot: VaultSnapshot): Promise<LoadedPolicy> {
  const t = await repo.getTenant(q, tenantId);
  if (t === null) throw new ContextError("NO_TENANT", "unknown tenant");
  let loaded: LoadedPolicy;
  try {
    loaded = normalizePolicy(t.policy);
  } catch (cause) {
    throw new ContextError("BAD_POLICY", "stored policy does not load", { cause });
  }
  if (loaded.policyHash !== t.policyHash) throw new ContextError("BAD_POLICY", "stored policy does not match its stored hash");
  const vaultCfg = makeVaultConfig({
    profile,
    tokenDecimals: snapshot.vaultTokenDecimals,
    perTxCap: snapshot.perTxCap,
    dailyCap: snapshot.dailyCap,
    hourlyCap: snapshot.hourlyCap,
    humanThreshold: snapshot.humanThreshold,
  });
  if (checkPolicyWithinVault(loaded, vaultCfg).length > 0) throw new ContextError("POLICY_LOOSER_THAN_VAULT", "policy is looser than the vault limits");
  return loaded;
}

export interface AssembleInput {
  readonly q: Queryable;
  readonly tenantId: UUID;
  readonly profile: Profile;
  readonly now: ISODateTime;
  readonly peek: IntentPeek;
  readonly tv: TenantVault;
  readonly chain: ChainData;
  readonly policy: LoadedPolicy;
  /** Re-evaluating this intent (plan selection): its own earlier decisions must not count against it. */
  readonly excludeIntentId?: string | null;
  readonly excludeDecisionId?: string | null;
}

/** Phase 2 (inside the tenant's decision lock): everything derived from the ledger. */
export async function assembleContext(a: AssembleInput): Promise<KernelContext> {
  if (a.peek.documentId === null) throw new ContextError("NO_DOCUMENT", "the proposal does not name a document");
  const doc = await repo.getDocument(a.q, a.tenantId, a.peek.documentId);
  if (doc === null) throw new ContextError("NO_DOCUMENT", "document not found for this tenant");

  const engagement = await (async () => {
    if (a.peek.engagementId === null) return null;
    try {
      return await repo.loadEngagement(a.q, a.tenantId, a.peek.engagementId);
    } catch (cause) {
      throw new ContextError("DB_ROW_INVALID", "engagement row does not parse", { cause });
    }
  })();
  const milestone = engagement === null || a.peek.milestoneId === null ? null : (engagement.milestones.find((m) => m.milestoneId === a.peek.milestoneId) ?? null);

  const exclIntent = a.excludeIntentId ?? null;
  const exclDecision = a.excludeDecisionId ?? null;
  const [prior, released, obligations, history, escalations, breakerRow] = await Promise.all([
    repo.loadPriorDecisions(a.q, a.tenantId, a.now, exclIntent),
    repo.loadReleasedTotals(a.q, a.tenantId, a.now, engagement?.engagementId ?? null, engagement?.payee ?? null, exclDecision),
    repo.loadObligations(a.q, a.tenantId, a.now, a.policy.policy.reserve.lookaheadDays),
    repo.loadPayeeHistory(a.q, a.tenantId, engagement?.payee ?? null),
    repo.loadEscalations(a.q, a.tenantId, a.now, exclIntent),
    repo.loadBreaker(a.q, a.tenantId),
  ]);
  let evidence: KernelContext["evidence"] = [];
  if (milestone !== null) {
    try {
      evidence = (await repo.loadEvidence(a.q, a.tenantId, milestone.milestoneId)).evidence;
    } catch (cause) {
      throw new ContextError("DB_ROW_INVALID", "evidence rows could not be read", { cause });
    }
  }

  const onChain = a.chain.onChain;
  const snap = a.chain.snapshot;
  return {
    now: a.now,
    tenantId: a.tenantId,
    vaultAddress: a.tv.vault,
    chainId: a.tv.chainId,
    chain: { tokenAddress: snap.token, tokenDecimals: snap.tokenDecimals, vaultTokenDecimals: snap.vaultTokenDecimals },
    engagement,
    engagementOnChain:
      onChain === null || a.peek.engagementId === null
        ? null
        : {
            engagementId: a.peek.engagementId,
            payee: onChain.payee,
            capBaseUnits: onChain.cap,
            start: isoFromEpochSecondsBig(onChain.start),
            end: isoFromEpochSecondsBig(onChain.end),
            termsHash: onChain.termsHash,
            active: onChain.active,
          },
    milestone,
    priorDecisions: prior,
    released: {
      engagementTotal: released.engagementTotal,
      tenantDay: released.tenantDay,
      tenantWeek: released.tenantWeek,
      payeeDay: released.payeeDay,
      payeeCountDay: released.payeeCountDay,
      categoryMonth: released.categoryMonth,
    },
    evidence,
    ownerApproval: null, // approvals are verified and attached by the approvals flow (WP-14)
    screening: null, // K-13 is off until V-01 clears (policy.screening.required=false)
    balances: { vaultAvailable: snap.balance, pendingReleases: released.pendingReleases, obligations14d: obligations },
    payeeHistory: history,
    doc: {
      hash: doc.rawHash,
      normalizedHash: doc.normalizedHash,
      normalizedText: untrusted(doc.normalizedText),
      zeroWidthCount: doc.zeroWidthCount,
    },
    invoiceReceivedAt: doc.receivedAt,
    paymentTerms: engagement?.paymentTerms ?? null,
    escalations,
    profile: a.profile,
    breaker: snap.paused ? { halted: true, reason: "VAULT_PAUSED" } : { halted: breakerRow.halted, reason: breakerRow.reason },
    payeeChangePending: a.chain.payeeChangePending,
    reevaluation: null,
  };
}

