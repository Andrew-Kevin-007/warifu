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
import { buildCertificate, getCertificateByHash, getLatestCertificate } from "./certificates/service";
import type { CertificateDeps, CertificateServiceConfig } from "./certificates/service";
import { createEngagement, getEngagementView, payeeChangeFlow, signEngagement } from "./engagement/service";
import type { EngagementServiceDeps } from "./engagement/service";
import { assertEvidencePairing, collectEvidence, submitOwnerAck, uploadArtifact } from "./evidence/service";
import type { EvidenceServiceDeps } from "./evidence/service";
import * as reconcileRepo from "./reconcile/repo";
import { BREAKER_UNFREEZE_TYPES, UNFREEZE_TTL_SECONDS, unfreeze } from "./reconcile/unfreeze";
import type { UnfreezeDeps } from "./reconcile/unfreeze";
import type { ChallengeService } from "./challenge/service";
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
  /** WP-15. Absent = GET /breaker and POST /breaker/unfreeze answer 501. */
  readonly breaker?: UnfreezeDeps;
  /** WP-34. Absent = the certificate routes answer 501. */
  readonly certificates?: CertificateServiceConfig;
  /** WP-32. Sandbox profile only; absent = the challenge routes answer 501. Type-only import: a production process never loads it. */
  readonly challenge?: ChallengeService;
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

  v1.get("/intents", async (c) => {
    const { tenantId } = c.get("auth");
    const raw = c.req.query("limit");
    if (raw !== undefined && !/^[0-9]{1,3}$/.test(raw)) throw new ApiError("BAD_REQUEST", "limit must be a number up to 100");
    return c.json({ intents: await repo.listIntents(d.db, tenantId, raw === undefined ? 25 : Number.parseInt(raw, 10)) });
  });

  v1.get("/pilot-stats", async (c) => {
    c.get("auth");
    return c.json({ stats: await repo.pilotStats(d.db), countsExclude: ["demo tenants", "challenge attempts", "house attackers", "internal self-payments"] });
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

  // --- circuit breaker (docs/04 K-16, WP-15): state, and the owner-signed unfreeze ---------------------------------------------------
  v1.get("/breaker", async (c) => {
    const { tenantId } = c.get("auth");
    if (d.breaker === undefined) throw new ApiError("NOT_IMPLEMENTED", "the breaker is not available in this build");
    try {
      const tv = await resolveTenantVault(d.db, tenantId, d.chain);
      const [row, findings, snap] = await Promise.all([reconcileRepo.loadBreakerRow(d.db, tenantId), reconcileRepo.recentFindings(d.db, tenantId, 20), d.chain.snapshot(tv.vault)]);
      return c.json({
        halted: row.halted || snap.paused,
        kernelHalted: row.halted,
        vaultPaused: snap.paused,
        reason: row.reason,
        haltedSince: row.since === null ? null : row.since.toString(),
        pauseError: row.pauseError,
        findings: findings.map((f) => ({ kind: f.kind, severity: f.severity, resolved: f.resolved, createdAt: f.createdAt })),
        // What the owner's wallet signs to unfreeze (the reason hash and deadline are chosen by the client; deadline <= ttl).
        unfreeze: {
          ttlSeconds: UNFREEZE_TTL_SECONDS,
          domain: { name: "SymbolonVault", version: "1", chainId: tv.chainId, verifyingContract: tv.vault },
          types: BREAKER_UNFREEZE_TYPES,
          primaryType: "BreakerUnfreeze",
        },
      });
    } catch (e) {
      throw contextFailure(e, d.logger);
    }
  });

  v1.post("/breaker/unfreeze", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    if (d.breaker === undefined) throw new ApiError("NOT_IMPLEMENTED", "the breaker is not available in this build");
    return c.json(await unfreeze(d.breaker, tenantId, await jsonBody(c)));
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
  // --- Loss Bound Certificates (WP-34): reads always carry a fresh server-side re-check against the configured RPC ------------
  const certs = d.certificates;
  const certDeps = (): CertificateDeps => {
    if (certs === undefined) throw new ApiError("NOT_IMPLEMENTED", "certificates are not available in this build");
    return { ...certs, db: d.db, clock: certs.clock ?? d.clock, profile: d.profile, logger: d.logger };
  };
  v1.get("/certificates/:vault", async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await getLatestCertificate(certDeps(), tenantId, c.req.param("vault")));
  });
  v1.get("/certificates/:vault/:certHash", async (c) => {
    const { tenantId } = c.get("auth");
    return c.json(await getCertificateByHash(certDeps(), tenantId, c.req.param("vault"), c.req.param("certHash")));
  });
  v1.post("/certificates/:vault/build", tooLarge, async (c) => {
    const { tenantId } = c.get("auth");
    const r = await buildCertificate(certDeps(), tenantId, c.req.param("vault"));
    return c.json(r.response, r.created ? 201 : 200);
  });
  // --- the public challenge (WP-32): mounted ONLY under the sandbox profile (docs/15 section 3); absent service = 501 ----------------
  if (d.profile === "sandbox") {
    const ch = d.challenge;
    const need = (): ChallengeService => {
      if (ch === undefined) throw new ApiError("NOT_IMPLEMENTED", "the challenge is not available in this build");
      return ch;
    };
    v1.get("/challenge/scenarios", async (c) => c.json(await need().catalog()));
    v1.get("/challenge/status", async (c) => c.json(await need().status()));
    v1.post("/challenge/attempts", tooLarge, async (c) => {
      c.get("auth");
      // The web tier forwards the visitor's address; it is hashed with the sandbox salt at once and never stored or logged raw.
      const ip = (c.req.header("x-client-ip") ?? "").slice(0, 64);
      return c.json(await need().attempt(await jsonBody(c), ip === "" ? null : ip), 201);
    });
    v1.get("/challenge/attempts/:id", async (c) => c.json(await need().getAttempt(c.req.param("id"))));
    v1.get("/challenge/stats", async (c) => c.json(await need().stats()));
    v1.post("/challenge/prove-onchain", () => need().proveOnchain());
  }

  app.route("/v1", v1);
  return app;
}
