// POST /intents: assemble context, run the pure kernel, persist the decision and a signed receipt (docs/04, docs/05 s4).
//
// The service decides NOTHING. It (1) refuses a proposal that names another tenant, (2) resolves the tenant's vault and
// reads the chain, (3) inside one transaction holding the tenant's decision lock (so caps and duplicate guards see every
// earlier decision, no matter how requests interleave) assembles the ledger side of the context, calls evaluate(), and
// writes intent + decision + receipt + audit row atomically. Any failure before the write leaves nothing behind and the
// caller gets a 4xx/5xx: there is no path from an error to a RELEASE.
import { evaluate } from "@symbolon/kernel-core";
import type { Evaluation, KernelContext } from "@symbolon/kernel-core";
import type { Decision, Hex32, Receipt } from "@symbolon/schemas";
import { ApiError } from "../errors";
import type { ChainReader } from "../chain/reader";
import { ContextError, assembleContext, loadTenantPolicy, peekIntent, readChain, resolveTenantVault } from "../context/build";
import type { Db } from "../db/pool";
import * as repo from "../db/repo";
import { errorFields } from "../log";
import type { Logger } from "../log";
import { ReceiptError } from "../receipt/build";
import type { KernelSigner } from "../receipt/build";
import { recordDecision } from "./record";
import { nowIso } from "../time";
import type { Clock } from "../time";
import type { Profile } from "../boot";

export interface IntentsDeps {
  readonly db: Db;
  readonly chain: ChainReader;
  readonly signer: KernelSigner;
  readonly clock: Clock;
  readonly profile: Profile;
  readonly logger: Logger;
  readonly newId?: () => string;
}

export interface DecisionResponse {
  readonly intentId: Hex32;
  readonly decision: Decision;
  readonly receiptHash: Hex32;
  readonly receipt: Receipt;
  readonly signature: string;
  readonly signer: string;
  /** true when the proposal was an exact duplicate: this is the ORIGINAL decision (docs/04 K-04). */
  readonly replay: boolean;
}

/** Map assembly failures to HTTP. Everything but a bad reference is a 503: the kernel could not see enough to decide. */
export function contextFailure(e: unknown, logger: Logger): ApiError {
  if (e instanceof ApiError) return e;
  if (e instanceof ContextError) {
    logger.warn("context.unavailable", { reasonCode: e.code });
    if (e.code === "NO_DOCUMENT") return new ApiError("UNPROCESSABLE", "the proposal does not reference a stored document", { code: e.code });
    if (e.code === "NO_TENANT") return new ApiError("FORBIDDEN", "unknown tenant");
    return new ApiError("UNAVAILABLE", "the decision context is unavailable; nothing was decided", { code: e.code }, { "Retry-After": "5" });
  }
  if (e instanceof ReceiptError) {
    // packages/receipts refused to build or sign (inconsistent decision, signer fault): nothing was stored.
    logger.error("receipt.refused", { reasonCode: e.code });
    return new ApiError("INTERNAL", "internal error; the request was not processed");
  }
  logger.error("intent.failed", { ...errorFields(e) });
  return new ApiError("INTERNAL", "internal error; the request was not processed");
}

export async function submitIntent(d: IntentsDeps, tenantId: string, rawIntent: unknown): Promise<DecisionResponse> {
  const peek = peekIntent(rawIntent);
  if (peek.tenantId !== null && peek.tenantId !== tenantId) throw new ApiError("TENANT_MISMATCH", "the proposal names a different tenant than the token");
  try {
    const tv = await resolveTenantVault(d.db, tenantId, d.chain);
    const cd = await readChain(d.chain, tv.vault, peek);
    return await d.db.tx(async (q) => {
      await repo.lockTenantForDecisions(q, tenantId);
      const now = nowIso(d.clock); // taken after the lock: decisions are ordered by it
      const policy = await loadTenantPolicy(q, tenantId, d.profile, cd.snapshot);
      const ctx: KernelContext = await assembleContext({ q, tenantId, profile: d.profile, now, peek, tv, chain: cd, policy });

      let evaluation: Evaluation;
      try {
        evaluation = evaluate(rawIntent, ctx, policy);
      } catch (e) {
        d.logger.error("evaluate.threw", { ...errorFields(e) });
        throw new ApiError("INTERNAL", "internal error; the request was not processed");
      }

      if (evaluation.verdict === "REPLAY") {
        const prior = evaluation.replayOf === null ? null : await repo.getStoredDecision(q, tenantId, evaluation.replayOf.decisionId);
        if (prior === null) throw new ApiError("INTERNAL", "internal error; the request was not processed"); // fail closed, never invent
        d.logger.info("intent.replayed", { intentId: prior.decision.intentId, decisionId: prior.decision.decisionId, tenantId });
        return respond(prior.decision, prior.receipt, prior.receiptHash, prior.signature, prior.signer, true);
      }

      if (peek.documentId === null) throw new ApiError("UNPROCESSABLE", "the proposal does not reference a stored document"); // unreachable: assembleContext threw
      const stored = await repo.insertIntentOnce(q, {
        intentId: evaluation.intentId,
        tenantId,
        documentId: peek.documentId,
        payloadJson: JSON.stringify(rawIntent),
      });
      if (stored.ownerTenantId !== tenantId) throw new ApiError("CONFLICT", "intent id is already in use"); // never reveal whose
      const rec = await recordDecision({
        q,
        signer: d.signer,
        logger: d.logger,
        evaluation,
        ctx,
        rawIntent,
        supersedes: null,
        policyHash: policy.policyHash,
        action: "intent.decided",
        actor: `tenant:${tenantId}`,
        ...(d.newId === undefined ? {} : { newId: d.newId }),
      });
      return respond(rec.decision, rec.receipt, rec.receiptHash, rec.signature, rec.signer, false);
    });
  } catch (e) {
    throw contextFailure(e, d.logger);
  }
}

function respond(decision: Decision, receipt: Receipt, receiptHash: Hex32, signature: string, signer: string, replay: boolean): DecisionResponse {
  return { intentId: decision.intentId, decision, receiptHash, receipt, signature, signer, replay };
}
