// The evidence CONTRACT between the service's collectors and kernel-core's K-09 (docs/04 K-09; docs/QUESTIONS.md
// "WP-05 kernel fixes", finding 1). The re-baseline found that the service emitted a sandbox payload K-09 rejected, so
// every sandbox evidence record was EVIDENCE_SOURCE_DENIED. These tests run REAL collector and fixture output (only the
// network edge is faked) through the REAL kernel-core `assessEvidence`, per requirement type and per profile, so the two
// sides cannot drift apart again. The DB round trip and the HTTP routes are covered in kernel-contract.local.test.ts.
import { assessEvidence, productionEvidenceSource, urlEvidenceSource } from "@symbolon/kernel-core";
import type { KernelContext, RequirementState } from "@symbolon/kernel-core";
import { normalizePolicy } from "@symbolon/policy";
import { EvidenceSchema, EvidenceFixtureSchema, hashJcs, sha256Bytes, untrusted } from "@symbolon/schemas";
import type { Address, Evidence, EvidenceFixture, EvidenceRequirement, Milestone } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { collectArtifactHash, collectCiPass, collectUrlHealth, denial, isNotYet } from "../../src/evidence/collectors";
import type { Collected } from "../../src/evidence/collectors";
import { createFixtureStore, fixtureToCollected } from "../../src/evidence/fixtures";
import type { GuardDeps, PinnedRequest, TransportResponse } from "../../src/evidence/ssrf/guard";

const OWNER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" as Address;
const M = hashJcs("contract-milestone");
const NOW = "2026-10-12T10:00:00Z";
const AT = "2026-10-12T09:00:00Z";
const SHA = "c".repeat(40);
const SITE = "https://site.example.com/health";
const enc = new TextEncoder();

const policy = (profile: "production" | "sandbox") =>
  normalizePolicy({
    version: 1,
    tenant: profile === "sandbox" ? "challenge-sandbox" : "contract-test",
    currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
    caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" },
    categories: { design: "5000" },
    evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://site.example.com"] },
  });

function net(respond: (q: PinnedRequest) => TransportResponse): GuardDeps {
  return {
    resolver: { resolve: async (h) => (h === "site.example.com" ? ["93.184.216.34"] : h === "api.github.com" ? ["140.82.112.5"] : Promise.reject(new Error("NXDOMAIN"))) },
    transport: { get: async (q) => respond(q) },
  };
}
const reply = (body: string, status = 200): TransportResponse => ({ status, location: null, body: enc.encode(body), truncated: false });
const json = (v: unknown): TransportResponse => reply(JSON.stringify(v));
const run = (conclusion: string) => ({ workflow_runs: [{ id: 7, head_branch: "main", head_sha: SHA, status: "completed", conclusion, created_at: "2026-10-12T08:00:00Z" }] });

