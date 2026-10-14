// Rebuild the KernelContext for an intent that is already stored (WP-14): the payAt TOCTOU re-evaluation, owner approvals,
// plan selection and HOLD re-checks all re-run the kernel on the SAME stored proposal against FRESH facts. Phase 1 (chain reads)
// runs outside any transaction; phase 2 runs inside the caller's transaction after it took the tenant decision lock, so caps,
// duplicate guards and the supersedes chain see every earlier decision.
//
// The intent's own supersedes chain is excluded from priorDecisions/escalations (it must not REPLAY or escalate against
// itself), and the decision being re-evaluated is excluded from the released totals (it must not count twice: docs/04 s2).
// An owner approval is attached only when it is verified, stored, and bound to an escalation decision of THIS chain (K-12).
import type { KernelContext } from "@symbolon/kernel-core";
import type { LoadedPolicy } from "@symbolon/policy";
import type { ISODateTime } from "@symbolon/schemas";
import type { Profile } from "../boot";
import type { ChainReader } from "../chain/reader";
import { assembleContext, loadTenantPolicy, peekIntent, readChain, resolveTenantVault } from "../context/build";
import type { ChainData, IntentPeek, TenantVault } from "../context/build";
import type { Queryable } from "../db/pool";
import * as repo from "../db/repo";
import type { StoredDecision } from "../db/repo";
import { approvalInChain } from "../release/repo";
import type { ApprovalRow } from "../release/repo";

export interface StoredIntent {
  readonly payload: unknown;
  readonly documentId: string;
  readonly peek: IntentPeek;
}

/** Phase 1, no transaction: the stored proposal plus everything that needs the network. */
export interface IntentChainView {
  readonly intent: StoredIntent;
  readonly tv: TenantVault;
  readonly chain: ChainData;
}

export class IntentNotFound extends Error {
  constructor() {
    super("intent not found for this tenant");
    this.name = "IntentNotFound";
  }
}

export async function readIntentChain(q: Queryable, chain: ChainReader, tenantId: string, intentId: string): Promise<IntentChainView> {
  const row = await repo.getIntentRow(q, tenantId, intentId);
  if (row === null) throw new IntentNotFound();
  const peek = peekIntent(row.payload);
  const tv = await resolveTenantVault(q, tenantId, chain);
  const cd = await readChain(chain, tv.vault, peek);
  return { intent: { payload: row.payload, documentId: row.documentId, peek: { ...peek, documentId: row.documentId } }, tv, chain: cd };
}

export interface IntentContext {
  readonly ctx: KernelContext;
  readonly policy: LoadedPolicy;
  readonly head: StoredDecision;
  /** The verified owner approval bound into ctx (null when none applies). */
  readonly approval: ApprovalRow | null;
}

/**
 * Phase 2, inside the caller's transaction (tenant decision lock held). `head` is the current head of the intent's chain,
 * re-read here; `excludeDecisionId` is the decision whose amount must not count against itself (the head by default).
 */
export async function intentContext(
  q: Queryable,
  a: { tenantId: string; intentId: string; profile: Profile; now: ISODateTime; view: IntentChainView; planningAsOf?: ISODateTime | null; useApproval?: boolean },
): Promise<IntentContext> {
  const head = await repo.getLatestStoredDecisionForIntent(q, a.tenantId, a.intentId);
  if (head === null) throw new IntentNotFound();
  const policy = await loadTenantPolicy(q, a.tenantId, a.profile, a.view.chain.snapshot);
  const base = await assembleContext({
    q,
    tenantId: a.tenantId,
    profile: a.profile,
    now: a.now,
    peek: a.view.intent.peek,
    tv: a.view.tv,
    chain: a.view.chain,
    policy,
    excludeIntentId: a.intentId,
    excludeDecisionId: head.decision.decisionId,
  });
  let ctx: KernelContext = { ...base, planningAsOf: a.planningAsOf ?? null };
  let approval: ApprovalRow | null = null;
  if (a.useApproval !== false) {
    approval = await approvalInChain(q, a.tenantId, a.intentId, head.decision.decisionId);
    if (approval !== null) {
      const extras = await repo.getDecisionExtras(q, a.tenantId, approval.decisionId);
      if (extras !== null) {
        ctx = {
          ...ctx,
          ownerApproval: { intentId: approval.intentId, receiptHash: approval.receiptHash, amount: approval.amount, deadline: approval.deadline },
          approvedEscalation: { receiptHash: approval.receiptHash, findings: extras.approvableFindings },
        };
      } else approval = null;
    }
  }
  return { ctx, policy, head, approval };
}
