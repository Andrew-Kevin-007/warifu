// End-to-end-ish evidence contract (docs/QUESTIONS.md "WP-05 kernel fixes", finding 1): the REAL service evidence routes over a
// real Postgres write the rows, the context assembler's own reader (`loadEvidence`) loads them, and the REAL kernel-core
// `assessEvidence` reads them. Before the fix every sandbox record came out DENIED here (payload.requirement missing) and
// every production OWNER_ACK / URL_HEALTH / ARTIFACT_HASH record did too (source strings differed). Faked: the two network
// edges (DNS + HTTPS) and the chain READ edge, exactly as in evidence.local.test.ts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assessEvidence } from "@symbolon/kernel-core";
import type { KernelContext } from "@symbolon/kernel-core";
import { normalizePolicy } from "@symbolon/policy";
import { hashJcs, sha256Bytes } from "@symbolon/schemas";
import type { EvidenceFixture, EvidenceRequirement, Hex32 } from "@symbolon/schemas";
import { fileBlobStore } from "../../src/blob/store";
import * as dbrepo from "../../src/db/repo";
import { createFixtureStore } from "../../src/evidence/fixtures";
import type { EvidenceSource } from "../../src/evidence/service";
import { dbSuiteEnabled } from "../helpers/pgdb";
import { call, form, POLICY_INPUT } from "../helpers/world";
import type { World } from "../helpers/world";
import { enc, evidenceDeps, jsonResponse, netStub, openWorld, seedEvidenceTenant, signAck } from "../helpers/evidence-world";
import type { SeededTenant } from "../helpers/evidence-world";