let n = 0;
/** What `persist` + `loadEvidence` hand to the kernel: the Collected observation as an Evidence row. */
function asEvidence(c: Collected, type: Evidence["type"]): Evidence {
  n += 1;
  return EvidenceSchema.parse({
    evidenceId: `e0000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    milestoneId: M,
    type,
    collectedBy: "kernel",
    collectedAt: AT,
    source: c.source,
    payload: c.payload,
    payloadHash: hashJcs(c.payload),
    result: c.result,
    details: untrusted(c.details),
  });
}

function state(spec: readonly EvidenceRequirement[], evidence: readonly Evidence[], profile: "production" | "sandbox" = "production"): RequirementState[] {
  const milestone: Milestone = { milestoneId: M, slug: "m1", description: "contract milestone", amountBaseUnits: "1000000", partialAllowed: false, immediate: false, dueDate: null, category: "design", evidenceSpec: [...spec], status: "PENDING" };
  const ctx = { profile, now: NOW, evidence: [...evidence], invoiceReceivedAt: "2026-10-12T08:00:00Z" } as unknown as KernelContext; // assessEvidence reads exactly these four fields
  return assessEvidence(milestone, OWNER, ctx, policy(profile)).requirements.map((r) => r.state);
}

const obs = (x: Collected | { pending: true; reason: string }): Collected => {
  if (isNotYet(x as never)) throw new Error("expected an observation, got pending");
  return x as Collected;
};

describe("production collectors -> K-09", () => {
  const ci: EvidenceRequirement = { type: "CI_PASS", repo: "acme/site", ref: SHA, workflow: "ci.yml" };

  it("CI_PASS: a green run on the pinned commit satisfies the requirement; a red one fails it", async () => {
    const green = obs(await collectCiPass(ci as Extract<EvidenceRequirement, { type: "CI_PASS" }>, { guard: net(() => json(run("success"))), githubToken: null }));
    const red = obs(await collectCiPass(ci as Extract<EvidenceRequirement, { type: "CI_PASS" }>, { guard: net(() => json(run("failure"))), githubToken: null }));
    expect(state([ci], [asEvidence(green, "CI_PASS")])).toEqual(["SATISFIED"]);
    expect(state([ci], [asEvidence(red, "CI_PASS")])).toEqual(["FAILED"]);
  });

  it("URL_HEALTH: expected status satisfies, another status fails, a pinned-hash mismatch is TAMPERED (REJECT), the source is the signed url", async () => {
    const plain = { type: "URL_HEALTH", url: SITE, expectStatus: 200 } as const;
    const pinned = { type: "URL_HEALTH", url: SITE, expectStatus: 200, contentSha256: sha256Bytes(enc.encode("the signed page")) } as const;
    const ok = await collectUrlHealth(plain, ["site.example.com"], { guard: net(() => reply("anything")) });
    expect(ok.source).toBe(SITE);
    expect(ok.source).toBe(productionEvidenceSource(plain));
    expect(state([plain], [asEvidence(ok, "URL_HEALTH")])).toEqual(["SATISFIED"]);
    const down = await collectUrlHealth(plain, ["site.example.com"], { guard: net(() => reply("boom", 500)) });
    expect(state([plain], [asEvidence(down, "URL_HEALTH")])).toEqual(["FAILED"]);
    const same = await collectUrlHealth(pinned, ["site.example.com"], { guard: net(() => reply("the signed page")) });
    expect(state([pinned], [asEvidence(same, "URL_HEALTH")])).toEqual(["SATISFIED"]);
    const changed = await collectUrlHealth(pinned, ["site.example.com"], { guard: net(() => reply("the page was swapped")) });
    expect(changed.result).toBe("FAIL"); // the collector reports its mismatch as FAIL ...
    expect(state([pinned], [asEvidence(changed, "URL_HEALTH")])).toEqual(["TAMPERED"]); // ... and K-09 still reads it as the spec'd REJECT
  });

  it("URL_HEALTH: a signed url longer than the 512-char source field is matched through its hash", async () => {
    const longUrl = `https://site.example.com/${"a".repeat(600)}`;
    const spec = { type: "URL_HEALTH", url: longUrl, expectStatus: 200 } as const;
    const c = await collectUrlHealth(spec, ["site.example.com"], { guard: net(() => reply("ok")) });
    expect(c.source).toBe(urlEvidenceSource(longUrl));
    expect(state([spec], [asEvidence(c, "URL_HEALTH")])).toEqual(["SATISFIED"]);
  });

  it("URL_HEALTH: the policy allowlist still narrows what the kernel accepts, even if a collector fetched it", async () => {
    const off = { type: "URL_HEALTH", url: "https://other.example.org/health", expectStatus: 200 } as const;
    const c = await collectUrlHealth(off, ["other.example.org"], { guard: { resolver: { resolve: async () => ["93.184.216.35"] }, transport: { get: async () => reply("ok") } } });
    expect(c.result).toBe("PASS");
    expect(state([off], [asEvidence(c, "URL_HEALTH")])).toEqual(["DENIED"]);
  });

  it("a refused source (SSRF guard) is never evidence: K-09 reads it as DENIED", () => {
    const spec = { type: "URL_HEALTH", url: "https://169.254.169.254/latest/meta-data/", expectStatus: 200 } as const;
    expect(state([spec], [asEvidence(denial(spec, "DNS_NON_GLOBAL", null), "URL_HEALTH")])).toEqual(["DENIED"]);
  });

  it("a collector that could not decide (site down) is MISSING, not a refused source", async () => {
    const spec = { type: "URL_HEALTH", url: SITE, expectStatus: 200 } as const;
    const c = await collectUrlHealth(spec, ["site.example.com"], {
      guard: { resolver: { resolve: async () => ["93.184.216.34"] }, transport: { get: async () => Promise.reject(new Error("ECONNRESET")) } },
    });
    expect(c.result).toBe("ERROR");
    expect(state([spec], [asEvidence(c, "URL_HEALTH")])).toEqual(["MISSING"]);
  });

  it("ARTIFACT_HASH: the signed hash satisfies, any other file is TAMPERED (REJECT)", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 250]);
    const spec = { type: "ARTIFACT_HASH", sha256: sha256Bytes(bytes) } as const;
    expect(state([spec], [asEvidence(collectArtifactHash(spec, bytes), "ARTIFACT_HASH")])).toEqual(["SATISFIED"]);
    const wrong = collectArtifactHash(spec, Uint8Array.from([9, 9, 9]));
    expect(wrong.result).toBe("FAIL");
    expect(state([spec], [asEvidence(wrong, "ARTIFACT_HASH")])).toEqual(["TAMPERED"]);
  });
});

