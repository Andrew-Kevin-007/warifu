/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-10 acceptance: POST /v1/intents returns a decision + signed receipt for fixtures, tenant isolation, replay, fail-closed
// behaviour, document ingestion (INV-23, INV-19) and per-profile route mounting. Real Postgres (V-15: "local"); only the
// chain edge is faked. Since WP-05 every check is real; the happy-path fixture passes K-01..K-08 and K-12 rejects it under the
// world's pilot-scale policy (no evidence is stored either), so nothing here can RELEASE.
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recoverAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { VERDICT_CODE, computeReceiptHash, eip712Digest, epochSecondsFromIso, symbolonDomain, toTypedDataJson } from "@symbolon/schemas";
import type { Receipt } from "@symbolon/schemas";
import { fileBlobStore } from "../src/blob/store";
import { dbSuiteEnabled } from "./helpers/pgdb";
import { ATTACKER, DOC_TEXT, ENGAGEMENT_ID, M1, OTHER_TENANT, PAYEE, TENANT, VAULT, call, extraction, form, intentFor, openWorld, postDoc } from "./helpers/world";
import type { World } from "./helpers/world";

const ZW = String.fromCharCode(0x200b); // zero-width space, built at runtime so the source has no invisible characters
const enabled = dbSuiteEnabled("app.local");
const count = async (w: World, sql: string, args: unknown[] = []): Promise<number> => Number.parseInt(String((await w.t.db.query<{ n: string }>(sql, args)).rows[0]?.n), 10);

