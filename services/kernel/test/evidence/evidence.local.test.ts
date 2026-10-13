/* eslint-disable @typescript-eslint/no-explicit-any */
// WP-13 acceptance over a real Postgres and the real Hono app (V-15: "local"). Faked: only the two network edges (DNS + HTTPS,
// counted) and the chain READ edge. Covers: CI success/failure stubs, URL_HEALTH with the signed-spec allowlist, refusals
// persisted as EVIDENCE_SOURCE_DENIED, artifact hashing (INV-23), owner acks (EIP-712), tenant isolation, a tampered spec row,
// and the sandbox profile making ZERO outbound requests (RT-02, SEC-02 sandbox half).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceSchema, hashJcs, sha256Bytes } from "@symbolon/schemas";
import type { EvidenceFixture, EvidenceRequirement, Hex32 } from "@symbolon/schemas";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fileBlobStore } from "../../src/blob/store";
import * as dbrepo from "../../src/db/repo";
import { createFixtureStore, emptyFixtureStore } from "../../src/evidence/fixtures";
import type { EvidenceSource } from "../../src/evidence/service";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call, form } from "../helpers/world";
import type { World } from "../helpers/world";
import { enc, evidenceDeps, jsonResponse, netStub, openWorld, seedEvidenceTenant, signAck } from "../helpers/evidence-world";
import type { NetStub } from "../helpers/evidence-world";

const enabled = dbSuiteEnabled("evidence.local");
const SHA = "c".repeat(40);
const PUBLIC = "140.82.112.5";
const SITE_IP = "93.184.216.34";
const DNS = { "api.github.com": [PUBLIC], "site.example.com": [SITE_IP] };

const ciSpec = (over: Record<string, unknown> = {}): EvidenceRequirement => ({ type: "CI_PASS", repo: "acme/site", ref: SHA, workflow: "ci.yml", ...over }) as EvidenceRequirement;
const urlSpec = (url = "https://site.example.com/health", over: Record<string, unknown> = {}): EvidenceRequirement => ({ type: "URL_HEALTH", url, expectStatus: 200, ...over }) as EvidenceRequirement;
const runDoc = (conclusion: string, over: Record<string, unknown> = {}) => ({ workflow_runs: [{ id: 1, head_branch: "main", head_sha: SHA, status: "completed", conclusion, created_at: "2026-10-12T08:00:00Z", ...over }] });

const liveSource = (net: NetStub, token: string | null = null): EvidenceSource => ({ kind: "live", guard: net, githubToken: token });
const rowsOf = async (w: World, tenantId: string, milestoneId: Hex32) => (await dbrepo.loadEvidence(w.t.db, tenantId, milestoneId)).evidence;
const count = async (w: World, milestoneId: string): Promise<number> => Number.parseInt(String((await w.t.db.query<{ n: string }>("select count(*)::text as n from evidence where milestone_id = $1", [milestoneId])).rows[0]?.n), 10);