describe("sandbox fixtures -> K-09", () => {
  const url: EvidenceRequirement = { type: "URL_HEALTH", url: SITE, expectStatus: 200 };
  const ack: EvidenceRequirement = { type: "OWNER_ACK" };
  const fx = (requirement: EvidenceRequirement, over: Partial<EvidenceFixture> = {}): EvidenceFixture =>
    EvidenceFixtureSchema.parse({ fixtureId: "scn-1", milestoneId: M, requirement, result: "PASS", payload: { status: 200 }, details: "scenario says so", availableAt: null, ...over });

  it("a fixture the store finds for the exact spec entry satisfies it (the re-baseline's EVIDENCE_SOURCE_DENIED regression)", () => {
    const store = createFixtureStore([fx(url, { fixtureId: "scn-url" }), fx(ack, { fixtureId: "scn-ack", payload: { acknowledged: true } })]);
    const spec = [url, ack];
    const rows = spec.map((r) => {
      const f = store.find(M, r, NOW);
      if (f === null) throw new Error("fixture not found");
      return asEvidence(fixtureToCollected(f, r), r.type);
    });
    expect(state(spec, rows, "sandbox")).toEqual(["SATISFIED", "SATISFIED"]);
  });

  it("a FAIL fixture is FAILED, never a pass", () => {
    const f = fx(url, { result: "FAIL" });
    expect(state([url], [asEvidence(fixtureToCollected(f, url), "URL_HEALTH")], "sandbox")).toEqual(["FAILED"]);
  });

  it("the kernel still denies evidence that does not bind to the signed requirement", () => {
    // a record minted for a DIFFERENT entry (another url) presented against this milestone's spec
    const other: EvidenceRequirement = { type: "URL_HEALTH", url: "https://site.example.com/admin", expectStatus: 200 };
    const forged = asEvidence(fixtureToCollected(fx(other), other), "URL_HEALTH");
    expect(state([url], [forged], "sandbox")).toEqual(["DENIED"]);
    // the old service shape (hash + fixture, no `requirement`) binds to nothing
    const old = asEvidence({ source: "fixture:scn-1", payload: { requirementHash: hashJcs(url), fixtureId: "scn-1", fixture: { status: 200 } }, result: "PASS", details: "d" }, "URL_HEALTH");
    expect(state([url], [old], "sandbox")).toEqual(["DENIED"]);
    // a denial row from the sandbox store is not evidence either
    expect(state([url], [asEvidence(denial(url, "EGRESS_DISABLED", null), "URL_HEALTH")], "sandbox")).toEqual(["DENIED"]);
  });

  it("fixture evidence is never accepted by the production profile", () => {
    const f = fx(url);
    expect(state([url], [asEvidence(fixtureToCollected(f, url), "URL_HEALTH")], "production")).toEqual(["DENIED"]);
  });

});