describe.skipIf(!enabled)("local: kernel service over real Postgres", () => {
  let w: World;
  let blobDir: string;
  beforeAll(async () => {
    w = await openWorld();
    blobDir = mkdtempSync(join(tmpdir(), "symbolon-blobs-"));
  }, 120_000);
  afterAll(async () => {
    await w.close();
    rmSync(blobDir, { recursive: true, force: true });
  }, 120_000);

  describe("probes and authentication", () => {
    it("healthz and readyz need no token and expose nothing tenant-specific; readyz fails closed when the RPC is down", async () => {
      const app = w.app();
      expect((await call(app, "GET", "/v1/healthz", null)).json).toEqual({ status: "ok" });
      expect((await call(app, "GET", "/v1/readyz", null)).json).toEqual({ status: "ready", checks: { db: true, rpc: true } });
      w.chain.failWith = new Error("rpc down postgres://u:hunter2hunter2@h/x");
      const r = await call(app, "GET", "/v1/readyz", null);
      w.chain.failWith = null;
      expect(r.status).toBe(503);
      expect(r.json.checks).toEqual({ db: true, rpc: false });
      expect(JSON.stringify(r.json)).not.toContain("hunter2");
    });

    it("every other route is closed without a valid token (401, same body for every reason)", async () => {
      const app = w.app();
      const bodies = new Set<string>();
      for (const [m, p] of [["GET", "/v1/state"], ["POST", "/v1/intents"], ["POST", "/v1/documents"], ["GET", "/v1/decisions/3f2504e0-4f89-41d3-9a0c-0305e82c3301"], ["GET", "/v1/certificates/x"]] as const) {
        for (const tok of [null, "garbage", w.token(TENANT, { audience: "kernel:sandbox" })]) {
          const r = await call(app, m, p, tok);
          expect(r.status, `${m} ${p}`).toBe(401);
          bodies.add(JSON.stringify(r.json));
        }
      }
      expect(bodies.size).toBe(1);
    });

    it("a captured token replayed against a SECOND app instance sharing the database is refused (SEC-14)", async () => {
      const a = w.app();
      const b = w.app();
      const tok = w.token();
      expect((await call(a, "GET", "/v1/state", tok)).status).toBe(200);
      expect((await call(b, "GET", "/v1/state", tok)).status).toBe(401);
      expect((await call(a, "GET", "/v1/state", tok)).status).toBe(401);
      expect((await call(b, "GET", "/v1/state", w.token())).status).toBe(200); // negative control
    });

    it("fails closed with 503 when the app and database clocks disagree", async () => {
      const skewed = w.app({ clock: () => Date.now() + 3_600_000, clockGuard: undefined as never });
      // the default guard built by openWorld uses the real clock; build one on the skewed clock explicitly
      const { createClockGuard } = await import("../src/auth/clock-guard");
      const app = w.app({ clock: () => Date.now() + 3_600_000, clockGuard: createClockGuard({ db: w.t.db, clock: () => Date.now() + 3_600_000, logger: w.logger, cacheMs: 0 }) });
      expect((await call(app, "GET", "/v1/state", w.token())).status).toBe(503);
      void skewed;
    });
  });

  describe("documents (INV-23, INV-19)", () => {
    it("normalizes, hashes and records receivedAt; the same text again returns the FIRST row and its original clock", async () => {
      const app = w.app();
      const text = `${DOC_TEXT}hidden${ZW}${ZW}chars ${randomBytes(4).toString("hex")}\n`;
      const first = await call(app, "POST", "/v1/documents", w.token(), form({ text, mime: "text/plain" }));
      expect(first.status).toBe(201);
      expect(first.json.docHash).toMatch(/^0x[0-9a-f]{64}$/);
      expect(first.json.textPreview).toContain("INVOICE");
      await new Promise((r) => setTimeout(r, 1100));
      const again = await call(app, "POST", "/v1/documents", w.token(), form({ text, mime: "text/plain" }));
      expect(again.status).toBe(200);
      expect(again.json.documentId).toBe(first.json.documentId);
      expect(again.json.receivedAt).toBe(first.json.receivedAt); // the discount clock cannot be moved by re-posting
      const stored = await w.t.db.query<{ normalized_text: string; zero_width_count: number }>("select normalized_text, zero_width_count from documents where document_id = $1", [first.json.documentId]);
      expect(stored.rows[0]?.normalized_text).not.toContain("​");
      expect(stored.rows[0]?.zero_width_count).toBe(2);
      const read = await call(app, "GET", `/v1/documents/${String(first.json.documentId)}/text`, w.token());
      expect(read.json.normalizedText).toBe(stored.rows[0]?.normalized_text);
    });

    it("concurrent identical posts create one row", async () => {
      const app = w.app();
      const text = `${DOC_TEXT}race ${randomBytes(4).toString("hex")}\n`;
      const rs = await Promise.all(Array.from({ length: 6 }, () => call(app, "POST", "/v1/documents", w.token(), form({ text }))));
      expect(new Set(rs.map((r) => r.json.documentId)).size).toBe(1);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    });

    it("stores a blob opaquely (hash only, never parsed) and keeps it out of the text path", async () => {
      const app = w.app({ blobs: fileBlobStore(blobDir) });
      const bytes = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << /JS (app.alert(1)) >> endobj\n\u0000\u0001\u0002 hostile parser bait"));
      const r = await call(app, "POST", "/v1/documents", w.token(), form({ text: `${DOC_TEXT}blob ${randomBytes(4).toString("hex")}`, mime: "application/pdf", blob: new Blob([bytes]) }));
      expect(r.status).toBe(201);
      const { createHash } = await import("node:crypto");
      const sha = createHash("sha256").update(bytes).digest("hex");
      expect(r.json.blobSha256).toBe(`0x${sha}`);
      expect(existsSync(join(blobDir, sha))).toBe(true);
    });

    it("rejects binary-looking text, NUL, oversize, bad mime and bad shapes before storing anything (SEC-09)", async () => {
      const app = w.app();
      const before = await count(w, "select count(*) as n from documents");
      const cases: Array<[string, unknown, number]> = [
        ["NUL byte", form({ text: "abc\u0000def" }), 422],
        ["C1 control", form({ text: "abc\u0085def" }), 422],
        ["data URI", form({ text: "see data:image/png;base64,AAAA," }), 422],
        ["long base64 run", form({ text: "A".repeat(600) }), 422],
        ["replacement-char run", form({ text: "x����" }), 422],
        ["oversize", form({ text: "a ".repeat(15_000) }), 413],
        ["empty after normalization", form({ text: "​​  \n" }), 422],
        ["missing text", form({ mime: "text/plain" }), 400],
        ["bad mime", form({ text: "hello world", mime: "TEXT/../x" }), 400],
      ];
      for (const [name, body, status] of cases) expect((await call(app, "POST", "/v1/documents", w.token(), body as FormData)).status, name).toBe(status);
      expect((await call(app, "POST", "/v1/documents", w.token(), { text: "x".repeat(10) }, { "content-type": "text/csv" })).status).toBe(415);
      expect(await count(w, "select count(*) as n from documents")).toBe(before);
    });

    it("the sandbox profile accepts plain text only, 4 KiB at most, and no blob", async () => {
      const app = w.app({ profile: "sandbox" });
      const tok = (): string => w.token(TENANT, { profile: "sandbox" });
      expect((await call(app, "POST", "/v1/documents", tok(), form({ text: `${DOC_TEXT}sandbox ${randomBytes(3).toString("hex")}` }))).status).toBe(201);
      expect((await call(app, "POST", "/v1/documents", tok(), form({ text: "a ".repeat(2100) }))).status).toBe(413);
      expect((await call(app, "POST", "/v1/documents", tok(), form({ text: "hello world", blob: new Blob(["x"]) }))).status).toBe(415);
      expect((await call(app, "POST", "/v1/documents", tok(), form({ text: "hello world", mime: "application/pdf" }))).status).toBe(415);
    });
  });

  describe("POST /v1/intents", () => {
    it("returns a decision and a signed receipt for a fixture that passes K-01..K-08 (WP-05: K-12 rejects it under the world's pilot-scale policy)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}clean ${randomBytes(4).toString("hex")}`);
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      expect(r.status).toBe(201);
      const { decision, receipt, receiptHash, signature, signer } = r.json as { decision: any; receipt: Receipt; receiptHash: string; signature: string; signer: string };
      // WP-05 merge: K-09..K-16 are real now. 1,000 USDC is over the default per-payee daily amount (150 USDC), so K-12
      // rejects (VELOCITY); the world has no evidence for the milestone, so K-09/K-14 hold. No placeholder KERNEL_ERROR.
      expect(decision.verdict).toBe("REJECT");
      expect(decision.reasons).toEqual(expect.arrayContaining(["VELOCITY", "EVIDENCE_MISSING"]));
      expect(decision.reasons).not.toContain("KERNEL_ERROR");
      for (const id of ["K-01", "K-02", "K-03", "K-04", "K-05", "K-06", "K-07", "K-08"]) expect(decision.checks.find((c: any) => c.id === id).status, id).toBe("PASS");
      expect(decision.tenantId).toBe(TENANT);
      expect(decision.amountBaseUnits).toBe("1000000000");
      expect(decision.payee).toBe(PAYEE);
      // the receipt is exactly what the hash says, and the signature is the kernel signer's over the EIP-712 Receipt struct
      expect(computeReceiptHash(receipt)).toBe(receiptHash);
      const td = toTypedDataJson("Receipt", symbolonDomain(31337, VAULT), {
        receiptHash: receiptHash as `0x${string}`,
        intentId: decision.intentId,
        verdict: String(VERDICT_CODE[decision.verdict as "REJECT"]),
        policyHash: decision.policyHash,
        issuedAt: epochSecondsFromIso(receipt.issuedAt).toString(),
      });
      expect(await recoverAddress({ hash: eip712Digest(td), signature: signature as `0x${string}` })).toBe(signer);
      expect(signer).toBe(privateKeyToAccount(w.signerKey as `0x${string}`).address);
      // persisted and readable only by its tenant
      const got = await call(app, "GET", `/v1/decisions/${String(decision.decisionId)}`, w.token());
      expect(got.json.decision.verdict).toBe("REJECT");
      expect(got.json.receiptHash).toBe(receiptHash);
      expect((await call(app, "GET", `/v1/receipts/${receiptHash}`, w.token())).json.signature).toBe(signature);
      expect((await call(app, "GET", `/v1/intents/${String(decision.intentId)}`, w.token())).json.decision.decisionId).toBe(decision.decisionId);
    });

    it("an exact resubmission is a REPLAY: the ORIGINAL decision, no new rows (docs/04 K-04)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}replay ${randomBytes(4).toString("hex")}`);
      const body = intentFor(doc);
      const first = await call(app, "POST", "/v1/intents", w.token(), body);
      const decisions = await count(w, "select count(*) as n from decisions");
      const second = await call(app, "POST", "/v1/intents", w.token(), body);
      expect(second.status).toBe(200);
      expect(second.json.replay).toBe(true);
      expect(second.json.decision.decisionId).toBe(first.json.decision.decisionId);
      expect(second.json.receiptHash).toBe(first.json.receiptHash);
      expect(await count(w, "select count(*) as n from decisions")).toBe(decisions);
    });

    it("concurrent identical proposals: one decision is written, the others replay it (per-tenant decision lock)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}parallel ${randomBytes(4).toString("hex")}`);
      const body = intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction({ invoiceNumber: "INV-7001" }), b: extraction({ invoiceNumber: "INV-7001", confidence: 0.5 }) } });
      const rs = await Promise.all(Array.from({ length: 5 }, () => call(app, "POST", "/v1/intents", w.token(), body)));
      expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
      expect(new Set(rs.map((r) => r.json.decision.decisionId)).size).toBe(1);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    });

    it("REJECTs a swapped payee in both extractions (K-06) and records why", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}attacker ${randomBytes(4).toString("hex")}`);
      const wallet = { payee: { legalName: "Acme Design", walletAddress: ATTACKER, claimsAddressChange: false } };
      const body = intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction({ ...wallet, invoiceNumber: "INV-8001" }), b: extraction({ ...wallet, invoiceNumber: "INV-8001" }) } });
      const r = await call(app, "POST", "/v1/intents", w.token(), body);
      expect(r.status).toBe(201);
      expect(r.json.decision.verdict).toBe("REJECT");
      expect(r.json.decision.reasons).toContain("PAYEE_MISMATCH");
      expect(r.json.decision.payee).toBe(PAYEE); // the payout address is the engagement's, never the invoice's
    });

    it("ESCALATEs an ambiguous amount, and the approval view is refused until the kernel has a release amount", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}ambiguous ${randomBytes(4).toString("hex")}`);
      const amb = { amount: { printed: "1,000", currencyPrinted: "USDC", decimalSeparatorGuess: "ambiguous", parsedBaseUnits: null, decimals: 6 }, invoiceNumber: "INV-9001" };
      const body = intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction(amb), b: extraction({ ...amb, confidence: 0.4 }) } });
      const r = await call(app, "POST", "/v1/intents", w.token(), body);
      expect(r.json.decision.verdict).toBe("ESCALATE");
      const view = await call(app, "GET", `/v1/intents/${String(r.json.intentId)}/approval-view`, w.token());
      expect(view.status).toBe(409);
      expect((await call(app, "GET", `/v1/intents/${"0x" + "ab".repeat(32)}/approval-view`, w.token())).status).toBe(404);
    });

    it("a schema-invalid proposal for a stored document is a recorded REJECT with a receipt, not a 500", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}garbage ${randomBytes(4).toString("hex")}`);
      const r = await call(app, "POST", "/v1/intents", w.token(), { documentId: doc.documentId, tenantId: TENANT, bogus: true, unknown: { nested: [1, 2, 3] } });
      expect(r.status).toBe(201);
      expect(r.json.decision.verdict).toBe("REJECT");
      expect(r.json.decision.reasons).toContain("SCHEMA_INVALID");
      expect(r.json.receipt.inputs.modelA).toBe("unparsed");
    });

    it("refuses what cannot be decided: no document (422), unknown document (422), bad JSON (400), oversize (413), other tenant (403)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}misc ${randomBytes(4).toString("hex")}`);
      expect((await call(app, "POST", "/v1/intents", w.token(), { schemaVersion: 1 })).status).toBe(422);
      expect((await call(app, "POST", "/v1/intents", w.token(), { documentId: "6fa459ea-ee8a-4ca4-894e-db77e160355e" })).status).toBe(422);
      expect((await call(app, "POST", "/v1/intents", w.token(), "{not json", { "content-type": "application/json" })).status).toBe(400);
      expect((await call(app, "POST", "/v1/intents", w.token(), { documentId: doc.documentId, pad: "x".repeat(300_000) })).status).toBe(413);
      const wrong = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc, { tenantId: OTHER_TENANT }));
      expect(wrong.status).toBe(403);
      expect(wrong.json.error.code).toBe("TENANT_MISMATCH");
      // the other tenant's document id presented by this tenant: not found for this tenant
      const theirs = await postDoc(w, app, `${DOC_TEXT}theirs ${randomBytes(4).toString("hex")}`, OTHER_TENANT);
      expect((await call(app, "POST", "/v1/intents", w.token(), { documentId: theirs.documentId })).status).toBe(422);
    });
  });

  describe("tenant isolation", () => {
    it("tenant B can read nothing of tenant A: documents, intents, decisions, receipts all answer 404", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}isolation ${randomBytes(4).toString("hex")}`);
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      expect(r.status).toBe(201);
      const b = () => w.token(OTHER_TENANT);
      expect((await call(app, "GET", `/v1/documents/${doc.documentId}/text`, b())).status).toBe(404);
      expect((await call(app, "GET", `/v1/intents/${String(r.json.intentId)}`, b())).status).toBe(404);
      expect((await call(app, "GET", `/v1/decisions/${String(r.json.decision.decisionId)}`, b())).status).toBe(404);
      expect((await call(app, "GET", `/v1/receipts/${String(r.json.receiptHash)}`, b())).status).toBe(404);
      expect((await call(app, "GET", `/v1/intents/${String(r.json.intentId)}/approval-view`, b())).status).toBe(404);
      expect((await call(app, "GET", `/v1/decisions/${String(r.json.decision.decisionId)}`, w.token())).status).toBe(200); // control
    });
  });

  describe("fail closed", () => {
    it("an RPC failure is a 503 and writes nothing: no intent, decision or receipt", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}rpc ${randomBytes(4).toString("hex")}`);
      const before = [await count(w, "select count(*) as n from decisions"), await count(w, "select count(*) as n from intents"), await count(w, "select count(*) as n from receipts")];
      w.chain.failWith = new Error("connect ECONNREFUSED postgres://u:hunter2hunter2@h/x");
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction({ invoiceNumber: "INV-5001" }), b: extraction({ invoiceNumber: "INV-5001" }) } }));
      w.chain.failWith = null;
      expect(r.status).toBe(503);
      expect(JSON.stringify(r.json)).not.toContain("hunter2");
      expect([await count(w, "select count(*) as n from decisions"), await count(w, "select count(*) as n from intents"), await count(w, "select count(*) as n from receipts")]).toEqual(before);
    });

    it("a policy looser than the vault is refused (503) rather than evaluated", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}loose ${randomBytes(4).toString("hex")}`);
      w.chain.caps = { perTxCap: 1_000_000_000n, dailyCap: 5_000_000_000n, humanThreshold: 1_500_000_000n }; // below policy perTxHardCap 2000
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      w.chain.caps = { perTxCap: 2_000_000_000n, dailyCap: 5_000_000_000n, humanThreshold: 1_500_000_000n };
      expect(r.status).toBe(503);
      expect(r.json.error.detail.code).toBe("POLICY_LOOSER_THAN_VAULT");
    });

    it("a stored policy that does not match its stored hash is refused (503)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}hash ${randomBytes(4).toString("hex")}`);
      await w.t.db.query("update tenants set policy_hash = $2 where id = $1", [TENANT, `0x${"00".repeat(32)}`]);
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      await w.t.db.query("update tenants set policy_hash = (select policy_hash from tenants where id = $2) where id = $1", [TENANT, OTHER_TENANT]);
      expect(r.status).toBe(503);
      expect(r.json.error.detail.code).toBe("BAD_POLICY");
    });

    it("an engagement row edited after signing is never a RELEASE (termsHash recomputed by K-05)", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}tamper ${randomBytes(4).toString("hex")}`);
      await w.t.db.query("update milestones set amount_base_units = amount_base_units + 1 where milestone_id = $1", [M1]);
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction({ invoiceNumber: "INV-6001" }), b: extraction({ invoiceNumber: "INV-6001" }) } }));
      await w.t.db.query("update milestones set amount_base_units = amount_base_units - 1 where milestone_id = $1", [M1]);
      expect(r.status).toBe(201);
      expect(r.json.decision.verdict).not.toBe("RELEASE");
      expect(["REJECT", "ESCALATE", "HOLD"]).toContain(r.json.decision.verdict);
    });

    it("a paused vault halts evaluation (breaker), never RELEASE", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}paused ${randomBytes(4).toString("hex")}`);
      w.chain.paused = true;
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc, { extraction: { ...intentFor(doc).extraction, a: extraction({ invoiceNumber: "INV-4001" }), b: extraction({ invoiceNumber: "INV-4001" }) } }));
      const st = await call(app, "GET", "/v1/state", w.token());
      w.chain.paused = false;
      expect(r.json.decision.verdict).not.toBe("RELEASE");
      expect(st.json.breaker).toEqual({ halted: true, reason: "VAULT_PAUSED" });
    });
  });

  describe("state, plans, profiles", () => {
    it("GET /state reports the breaker, vault balance as base units and the policy hash", async () => {
      const r = await call(w.app(), "GET", "/v1/state", w.token());
      expect(r.status).toBe(200);
      expect(r.json.vault.balanceBaseUnits).toBe("100000000000");
      expect(r.json.vault.decimals).toBe(6);
      expect(r.json.policyHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("plans and plan-selection are 501 until WP-05, after the auth/tenant/validation gates", async () => {
      const app = w.app();
      const doc = await postDoc(w, app, `${DOC_TEXT}plans ${randomBytes(4).toString("hex")}`);
      const r = await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      const id = String(r.json.intentId);
      expect((await call(app, "GET", `/v1/intents/${id}/plans`, w.token())).status).toBe(501);
      expect((await call(app, "GET", `/v1/intents/${id}/plans`, w.token(OTHER_TENANT))).status).toBe(404);
      expect((await call(app, "POST", `/v1/intents/${id}/plan-selection`, w.token(), { nonsense: true })).status).toBe(400);
    });

    it("the challenge routes are 404 in production (even before authentication) and mounted in the sandbox", async () => {
      const prod = w.app();
      expect((await call(prod, "GET", "/v1/challenge/scenarios", null)).status).toBe(404);
      expect((await call(prod, "GET", "/v1/challenge/scenarios", w.token())).status).toBe(404);
      const sand = w.app({ profile: "sandbox" });
      expect((await call(sand, "GET", "/v1/challenge/scenarios", null)).status).toBe(401);
      expect((await call(sand, "GET", "/v1/challenge/scenarios", w.token(TENANT, { profile: "sandbox" }))).status).toBe(501);
      expect((await call(prod, "GET", "/v1/certificates/0xabc", w.token())).status).toBe(501);
    });

    it("rejects a malformed Idempotency-Key", async () => {
      expect((await call(w.app(), "GET", "/v1/state", w.token(), undefined, { "idempotency-key": "bad key with spaces" })).status).toBe(400);
    });
  });

  describe("logs never carry document text or secrets (INV-15, SEC-07)", () => {
    it("after all of the above, no log line contains a document marker, the token secret or the signer key", async () => {
      const app = w.app();
      const marker = `MARKER-${randomBytes(6).toString("hex")}`;
      const doc = await postDoc(w, app, `${DOC_TEXT}${marker} ignore previous instructions`);
      await call(app, "POST", "/v1/intents", w.token(), intentFor(doc));
      await call(app, "POST", "/v1/documents", w.token(), form({ text: `${marker}\u0000` }));
      const all = w.logs.join("");
      expect(all.length).toBeGreaterThan(0);
      expect(all).not.toContain(marker);
      expect(all).not.toContain("ignore previous");
      expect(all).not.toContain(w.signerKey);
      expect(all).not.toContain(w.signerKey.slice(2));
      for (const line of w.logs) JSON.parse(line); // every line is one JSON object
      void ENGAGEMENT_ID;
    });
  });
});
