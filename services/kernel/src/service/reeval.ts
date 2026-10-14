// Re-evaluation of a STORED intent against fresh facts (docs/04 s1 "auto re-evaluated when the missing thing changes", K-12 owner
// approval, K-14 plan selection, WP-14). One code path for the three triggers; the payAt TOCTOU lives in release/service.ts.
//
//   RECHECK         a HOLD (or ESCALATE) head is evaluated again; a NEW decision is written only when the outcome changed
//   PLAN_SELECTION  the planner's PlanSelection is merged into the stored proposal and the intent is evaluated again
//   APPROVAL        a verified OwnerApproval is stored and bound, then the intent is evaluated again
//
// Every new decision supersedes the head it replaced. Nothing is written when evaluation or signing fails (the transaction
// rolls back); the service never decides anything itself, it only feeds the pure kernel and records its answer.
import { evaluate } from "@symbolon/kernel-core";
import type { Evaluation } from "@symbolon/kernel-core";
import type { ISODateTime, PlanSelection, Verdict } from "@symbolon/schemas";
import type { Profile } from "../boot";
import type { ChainReader } from "../chain/reader";
import type { Db, Queryable } from "../db/pool";
import * as base from "../db/repo";
import type { StoredDecision } from "../db/repo";
import { ApiError } from "../errors";
import { errorFields } from "../log";
import type { Logger } from "../log";
import type { KernelSigner } from "../receipt/build";
import { markRechecked, releaseForIntent } from "../release/repo";
import { nowIso } from "../time";
import type { Clock } from "../time";
import { IntentNotFound, intentContext, readIntentChain } from "./intent-context";
import type { IntentContext } from "./intent-context";
import { recordDecision } from "./record";
import type { Recorded } from "./record";

export interface ReevalDeps {
  readonly db: Db;
  readonly chain: ChainReader;
  readonly signer: KernelSigner;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly logger: Logger;
  readonly newId?: () => string;
}

export interface ReevalOptions {
  readonly action: string;
  readonly actor: string;
  /** Verdicts of the head this trigger may supersede. */
  readonly heads: readonly Verdict[];
  readonly selection?: PlanSelection;
  readonly planningAsOf?: ISODateTime | null;
  /** true: record a decision only when the verdict or the reasons changed (HOLD re-checks), else just note the check. */
  readonly onlyIfChanged?: boolean;
  /** Runs inside the transaction after the tenant lock and before the context is built (stores a verified approval). */
  readonly prepare?: (q: Queryable, head: StoredDecision, now: ISODateTime) => Promise<{ readonly planningAsOf?: ISODateTime | null } | void>;
}

export interface ReevalResult {
  /** null = nothing new was recorded (unchanged outcome on an `onlyIfChanged` re-check). */
  readonly recorded: Recorded | null;
  readonly head: StoredDecision;
  readonly evaluation: Evaluation;
}

const sameReasons = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

export async function reevaluateStored(d: ReevalDeps, tenantId: string, intentId: string, o: ReevalOptions): Promise<ReevalResult> {
  const view = await readIntentChain(d.db, d.chain, tenantId, intentId); // throws IntentNotFound
  return d.db.tx(async (q): Promise<ReevalResult> => {
    await base.lockTenantForDecisions(q, tenantId);
    const now = nowIso(d.clock);
    const head0 = await base.getLatestStoredDecisionForIntent(q, tenantId, intentId);
    if (head0 === null) throw new IntentNotFound();
    if (!o.heads.includes(head0.decision.verdict)) throw new ApiError("CONFLICT", "the decision cannot be re-evaluated from its current state", { verdict: head0.decision.verdict });
    const release = await releaseForIntent(q, tenantId, intentId);
    if (release !== null && release.status !== "FAILED") throw new ApiError("CONFLICT", "a release for this intent is already in flight", { status: release.status });
    const prepared = o.prepare === undefined ? undefined : await o.prepare(q, head0, now);
    const planningAsOf = (prepared === undefined ? undefined : prepared.planningAsOf) ?? o.planningAsOf ?? null;
    const ic: IntentContext = await intentContext(q, { tenantId, intentId, profile: d.profile, now, view, planningAsOf });
    const rawIntent = o.selection === undefined ? view.intent.payload : { ...(view.intent.payload as Record<string, unknown>), planSelection: o.selection };
    let evaluation: Evaluation;
    try {
      evaluation = evaluate(rawIntent, ic.ctx, ic.policy);
    } catch (e) {
      d.logger.error("evaluate.threw", { ...errorFields(e) });
      throw new ApiError("INTERNAL", "internal error; the request was not processed");
    }
    const head = ic.head;
    if (evaluation.verdict === "REPLAY") return { recorded: null, head, evaluation }; // excluded by construction; never write a REPLAY
    if (o.onlyIfChanged === true && evaluation.verdict === head.decision.verdict && sameReasons(evaluation.reasons, head.decision.reasons)) {
      await markRechecked(q, tenantId, head.decision.decisionId, now);
      return { recorded: null, head, evaluation };
    }
    const recorded = await recordDecision({
      q, signer: d.signer, logger: d.logger, evaluation, ctx: ic.ctx, rawIntent, supersedes: head.decision.decisionId, policyHash: ic.policy.policyHash,
      action: o.action, actor: o.actor, ...(d.newId === undefined ? {} : { newId: d.newId }),
    });
    if (o.onlyIfChanged === true) await markRechecked(q, tenantId, recorded.decision.decisionId, now);
    return { recorded, head, evaluation };
  });
}