const enabled = dbSuiteEnabled("kernel-contract.local");
const SHA = "d".repeat(40);
const DNS = { "api.github.com": ["140.82.112.5"], "site.example.com": ["93.184.216.34"] };
const EVIDENCE_POLICY = { evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://site.example.com"] } };

const ci: EvidenceRequirement = { type: "CI_PASS", repo: "acme/site", ref: SHA, workflow: "ci.yml" };
const health: EvidenceRequirement = { type: "URL_HEALTH", url: "https://site.example.com/health", expectStatus: 200 };
const ack: EvidenceRequirement = { type: "OWNER_ACK" };
const runDoc = { workflow_runs: [{ id: 3, head_branch: "main", head_sha: SHA, status: "completed", conclusion: "success", created_at: "2026-10-12T08:00:00Z" }] };

const isoPlus = (seconds: number): string => new Date(Math.floor(Date.now() / 1000) * 1000 + seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

describe.skipIf(!enabled)("local: rows the service writes are accepted by kernel-core K-09", () => {
  let w: World;
  let blobDir: string;
  beforeAll(async () => {
    w = await openWorld();
    blobDir = mkdtempSync(join(tmpdir(), "symbolon-evcontract-"));
  }, 120_000);
  afterAll(async () => {
    await w.close();
    rmSync(blobDir, { recursive: true, force: true });
  }, 120_000);

  /** What the context assembler hands the kernel: the stored rows, read back by the service's own reader. */
  async function assess(t: SeededTenant, index: number, profile: "production" | "sandbox") {
    const milestone = t.engagement.milestones[index];
    if (milestone === undefined) throw new Error("no such milestone");
    const { evidence } = await dbrepo.loadEvidence(w.t.db, t.tenantId, milestone.milestoneId);
    const ctx = { profile, now: isoPlus(120), evidence, invoiceReceivedAt: isoPlus(-60) } as unknown as KernelContext;
    return assessEvidence(milestone, t.engagement.owner, ctx, normalizePolicy({ ...POLICY_INPUT, ...EVIDENCE_POLICY }));
  }

  describe("sandbox profile", () => {
    const sbTok = (t: SeededTenant): string => w.token(t.tenantId, { profile: "sandbox" });
    const fixture = (m: Hex32, requirement: EvidenceRequirement, fixtureId: string, over: Partial<EvidenceFixture> = {}): EvidenceFixture => ({ fixtureId, milestoneId: m, requirement, result: "PASS", payload: { note: "scenario" }, details: "scenario evidence", availableAt: null, ...over });

    it("scenario fixtures for the exact spec entries make the all_of SATISFIED; a requirement with no fixture stays DENIED (nothing else resolves)", async () => {
      const t = await seedEvidenceTenant(w, [[health, ci, ack], [health, ci]], { policyExtra: EVIDENCE_POLICY });
      const [m1, m2] = t.milestones as [Hex32, Hex32];
      const store = createFixtureStore([
        fixture(m1, health, "s-health"),
        fixture(m1, ci, "s-ci"),
        fixture(m1, ack, "s-ack", { payload: { acknowledged: true } }),
        fixture(m2, health, "s-health-2"), // m2 has no CI fixture
      ]);
      const app = w.app({ profile: "sandbox", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: store }) });
      expect((await call(app, "POST", "/v1/evidence/collect", sbTok(t), { milestoneId: m1 })).status).toBe(200);
      expect((await call(app, "POST", "/v1/evidence/collect", sbTok(t), { milestoneId: m2 })).status).toBe(200);

      const a1 = await assess(t, 0, "sandbox");
      expect(a1.requirements.map((r) => r.state)).toEqual(["SATISFIED", "SATISFIED", "SATISFIED"]);
      expect(a1.satisfied).toBe(true);
      const a2 = await assess(t, 1, "sandbox");
      expect(a2.requirements.map((r) => r.state)).toEqual(["SATISFIED", "DENIED"]);
      expect(a2.satisfied).toBe(false);
    });

    it("a FAIL fixture is FAILED; a fixture not yet visible on the scenario clock is not evidence", async () => {
      const t = await seedEvidenceTenant(w, [[health], [health]], { policyExtra: EVIDENCE_POLICY });
      const [m1, m2] = t.milestones as [Hex32, Hex32];
      const store = createFixtureStore([fixture(m1, health, "s-red", { result: "FAIL" }), fixture(m2, health, "s-late", { availableAt: "2099-01-01T00:00:00Z" })]);
      const app = w.app({ profile: "sandbox", evidence: evidenceDeps(w, { kind: "fixtures", fixtures: store }) });
      await call(app, "POST", "/v1/evidence/collect", sbTok(t), { milestoneId: m1 });
      await call(app, "POST", "/v1/evidence/collect", sbTok(t), { milestoneId: m2 });
      expect((await assess(t, 0, "sandbox")).requirements.map((r) => r.state)).toEqual(["FAILED"]);
      expect((await assess(t, 1, "sandbox")).requirements.map((r) => r.state)).toEqual(["DENIED"]);
    });
  });

  describe("production profile", () => {
    const liveSource = (net: ReturnType<typeof netStub>): EvidenceSource => ({ kind: "live", guard: net, githubToken: null });

    it("CI_PASS, URL_HEALTH, ARTIFACT_HASH and a signed OWNER_ACK collected through the routes together satisfy the milestone", async () => {
      const bytes = Uint8Array.from([0, 1, 2, 3, 255, 254]);
      const t = await seedEvidenceTenant(w, [[ci, health, { type: "ARTIFACT_HASH", sha256: sha256Bytes(bytes) }, ack]], { policyExtra: EVIDENCE_POLICY });
      const m = t.milestones[0] as Hex32;
      const net = netStub(DNS, (q) => (q.host === "api.github.com" ? jsonResponse(runDoc) : { status: 200, location: null, body: enc.encode("ok"), truncated: false }));
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net), { blobs: fileBlobStore(blobDir) }) });
      const tok = (): string => w.token(t.tenantId); // tokens are single-use (DB nonce)

      const collected = await call(app, "POST", "/v1/evidence/collect", tok(), { milestoneId: m });
      expect(collected.status).toBe(200);
      const upload = await call(app, "POST", "/v1/evidence/artifact", tok(), form({ milestoneId: m, file: new Blob([bytes as unknown as ArrayBuffer]) }));
      expect(upload.status).toBe(201);
      const ZERO = `0x${"00".repeat(32)}` as Hex32;
      const msg = { milestoneId: m, artifactHash: ZERO, override: false, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600) };
      const sent = await call(app, "POST", "/v1/evidence/ack", tok(), { milestoneId: m, artifactHash: ZERO, override: false, deadline: msg.deadline.toString(), signature: await signAck(t.owner, msg) });
      expect(sent.status).toBe(201);

      const a = await assess(t, 0, "production");
      expect(a.requirements.map((r) => [r.type, r.state])).toEqual([["CI_PASS", "SATISFIED"], ["URL_HEALTH", "SATISFIED"], ["ARTIFACT_HASH", "SATISFIED"], ["OWNER_ACK", "SATISFIED"]]);
      expect(a.satisfied).toBe(true);
    });

    it("a different file than the signed hash is TAMPERED (the spec'd REJECT EVIDENCE_HASH_MISMATCH), not merely failed", async () => {
      const t = await seedEvidenceTenant(w, [[{ type: "ARTIFACT_HASH", sha256: hashJcs("the signed design") }]], { policyExtra: EVIDENCE_POLICY });
      const m = t.milestones[0] as Hex32;
      const app = w.app({ evidence: evidenceDeps(w, liveSource(netStub({})), { blobs: fileBlobStore(blobDir) }) });
      const up = await call(app, "POST", "/v1/evidence/artifact", w.token(t.tenantId), form({ milestoneId: m, file: new Blob([Uint8Array.from([7, 7, 7]) as unknown as ArrayBuffer]) }));
      expect(up.status).toBe(201);
      expect(up.json.evidence.result).toBe("FAIL");
      expect((await assess(t, 0, "production")).requirements.map((r) => r.state)).toEqual(["TAMPERED"]);
    });

    it("a red CI run is FAILED and an unreachable URL stays MISSING; neither satisfies the milestone", async () => {
      const t = await seedEvidenceTenant(w, [[ci, health]], { policyExtra: EVIDENCE_POLICY });
      const m = t.milestones[0] as Hex32;
      const red = { workflow_runs: [{ ...runDoc.workflow_runs[0], conclusion: "failure" }] };
      const net = netStub(DNS, (q) => (q.host === "api.github.com" ? jsonResponse(red) : new Error("ECONNRESET")));
      const app = w.app({ evidence: evidenceDeps(w, liveSource(net)) });
      await call(app, "POST", "/v1/evidence/collect", w.token(t.tenantId), { milestoneId: m });
      const a = await assess(t, 0, "production");
      expect(a.requirements.map((r) => r.state)).toEqual(["FAILED", "MISSING"]);
      expect(a.satisfied).toBe(false);
    });
  });
});