describe.skipIf(!enabled)("local: evidence service over real Postgres", () => {
  let w: World;
  let blobDir: string;
  beforeAll(async () => {
    w = await openWorld();
    blobDir = mkdtempSync(join(tmpdir(), "symbolon-evblobs-"));
  }, 120_000);
  afterAll(async () => {
    await w.close();
    rmSync(blobDir, { recursive: true, force: true });
  }, 120_000);

  describe("production profile: live collectors", () => {
    it("CI_PASS success then failure: both recorded as kernel evidence with a payload hash; the newer row is the failure", async () => {
      const t = await seedEvidenceTenant(w, [[ciSpec()]]);
      const m = t.milestones[0] as Hex32;
      let conclusion = "success";
      const net = netStub(DNS, () => jsonResponse(runDoc(conclusion)));
      let ms = Date.now();
      const stepping = () => (ms += 2000); // collected_at is whole-second: two collects must not share a second, or "newer" is a tie
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net), { clock: stepping }) });
      const tok = () => w.token(t.tenantId);

      const r1 = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(r1.status).toBe(200);
      expect(r1.json).toMatchObject({ milestoneId: m, mode: "live", denied: [], pending: [], awaiting: [] });
      expect(r1.json.evidence).toHaveLength(1);
      expect(r1.json.evidence[0]).toMatchObject({ type: "CI_PASS", collectedBy: "kernel", source: "github:actions", result: "PASS" });

      conclusion = "failure";
      const r2 = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(r2.json.evidence[0]).toMatchObject({ result: "FAIL" });

      const rows = await rowsOf(w, t.tenantId, m);
      expect(rows.map((x) => x.result)).toEqual(["PASS", "FAIL"]);
      for (const row of rows) {
        expect(EvidenceSchema.safeParse(row).success).toBe(true);
        expect(row.payloadHash).toBe(hashJcs(row.payload));
        expect((row.payload as any).requirementHash).toBe(hashJcs(ciSpec()));
      }
      expect(net.requests.every((q) => q.host === "api.github.com" && q.ip === PUBLIC)).toBe(true);
    });

    it("CI run not finished or absent: nothing is written, the response says pending", async () => {
      const t = await seedEvidenceTenant(w, [[ciSpec()]]);
      const m = t.milestones[0] as Hex32;
      const app = w.app({ evidence: evidenceDeps(w, liveSource(netStub(DNS, () => jsonResponse(runDoc("success", { status: "in_progress", conclusion: null }))))) });
      const r = await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: m });
      expect(r.json.pending).toEqual([{ index: 0, type: "CI_PASS", reason: "RUN_IN_PROGRESS" }]);
      expect(r.json.evidence).toEqual([]);
      expect(await count(w, m)).toBe(0);
    });

    it("URL_HEALTH: the host comes from the signed spec; OWNER_ACK and ARTIFACT_HASH entries are reported as awaiting, never fetched", async () => {
      const t = await seedEvidenceTenant(w, [[urlSpec(), { type: "OWNER_ACK" }, { type: "ARTIFACT_HASH", sha256: hashJcs("x") }]]);
      const m = t.milestones[0] as Hex32;
      const net = netStub(DNS);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const r = await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: m });
      expect(r.status).toBe(200);
      expect(r.json.evidence).toHaveLength(1);
      expect(r.json.evidence[0]).toMatchObject({ type: "URL_HEALTH", result: "PASS", source: "url:https://site.example.com/health" });
      expect(r.json.awaiting).toEqual([
        { index: 1, type: "OWNER_ACK", via: "POST /v1/evidence/ack" },
        { index: 2, type: "ARTIFACT_HASH", via: "POST /v1/evidence/artifact" },
      ]);
      expect(net.dnsCalls).toEqual(["site.example.com"]);
      expect(net.requests.map((q) => [q.ip, q.host])).toEqual([[SITE_IP, "site.example.com"]]);
    });

    it("hostile URLs in a signed spec are refused and recorded as EVIDENCE_SOURCE_DENIED without any DNS or connection; repeats do not pile up", async () => {
      // shapes the engagement schema regex lets through (https, no userinfo); the guard is the second line of defence
      const hostile = ["https://169.254.169.254/latest/meta-data/", "https://0x7f000001/", "https://2130706433/", "https://127.1/", "https://[::1]/admin", "https://[::ffff:7f00:1]/", "https://site.example.com:8443/", "https://localhost/", "https://site.example.com./", "https://exa%6dple.com/", "https://93.184.216.34/"];
      const t = await seedEvidenceTenant(w, [hostile.map((u) => ({ type: "URL_HEALTH", url: u, expectStatus: 200 }) as EvidenceRequirement)]);
      const m = t.milestones[0] as Hex32;
      const net = netStub(DNS);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const tok = () => w.token(t.tenantId);
      const r = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(r.status).toBe(200);
      expect(r.json.denied).toHaveLength(hostile.length);
      expect(r.json.denied.every((d: any) => d.reasonCode === "EVIDENCE_SOURCE_DENIED")).toBe(true);
      expect(net.dnsCalls).toEqual([]);
      expect(net.requests).toEqual([]);
      const rows = await rowsOf(w, t.tenantId, m);
      expect(rows).toHaveLength(hostile.length);
      expect(rows.every((x) => x.result === "ERROR" && (x.payload as any).reasonCode === "EVIDENCE_SOURCE_DENIED" && x.source === "denied:egress")).toBe(true);
      // no raw URL text anywhere in the stored rows or in the logs
      const stored = JSON.stringify(rows);
      const logged = w.logs.join("\n");
      for (const u of hostile) {
        expect(stored).not.toContain(u);
        expect(logged).not.toContain(u);
      }
      // collecting again changes nothing (identical refusals are deduplicated)
      const again = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(again.json.evidence).toEqual([]);
      expect(again.json.unchanged).toBe(hostile.length);
      expect(await count(w, m)).toBe(hostile.length);
    });

    it("a stored spec the engagement schema itself refuses (http, userinfo, file:) is never loaded: 503, no DNS, no connection", async () => {
      const t = await seedEvidenceTenant(w, [[{ type: "URL_HEALTH", url: "http://site.example.com/", expectStatus: 200 }], [{ type: "URL_HEALTH", url: "https://user@site.example.com/", expectStatus: 200 }], [{ type: "URL_HEALTH", url: "file:///etc/passwd", expectStatus: 200 }]]);
      const net = netStub(DNS);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const r = await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: t.milestones[0] });
      expect(r.status).toBe(503);
      expect(net.dnsCalls).toEqual([]);
      expect(net.requests).toEqual([]);
    });

    it("an allowlisted-by-spec name that resolves to a private address is denied (DNS_NON_GLOBAL) and never connected", async () => {
      const t = await seedEvidenceTenant(w, [[urlSpec("https://rebind.example.com/")]]);
      const net = netStub({ "rebind.example.com": ["127.0.0.1"] });
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const r = await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: t.milestones[0] });
      expect(r.json.denied).toEqual([{ index: 0, type: "URL_HEALTH", reasonCode: "EVIDENCE_SOURCE_DENIED", guardCode: "DNS_NON_GLOBAL" }]);
      expect(net.dnsCalls).toEqual(["rebind.example.com"]);
      expect(net.requests).toEqual([]);
    });

    it("the tenant policy urlAllowlist narrows the signed spec (default loader reads and verifies the stored policy)", async () => {
      const allow = { evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://*.vercel.app"] } };
      const t = await seedEvidenceTenant(w, [[urlSpec("https://site.example.com/health"), urlSpec("https://shop.vercel.app/health")]], { policyExtra: allow });
      const net = netStub({ ...DNS, "shop.vercel.app": ["76.76.21.21"] });
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const r = await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: t.milestones[0] });
      expect(r.json.denied).toEqual([{ index: 0, type: "URL_HEALTH", reasonCode: "EVIDENCE_SOURCE_DENIED", guardCode: "HOST_NOT_ALLOWED" }]);
      expect(r.json.evidence.map((e: any) => [e.type, e.result])).toEqual([["URL_HEALTH", "ERROR"], ["URL_HEALTH", "PASS"]]);
      expect(net.dnsCalls).toEqual(["shop.vercel.app"]);
    });

    it("the request body names a milestone and nothing else: a URL (or any extra field) in it is rejected, never fetched", async () => {
      const t = await seedEvidenceTenant(w, [[urlSpec()]]);
      const net = netStub(DNS);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      const tok = () => w.token(t.tenantId);
      for (const body of [{ milestoneId: t.milestones[0], url: "https://evil.test/" }, { milestoneId: "nope" }, {}, [], "x"]) {
        const r = await call(app, "POST", "/v1/evidence/collect", tok(), body as any);
        expect(r.status, JSON.stringify(body)).toBe(400);
      }
      expect(net.dnsCalls).toEqual([]);
    });

    it("tenant isolation, unknown milestones, inactive engagements and a spec row edited after signing", async () => {
      const a = await seedEvidenceTenant(w, [[urlSpec()]]);
      const b = await seedEvidenceTenant(w, [[urlSpec()]]);
      const net = netStub(DNS);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      // tenant B asking for tenant A's milestone
      expect((await call(app, "POST", "/v1/evidence/collect", w.token(b.tenantId), { milestoneId: a.milestones[0] })).status).toBe(404);
      expect((await call(app, "POST", "/v1/evidence/collect", w.token(a.tenantId), { milestoneId: `0x${"ab".repeat(32)}` })).status).toBe(404);
      // not ACTIVE
      const draft = await seedEvidenceTenant(w, [[urlSpec()]], { status: "AWAITING_PAYEE" });
      const rd = await call(app, "POST", "/v1/evidence/collect", w.token(draft.tenantId), { milestoneId: draft.milestones[0] });
      expect(rd.status).toBe(409);
      // someone edits the stored spec after signing: the terms no longer hash to termsHash, so nothing is fetched
      await w.t.db.query("update milestones set evidence_spec = $1::jsonb where milestone_id = $2", [JSON.stringify([urlSpec("https://evil.example.com/")]), a.milestones[0]]);
      const rt = await call(app, "POST", "/v1/evidence/collect", w.token(a.tenantId), { milestoneId: a.milestones[0] });
      expect(rt.status).toBe(409);
      expect(rt.json.error.code).toBe("TERMS_MISMATCH");
      expect(net.dnsCalls).toEqual([]);
      expect(net.requests).toEqual([]);
    });

    it("routes answer 501 when the build has no evidence service", async () => {
      const t = await seedEvidenceTenant(w, [[urlSpec()]]);
      const r = await call(w.app(), "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: t.milestones[0] });
      expect(r.status).toBe(501);
    });
  });

  describe("production profile: artifact hashing (INV-23)", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 255, 254, 0, 0, 80, 75, 3, 4]); // binary, NULs, a zip-looking header: never decoded or parsed
    const upload = (app: any, token: string, milestoneId: unknown, data: Uint8Array = bytes) =>
      call(app, "POST", "/v1/evidence/artifact", token, form({ milestoneId: String(milestoneId), file: new Blob([data as unknown as ArrayBuffer]) }));

    it("the kernel hashes the upload itself: a match is PASS and the blob is stored under its hash", async () => {
      const want = sha256Bytes(bytes);
      const t = await seedEvidenceTenant(w, [[{ type: "ARTIFACT_HASH", sha256: want }]]);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(netStub({})), { blobs: fileBlobStore(blobDir) }) });
      const r = await upload(app, w.token(t.tenantId), t.milestones[0]);
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ sha256: want, size: bytes.byteLength, evidence: { type: "ARTIFACT_HASH", result: "PASS", source: "kernel:artifact-upload", collectedBy: "kernel" } });
      expect(readdirSync(blobDir)).toContain(want.slice(2));
      expect((await rowsOf(w, t.tenantId, t.milestones[0] as Hex32))[0]?.payload).toMatchObject({ hashMismatch: false, size: bytes.byteLength });
    });

    it("a different file is recorded as a FAIL mismatch, never a pass", async () => {
      const t = await seedEvidenceTenant(w, [[{ type: "ARTIFACT_HASH", sha256: hashJcs("the signed design") }]]);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(netStub({})), { blobs: fileBlobStore(blobDir) }) });
      const r = await upload(app, w.token(t.tenantId), t.milestones[0]);
      expect(r.status).toBe(201);
      expect(r.json.evidence).toMatchObject({ result: "FAIL" });
      expect((r.json.evidence.payload as any).hashMismatch).toBe(true);
    });

    it("refusals: no ARTIFACT_HASH in the spec, empty file, oversize, wrong content type, another tenant, no blob store, sandbox", async () => {
      const t = await seedEvidenceTenant(w, [[{ type: "OWNER_ACK" }], [{ type: "ARTIFACT_HASH", sha256: sha256Bytes(bytes) }]]);
      const tok = () => w.token(t.tenantId);
      const app = w.app({ evidence: evidenceDeps(w, liveSource(netStub({})), { blobs: fileBlobStore(blobDir), maxArtifactBytes: 64 }) });
      expect((await upload(app, tok(), t.milestones[0])).status).toBe(422);
      expect((await upload(app, tok(), t.milestones[1], new Uint8Array(0))).status).toBe(400);
      expect((await upload(app, tok(), t.milestones[1], new Uint8Array(65))).status).toBe(413);
      expect((await call(app, "POST", "/v1/evidence/artifact", tok(), { milestoneId: t.milestones[1] })).status).toBe(415);
      expect((await upload(app, tok(), "not-a-milestone")).status).toBe(400);
      const other = await seedEvidenceTenant(w, [[{ type: "OWNER_ACK" }]]);
      expect((await upload(app, w.token(other.tenantId), t.milestones[1])).status).toBe(404);
      expect(await count(w, t.milestones[1] as string)).toBe(0);
      // default (no blob dir configured): fail closed, no evidence recorded
      const noStore = w.app({ evidence: evidenceDeps(w, liveSource(netStub({}))) });
      expect((await upload(noStore, tok(), t.milestones[1])).status).toBe(503);
      expect(await count(w, t.milestones[1] as string)).toBe(0);
    });
  });

  describe("production profile: owner acks (EIP-712 MilestoneAck)", () => {
    const deadline = (): bigint => BigInt(Math.floor(Date.now() / 1000) + 3600);
    const ZERO = `0x${"00".repeat(32)}` as Hex32;
    const mk = async (specs: ReadonlyArray<readonly EvidenceRequirement[]> = [[{ type: "OWNER_ACK" }]]) => {
      const t = await seedEvidenceTenant(w, specs);
      return { t, app: w.app({ evidence: evidenceDeps(w, liveSource(netStub({}))) }), tok: () => w.token(t.tenantId) };
    };
    const body = async (owner: any, m: Hex32, over: Record<string, unknown> = {}, signWith: any = owner) => {
      const msg = { milestoneId: m, artifactHash: ZERO, override: false, deadline: deadline(), ...over } as any;
      return { milestoneId: msg.milestoneId, artifactHash: msg.artifactHash, override: msg.override, deadline: msg.deadline.toString(), signature: await signAck(signWith, msg) };
    };

    it("a valid owner signature is recorded as PASS evidence carrying the signature; the same ack again is the same row", async () => {
      const { t, app, tok } = await mk();
      const m = t.milestones[0] as Hex32;
      const b = await body(t.owner, m);
      const r = await call(app, "POST", "/v1/evidence/ack", tok(), b);
      expect(r.status).toBe(201);
      expect(r.json).toMatchObject({ type: "OWNER_ACK", result: "PASS", collectedBy: "kernel", source: "owner:eip712:MilestoneAck" });
      expect(r.json.payload).toMatchObject({ signer: t.owner.address, override: false, artifactHash: ZERO, signature: b.signature, requirementHash: hashJcs({ type: "OWNER_ACK" }) });
      const again = await call(app, "POST", "/v1/evidence/ack", tok(), b);
      expect(again.status).toBe(201);
      expect(again.json.evidenceId).toBe(r.json.evidenceId);
      expect(await count(w, m)).toBe(1);
    });

    it("refuses a signature from anyone but the engagement owner, a different message, or another chain/vault domain", async () => {
      const { t, app, tok } = await mk();
      const m = t.milestones[0] as Hex32;
      const attacker = privateKeyToAccount(generatePrivateKey());
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), await body(t.owner, m, {}, attacker))).status).toBe(422);
      const good = await body(t.owner, m);
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), { ...good, override: true })).status).toBe(422); // signed false, submitted true
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), { ...good, artifactHash: hashJcs("other") })).status).toBe(422);
      const wrongChain = { ...good, signature: await signAck(t.owner, { milestoneId: m, artifactHash: ZERO, override: false, deadline: BigInt(good.deadline) }, 1) };
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), wrongChain)).status).toBe(422);
      const wrongVault = { ...good, signature: await signAck(t.owner, { milestoneId: m, artifactHash: ZERO, override: false, deadline: BigInt(good.deadline) }, 31337, `0x${"12".repeat(20)}`) };
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), wrongVault)).status).toBe(422);
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), { ...good, signature: "0x1234" })).status).toBe(422);
      expect(await count(w, m)).toBe(0);
    });

    it("expired and far-future deadlines are refused", async () => {
      const { t, app, tok } = await mk();
      const m = t.milestones[0] as Hex32;
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), await body(t.owner, m, { deadline: BigInt(Math.floor(Date.now() / 1000) - 5) }))).status).toBe(422);
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), await body(t.owner, m, { deadline: BigInt(Math.floor(Date.now() / 1000) + 40 * 24 * 3600) }))).status).toBe(422);
      expect(await count(w, m)).toBe(0);
    });

    it("an ack for a milestone that takes none is refused unless it is a signed override", async () => {
      const { t, app, tok } = await mk([[urlSpec()]]);
      const m = t.milestones[0] as Hex32;
      expect((await call(app, "POST", "/v1/evidence/ack", tok(), await body(t.owner, m))).status).toBe(422);
      const ov = await call(app, "POST", "/v1/evidence/ack", tok(), await body(t.owner, m, { override: true }));
      expect(ov.status).toBe(201);
      expect(ov.json.payload).toMatchObject({ override: true });
      expect(ov.json.details).toContain("override");
    });

    it("another tenant cannot ack this tenant's milestone, and malformed bodies are 400", async () => {
      const { t, app } = await mk();
      const other = await seedEvidenceTenant(w, [[{ type: "OWNER_ACK" }]]);
      const b = await body(t.owner, t.milestones[0] as Hex32);
      expect((await call(app, "POST", "/v1/evidence/ack", w.token(other.tenantId), b)).status).toBe(404);
      for (const bad of [{}, { ...b, extra: 1 }, { ...b, deadline: "-1" }, { ...b, override: "no" }, { ...b, signature: "nothex" }]) {
        expect((await call(app, "POST", "/v1/evidence/ack", w.token(t.tenantId), bad as any)).status).toBe(400);
      }
    });
  });

  describe("sandbox profile: fixtures only, zero outbound requests (RT-02, SEC-02)", () => {
    const sbTok = (tenantId: string): string => w.token(tenantId, { profile: "sandbox" });

    it("evidence exists only for the exact fixture; every other reference is EVIDENCE_SOURCE_DENIED; nothing is ever fetched", async () => {
      const hostileUrl = "https://169.254.169.254/latest/meta-data/";
      const t = await seedEvidenceTenant(w, [[urlSpec(), ciSpec(), urlSpec(hostileUrl), { type: "OWNER_ACK" }]]);
      const m = t.milestones[0] as Hex32;
      const fixture: EvidenceFixture = { fixtureId: "scn-1-health", milestoneId: m, requirement: urlSpec(), result: "PASS", payload: { status: 200 }, details: "scenario: site is healthy", availableAt: null };
      const probe = netStub(DNS); // never wired into the sandbox; proves nothing else is reachable by asserting it stays untouched
      const app = w.app({ profile: "sandbox", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: createFixtureStore([fixture]) }) });
      const r = await call(app, "POST", "/v1/evidence/collect", sbTok(t.tenantId), { milestoneId: m });
      expect(r.status).toBe(200);
      expect(r.json.mode).toBe("fixtures");
      expect(r.json.evidence.filter((e: any) => e.result === "PASS").map((e: any) => e.source)).toEqual(["fixture:scn-1-health"]);
      expect(r.json.denied.map((d: any) => [d.index, d.type, d.guardCode])).toEqual([[1, "CI_PASS", "EGRESS_DISABLED"], [2, "URL_HEALTH", "EGRESS_DISABLED"], [3, "OWNER_ACK", "EGRESS_DISABLED"]]);
      expect(r.json.pending).toEqual([]);
      expect(probe.dnsCalls).toEqual([]);
      expect(probe.requests).toEqual([]);
      const stored = JSON.stringify(await rowsOf(w, t.tenantId, m));
      expect(stored).not.toContain("169.254");
      // idempotent: collecting again adds nothing
      const again = await call(app, "POST", "/v1/evidence/collect", sbTok(t.tenantId), { milestoneId: m });
      expect(again.json.evidence).toEqual([]);
      expect(await count(w, m)).toBe(4);
    });

    it("a fixture that is not yet visible on the scenario clock, or for another milestone, resolves nothing", async () => {
      const t = await seedEvidenceTenant(w, [[urlSpec()], [urlSpec()]]);
      const [m1, m2] = t.milestones as [Hex32, Hex32];
      const fx = (milestoneId: Hex32, availableAt: string | null): EvidenceFixture => ({ fixtureId: `fx-${milestoneId.slice(2, 8)}`, milestoneId, requirement: urlSpec(), result: "PASS", payload: {}, details: "d", availableAt });
      const store = createFixtureStore([fx(m1, "2099-01-01T00:00:00Z"), fx(m2, null)]);
      const app = w.app({ profile: "sandbox", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: store }) });
      const r1 = await call(app, "POST", "/v1/evidence/collect", sbTok(t.tenantId), { milestoneId: m1 });
      expect(r1.json.evidence.map((e: any) => e.result)).toEqual(["ERROR"]);
      const r2 = await call(app, "POST", "/v1/evidence/collect", sbTok(t.tenantId), { milestoneId: m2 });
      expect(r2.json.evidence.map((e: any) => e.result)).toEqual(["PASS"]);
    });

    it("an empty store denies everything; uploads and acks are refused outright (403)", async () => {
      const t = await seedEvidenceTenant(w, [[{ type: "OWNER_ACK" }, { type: "ARTIFACT_HASH", sha256: hashJcs("x") }]]);
      const m = t.milestones[0] as Hex32;
      const app = w.app({ profile: "sandbox", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: emptyFixtureStore }) });
      const tok = (): string => sbTok(t.tenantId);
      const r = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(r.json.denied).toHaveLength(2);
      expect(r.json.evidence.every((e: any) => e.result === "ERROR")).toBe(true);
      const ack = await call(app, "POST", "/v1/evidence/ack", tok(), { milestoneId: m, artifactHash: `0x${"00".repeat(32)}`, override: false, deadline: "9999999999", signature: await signAck(t.owner, { milestoneId: m, artifactHash: `0x${"00".repeat(32)}`, override: false, deadline: 9999999999n }) });
      expect(ack.status).toBe(403);
      const up = await call(app, "POST", "/v1/evidence/artifact", tok(), form({ milestoneId: m, file: new Blob([enc.encode("x")]) }));
      expect(up.status).toBe(403);
    });

    it("the wrong source for the profile cannot be constructed: sandbox+live and production+fixtures both throw", () => {
      expect(() => w.app({ profile: "sandbox", evidence: evidenceDeps(w, liveSource(netStub({})), { profile: "sandbox" }) })).toThrow(/sandbox profile may only use fixture/);
      expect(() => w.app({ profile: "production", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: emptyFixtureStore }, { profile: "production" }) })).toThrow(/production profile may not use fixture/);
      expect(() => w.app({ profile: "production", evidence: evidenceDeps(w, liveSource(netStub({})), { profile: "sandbox" }) })).toThrow(/another profile/);
    });
  });
});
