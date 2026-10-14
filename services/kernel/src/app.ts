// The Hono application (docs/05 s4). createApp() is pure wiring over injected dependencies, so tests build two instances
// over one database (replay across instances) and swap the chain edge for a fake. Nothing here reads env or a clock.
//
// Order of middleware, outermost first: request id + access log, security headers, error mapping, then (for /v1 except the
// probes) the clock guard + durable service-token authentication. The tenant used by EVERY handler is the one in the verified
// token; a body or URL naming another tenant is refused.
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { Hex32Schema, PlanSelectionSchema, UUIDSchema } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import { releaseForIntent } from "./release/repo";
import type { ReleaseRow } from "./release/repo";
import { ApiError, INTERNAL_ERROR_BODY, errorBody } from "./errors";
import { authMiddleware } from "./auth/middleware";
import type { AppEnv } from "./auth/middleware";
import type { ClockGuard } from "./auth/clock-guard";
import type { NonceStore } from "./auth/nonce-store";
import { buildApprovalView } from "./approval/build";
import type { BlobStore } from "./blob/store";
import type { ChainReader } from "./chain/reader";
import { loadTenantPolicy, peekIntent, readChain, resolveTenantVault } from "./context/build";
import type { Db } from "./db/pool";
import * as repo from "./db/repo";
import { errorFields } from "./log";
import type { Logger } from "./log";
import type { KernelSigner } from "./receipt/build";
import { ingestDocument } from "./service/documents";
import { contextFailure, submitIntent } from "./service/intents";
import type { EngagementChain } from "./chain/engagement-chain";
import type { VaultRelayer } from "./chain/relayer";
import { createEngagement, getEngagementView, payeeChangeFlow, signEngagement } from "./engagement/service";
import type { EngagementServiceDeps } from "./engagement/service";
import { assertEvidencePairing, collectEvidence, submitOwnerAck, uploadArtifact } from "./evidence/service";
import type { EvidenceServiceDeps } from "./evidence/service";
import { submitApproval } from "./service/approvals";
import type { ApprovalsDeps } from "./service/approvals";
import { unavailablePlanProvider } from "./service/plans";
import type { PlanProvider } from "./service/plans";
import { WEBHOOK_MAX_BYTES } from "./circle/webhook";
import type { WebhookOutcome, WebhookRequest } from "./circle/webhook";
import { nowIso } from "./time";
import type { Clock } from "./time";
import type { Profile } from "./boot";

export interface AppDeps {
  readonly profile: Profile;
  readonly db: Db;
  readonly chain: ChainReader;
  readonly signer: KernelSigner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly serviceTokenSecret: string;
  readonly nonceStore: NonceStore;
  readonly clockGuard: ClockGuard;
  readonly blobs: BlobStore;
  readonly maxJsonBytes: number;
  readonly maxBlobBytes: number;
  readonly plans?: PlanProvider;
  readonly newId?: () => string;
  /** WP-12. Absent = the engagement routes answer 501 (a build without an indexer/relayer edge never half-works). */
  /** WP-11. Absent = POST /webhooks/circle answers 501 (no Circle edge configured). Verified by the handler, not by a service token. */
  readonly circleWebhook?: (r: WebhookRequest) => Promise<WebhookOutcome>;
  readonly engagements?: { readonly chain: EngagementChain; readonly relayer: VaultRelayer | null; readonly newUuid?: () => string };
  /** WP-13. Absent = the evidence routes answer 501. Present = the source must match the profile (live in production, fixtures in the sandbox). */
  readonly evidence?: EvidenceServiceDeps;
  /** WP-14. Absent = POST /approvals answers 501. */
  readonly approvals?: ApprovalsDeps;
  /** WP-14. Called after evidence for a milestone changed (collect, ack, artifact): HOLD decisions of that milestone are re-evaluated. Errors never reach the caller. */
  readonly afterEvidence?: (tenantId: string, milestoneId: Hex32) => Promise<unknown>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_:.-]{1,128}$/;

function hex32Param(v: string | undefined): string {
  const p = Hex32Schema.safeParse(v);
  if (!p.success) throw new ApiError("NOT_FOUND", "not found");
  return p.data;
}
function uuidParam(v: string | undefined): string {
  const p = UUIDSchema.safeParse(v);
  if (!p.success) throw new ApiError("NOT_FOUND", "not found");
  return p.data.toLowerCase();
}

/** What an API client may see of a release row: its lifecycle and the transaction pointer, never the signed attestation. */
function releaseSummary(r: ReleaseRow | null): { status: string; txHash: string | null; attempts: number; deadline: string | null } | null {
  return r === null ? null : { status: r.status, txHash: r.txHash, attempts: r.attempts, deadline: r.deadline };
}

const notImplemented =(what: string) => (): never => {
  throw new ApiError("NOT_IMPLEMENTED", `${what} is not available in this build`);
};

export function createApp(d: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const plans = d.plans ?? unavailablePlanProvider;
  if (d.evidence !== undefined) {
    if (d.evidence.profile !== d.profile) throw new Error("evidence service built for another profile");
    assertEvidencePairing(d.profile, d.evidence.source);
  }

  // --- request id, access log, headers -------------------------------------------------------------------------------
  app.use("*", async (c, next) => {
    const requestId = randomUUID();
    c.set("requestId", requestId);
    const started = d.clock();
    await next();
    c.header("X-Request-Id", requestId);
    d.logger.info("http.request", { requestId, method: c.req.method, route: c.req.routePath, status: c.res.status, durationMs: Math.max(0, d.clock() - started) });
  });
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "same-origin", referrerPolicy: "no-referrer" }));
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.onError((e, c) => {
    if (e instanceof ApiError) {
      for (const [k, v] of Object.entries(e.headers)) c.header(k, v);
      return c.json(errorBody(e), e.status as 400);
    }
    d.logger.error("http.unhandled", { requestId: c.get("requestId"), ...errorFields(e) });
    return c.json(INTERNAL_ERROR_BODY, 500);
  });
  app.notFound((c) => c.json(errorBody(new ApiError("NOT_FOUND", "not found")), 404));

  // --- Circle webhook (WP-11): called by Circle, so NOT behind the service-token middleware; authenticated by its signature ---
  const webhookLimit = bodyLimit({
    maxSize: WEBHOOK_MAX_BYTES,
    onError: (c) => c.json(errorBody(new ApiError("PAYLOAD_TOO_LARGE", "request body is too large")), 413),
  });
  const webhook = async (c: Context): Promise<Response> => {
    if (d.circleWebhook === undefined) throw new ApiError("NOT_IMPLEMENTED", "the Circle webhook is not configured in this build");
    const rawBody = await c.req.text();
    const outcome = await d.circleWebhook({ rawBody, signature: c.req.header("x-circle-signature"), keyId: c.req.header("x-circle-key-id") });
    return c.json({ status: outcome.toLowerCase() }, 200);
  };
  app.post("/webhooks/circle", webhookLimit, webhook);
  app.post("/v1/webhooks/circle", webhookLimit, webhook);

  const v1 = new Hono<AppEnv>();

  // --- probes (no auth, no tenant data) ------------------------------------------------------------------------------
  v1.get("/healthz", (c) => c.json({ status: "ok" }));
  v1.get("/readyz", async (c) => {
    const checks = { db: false, rpc: false };
    try {
      await d.db.ping();
      checks.db = true;
    } catch (e) {
      d.logger.warn("ready.db_failed", { ...errorFields(e) });
    }
    try {
      await d.chain.ping();
      checks.rpc = true;
    } catch (e) {
      d.logger.warn("ready.rpc_failed", { ...errorFields(e) });
    }
    const ready = checks.db && checks.rpc;
    return c.json({ status: ready ? "ready" : "unavailable", checks }, ready ? 200 : 503);
  });

  // --- the challenge exists only in the sandbox profile (INV-16): 404 in production, before authentication ------------
  if (d.profile === "production") {
    v1.all("/challenge/*", () => {
      throw new ApiError("NOT_FOUND", "not found");
    });
  }

  // --- everything below is authenticated ------------------------------------------------------------------------------
  v1.use(
    "*",
    authMiddleware({
      secret: d.serviceTokenSecret,
      profile: d.profile,
      clock: d.clock,
      nonceStore: d.nonceStore,
      clockGuard: d.clockGuard,
      logger: d.logger,
    }),
  );
  v1.use("*", async (c, next) => {
    const key = c.req.header("idempotency-key");
    if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) throw new ApiError("BAD_REQUEST", "malformed Idempotency-Key");
    await next();
  });

  const tooLarge = bodyLimit({
    maxSize: d.maxJsonBytes,
    onError: (c) => c.json(errorBody(new ApiError("PAYLOAD_TOO_LARGE", "request body is too large", { maxBytes: d.maxJsonBytes })), 413),
  });
  const uploadLimit = bodyLimit({
    maxSize: d.maxBlobBytes + d.maxJsonBytes,
    onError: (c) => c.json(errorBody(new ApiError("PAYLOAD_TOO_LARGE", "request body is too large")), 413),
  });

  // --- documents -----------------------------------------------------------------------------------------------------
  v1.post("/documents", uploadLimit, async (c) => {
    const { tenantId } = c.get("auth");
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    let text: unknown;
    let mime: unknown;
    let blob: Uint8Array | null = null;
    if (ct.startsWith("multipart/form-data")) {
      let form: Record<string, string | File | (string | File)[]>;
      try {
        form = await c.req.parseBody();
      } catch {
        throw new ApiError("BAD_REQUEST", "malformed multipart body");
      }
      text = form["text"];
      mime = form["mime"];
      const b = form["blob"];
      if (b !== undefined) {
        if (!(b instanceof File)) throw new ApiError("BAD_REQUEST", "blob must be a file part");
        blob = new Uint8Array(await b.arrayBuffer()); // bytes only: never decoded or parsed (INV-23)
      }
    } else if (ct.startsWith("application/json")) {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        throw new ApiError("BAD_REQUEST", "malformed JSON body");
      }
      if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ApiError("BAD_REQUEST", "expected a JSON object");
      text = (body as Record<string, unknown>)["text"];
      mime = (body as Record<string, unknown>)["mime"];
    } else {
      throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "use multipart/form-data or application/json");
    }
    const r = await ingestDocument({ db: d.db, clock: d.clock, profile: d.profile, blobs: d.blobs, maxBlobBytes: d.maxBlobBytes }, { tenantId, text, mime, blob });
    d.logger.info("document.accepted", { tenantId, requestId: c.get("requestId"), count: r.created ? 1 : 0 });
    return c.json({ documentId: r.documentId, docHash: r.docHash, normalizedHash: r.normalizedHash, blobSha256: r.blobSha256, receivedAt: r.receivedAt, textPreview: r.textPreview }, r.created ? 201 : 200);
  });

  v1.get("/documents/:id/text", async (c) => {
    const { tenantId } = c.get("auth");
    const doc = await repo.getDocument(d.db, tenantId, uuidParam(c.req.param("id")));
    if (doc === null) throw new ApiError("NOT_FOUND", "not found");
    return c.json({ normalizedText: doc.normalizedText });
  });

  // --- intents -------------------------------------------------------------------------------------------------------
  v1.post("/intents", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("BAD_REQUEST", "malformed JSON body");
    }
    const r = await submitIntent({ db: d.db, chain: d.chain, signer: d.signer, clock: d.clock, profile: d.profile, logger: d.logger, ...(d.newId === undefined ? {} : { newId: d.newId }) }, tenantId, body);
    return c.json(r, r.replay ? 200 : 201);
  });

  v1.get("/intents/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const intentId = hex32Param(c.req.param("id"));
    const row = await repo.getIntentRow(d.db, tenantId, intentId);
    if (row === null) throw new ApiError("NOT_FOUND", "not found");
    const latest = await repo.getLatestStoredDecisionForIntent(d.db, tenantId, intentId);
    const rel = await releaseForIntent(d.db, tenantId, intentId);
    return c.json({ intentId, documentId: row.documentId, createdAt: row.createdAt, intent: row.payload, decision: latest?.decision ?? null, receiptHash: latest?.receiptHash ?? null, release: releaseSummary(rel) });
  });

  // --- owner approval (docs/05 s4, INV-20): verifies the owner's signature on exactly what the ApprovalView showed, then re-evaluates ---
  v1.post("/approvals", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    if (d.approvals === undefined) throw new ApiError("NOT_IMPLEMENTED", "owner approvals are not available in this build");
    return c.json(await submitApproval(d.approvals, tenantId, await jsonBody(c)));
  });

  v1.get("/intents/:id/plans", async (c) => {
    const { tenantId } = c.get("auth");
    const intentId = hex32Param(c.req.param("id"));
    if ((await repo.getIntentRow(d.db, tenantId, intentId)) === null) throw new ApiError("NOT_FOUND", "not found");
    return c.json(await plans.plans(tenantId, intentId));
  });

  v1.post("/intents/:id/plan-selection", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const intentId = hex32Param(c.req.param("id"));
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new ApiError("BAD_REQUEST", "malformed JSON body");
    }
    const sel = PlanSelectionSchema.safeParse(body);
    if (!sel.success) throw new ApiError("BAD_REQUEST", "not a valid plan selection");
    if ((await repo.getIntentRow(d.db, tenantId, intentId)) === null) throw new ApiError("NOT_FOUND", "not found");
    return c.json({ decision: await plans.select(tenantId, intentId, sel.data) });
  });

  v1.get("/intents/:id/approval-view", async (c) => {
    const { tenantId } = c.get("auth");
    const intentId = hex32Param(c.req.param("id"));
    const latest = await repo.getLatestStoredDecisionForIntent(d.db, tenantId, intentId);
    if (latest === null || latest.decision.engagementId === null) throw new ApiError("NOT_FOUND", "not found");
    try {
      const engagement = await repo.loadEngagement(d.db, tenantId, latest.decision.engagementId);
      const tv = await resolveTenantVault(d.db, tenantId, d.chain);
      if (engagement === null) throw new ApiError("NOT_FOUND", "not found");
      const extras = await repo.getDecisionExtras(d.db, tenantId, latest.decision.decisionId);
      return c.json(
        buildApprovalView({ decision: latest.decision, receiptHash: latest.receiptHash, engagement, chainId: tv.chainId, vault: tv.vault, now: nowIso(d.clock), planSummary: extras?.planSummary ?? null }),
      );
    } catch (e) {
      throw contextFailure(e, d.logger);
    }
  });

  // --- decisions, receipts, state ------------------------------------------------------------------------------------
  v1.get("/decisions/:id", async (c) => {
    const { tenantId } = c.get("auth");
    const s = await repo.getStoredDecision(d.db, tenantId, uuidParam(c.req.param("id")));
    if (s === null) throw new ApiError("NOT_FOUND", "not found");
    return c.json({ decision: s.decision, receiptHash: s.receiptHash });
  });

  v1.get("/receipts/:hash", async (c) => {
    const { tenantId } = c.get("auth");
    const s = await repo.getStoredReceipt(d.db, tenantId, hex32Param(c.req.param("hash")));
    if (s === null) throw new ApiError("NOT_FOUND", "not found");
    const rel = await releaseForIntent(d.db, tenantId, s.decision.intentId);
    const tx = rel !== null && rel.decisionId === s.decision.decisionId ? releaseSummary(rel) : null; // the release made under THIS receipt only
    return c.json({ receipt: s.receipt, receiptHash: s.receiptHash, signature: s.signature, signer: s.signer, tx });
  });

  v1.get("/state", async (c) => {
    const { tenantId } = c.get("auth");
    try {
      const tv = await resolveTenantVault(d.db, tenantId, d.chain);
      const cd = await readChain(d.chain, tv.vault, peekIntent({}));
      const policy = await loadTenantPolicy(d.db, tenantId, d.profile, cd.snapshot);
      const now = nowIso(d.clock);
      const [breaker, released] = await Promise.all([repo.loadBreaker(d.db, tenantId), repo.loadReleasedTotals(d.db, tenantId, now, null, null, null)]);
      const halted = cd.snapshot.paused || breaker.halted;
      return c.json({
        profile: d.profile,
        breaker: { halted, reason: cd.snapshot.paused ? "VAULT_PAUSED" : breaker.reason },
        vault: { address: tv.vault, chainId: tv.chainId, balanceBaseUnits: cd.snapshot.balance.toString(), decimals: cd.snapshot.tokenDecimals, paused: cd.snapshot.paused },
        pendingReleasesBaseUnits: released.pendingReleases.toString(),
        policyHash: policy.policyHash,
      });
    } catch (e) {
      throw contextFailure(e, d.logger);
    }
  });

  // --- engagements (WP-12): typed data, signature collection, registration relay, payee change ----------------------------
  const eng = d.engagements;
  const engagementDeps = (): EngagementServiceDeps => {
    if (eng === undefined) throw new ApiError("NOT_IMPLEMENTED", "engagements are not available in this build");
    return { db: d.db, chain: d.chain, engagementChain: eng.chain, relayer: eng.relayer, logger: d.logger, ...(eng.newUuid === undefined ? {} : { newUuid: eng.newUuid }) };
  };
  const jsonBody = async (c: { req: { json(): Promise<unknown> } }): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new ApiError("BAD_REQUEST", "malformed JSON body");
    }
  };

  v1.post("/engagements", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const r = await createEngagement(engagementDeps(), tenantId, await jsonBody(c));
    return c.json(r.engagement, r.created ? 201 : 200);
  });

  v1.get("/engagements/:id", async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await getEngagementView(engagementDeps(), tenantId, hex32Param(c.req.param("id"))));
  });

  v1.post("/engagements/:id/sign", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const id = hex32Param(c.req.param("id"));
    return c.json(await signEngagement(engagementDeps(), tenantId, id, await jsonBody(c)));
  });

  v1.post("/engagements/:id/payee-change", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const id = hex32Param(c.req.param("id"));
    const r = await payeeChangeFlow(engagementDeps(), tenantId, id, await jsonBody(c));
    return c.json(r.change, r.created ? 201 : 200);
  });

  // --- evidence (WP-13): collection, artifact hashing, owner acks -------------------------------------------------------------
  const evd = (): EvidenceServiceDeps => {
    if (d.evidence === undefined) throw new ApiError("NOT_IMPLEMENTED", "evidence collection is not available in this build");
    return d.evidence;
  };
  // New evidence may lift a HOLD ("auto re-evaluated when the missing thing changes", docs/04 s1): fire the re-check, never fail the call.
  const evidenceChanged = async (tenantId: string, milestoneId: unknown): Promise<void> => {
    const m = Hex32Schema.safeParse(milestoneId);
    if (!m.success || d.afterEvidence === undefined) return;
    try {
      await d.afterEvidence(tenantId, m.data);
    } catch (e) {
      d.logger.warn("evidence.recheck_failed", { tenantId, ...errorFields(e) });
    }
  };
  v1.post("/evidence/collect", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const body = await jsonBody(c);
    const out = await collectEvidence(evd(), tenantId, body);
    await evidenceChanged(tenantId, (body as { milestoneId?: unknown }).milestoneId);
    return c.json(out);
  });
  v1.post("/evidence/ack", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const body = await jsonBody(c);
    const out = await submitOwnerAck(evd(), tenantId, body);
    await evidenceChanged(tenantId, (body as { milestoneId?: unknown }).milestoneId);
    return c.json(out, 201);
  });
  v1.post("/evidence/artifact", uploadLimit, async (c) => {
    const { tenantId } = c.get("auth");
    const service = evd();
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")) throw new ApiError("UNSUPPORTED_MEDIA_TYPE", "use multipart/form-data with milestoneId and file");
    let form: Record<string, string | File | (string | File)[]>;
    try {
      form = await c.req.parseBody();
    } catch {
      throw new ApiError("BAD_REQUEST", "malformed multipart body");
    }
    const f = form["file"];
    if (!(f instanceof File)) throw new ApiError("BAD_REQUEST", "file must be a file part");
    const stored = await uploadArtifact(service, tenantId, form["milestoneId"], new Uint8Array(await f.arrayBuffer())); // bytes only: never decoded or parsed (INV-23)
    await evidenceChanged(tenantId, form["milestoneId"]);
    return c.json(stored, 201);
  });

  // --- stubs mounted per profile --------------------------------------------------------------------------------------
  v1.get("/certificates/:vault", notImplemented("certificates"));
  v1.get("/certificates/:vault/:certHash", notImplemented("certificates"));
  v1.post("/certificates/:vault/build", notImplemented("certificate builds"));
  if (d.profile === "sandbox") {
    v1.get("/challenge/scenarios", notImplemented("the challenge (WP-32)"));
    v1.post("/challenge/attempts", notImplemented("the challenge (WP-32)"));
    v1.get("/challenge/attempts/:id", notImplemented("the challenge (WP-32)"));
    v1.get("/challenge/stats", notImplemented("the challenge (WP-32)"));
    v1.post("/challenge/prove-onchain", notImplemented("the challenge (WP-32)"));
  }

  app.route("/v1", v1);
  return app;
}
