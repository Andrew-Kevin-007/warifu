// K-09 EVIDENCE_MATCH and the evidence assessment (docs/04 K-09, docs/13 §4.1 K-09: untrusted sources ignored, stale
// evidence, hash mismatch, SSRF source policy (pure side), sandbox fixtures mode).
import { describe, expect, it } from "vitest";
import type { Evidence, EvidenceRequirement } from "@symbolon/schemas";
import { untrusted } from "@symbolon/schemas";
import { assessEvidence, evaluate, evidenceCollectionPlan, urlSourceDecision } from "../src/index";
import type { KernelContext } from "../src/index";
import { ATTACKER, H, M1, M2, OWNER, context, engagement, expectCheck, intent, milestone, ownerAck, policy } from "./helpers";

const SHA = "a".repeat(40);
const ALLOW = ["https://*.vercel.app", "https://status.acme.example"];
const P = policy({ evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ALLOW } });
const URL = "https://acme.vercel.app/health";
const PIN = H("deliverable body");

function ctxWithSpec(spec: EvidenceRequirement[], evidence: Evidence[], over: Partial<KernelContext> = {}): KernelContext {
  const e = engagement({ milestones: [milestone(M1, "design", { evidenceSpec: spec }), milestone(M2, "build")] });
  return context({ engagement: e, milestone: e.milestones[0] ?? null, evidence, ...over });
}

let seq = 0;
function ev(type: Evidence["type"], source: string, payload: unknown, over: Partial<Evidence> = {}): Evidence {
  seq++;
  return {
    evidenceId: `b0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    milestoneId: M1,
    type,
    collectedBy: "kernel",
    collectedAt: "2026-10-05T11:00:00Z",
    source,
    payload: payload as Evidence["payload"],
    payloadHash: H(`payload ${seq}`),
    result: "PASS",
    details: untrusted("collector note"),
    ...over,
  };
}

const k09 = (ctx: KernelContext, p = P) => evaluate(intent(), ctx, p);
const ci = (payload: Record<string, unknown>, over: Partial<Evidence> = {}) => ev("CI_PASS", "github:actions", { repo: "acme/site", ref: SHA, headSha: SHA, conclusion: "success", ...payload }, over);
const url = (payload: Record<string, unknown>, over: Partial<Evidence> = {}) => ev("URL_HEALTH", URL, { url: URL, status: 200, bodySha256: PIN, ...payload }, over);
const art = (sha256: unknown, over: Partial<Evidence> = {}) => ev("ARTIFACT_HASH", "kernel:artifact", { sha256 }, over);
const fixture = (requirement: EvidenceRequirement, over: Partial<Evidence> = {}) => ev(requirement.type, "fixture:S-A-design-0", { requirement, acknowledged: true }, over);

describe("K-09 basics", () => {
  it("the base world's owner acknowledgement passes and is referenced", () => {
    const e = k09(context());
    expectCheck(e, "K-09", null, null);
    expect(e.checks.find((c) => c.id === "K-09")?.refs).toEqual(["evidence:a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"]);
  });

  it.each([
    ["no evidence", []],
    ["evidence not collected by the kernel", [{ ...ownerAck(), collectedBy: "web" } as unknown as Evidence]],
    ["evidence for another milestone", [ownerAck(M2)]],
    ["evidence dated after now", [ownerAck(M1, { collectedAt: "2026-10-05T12:00:01Z" })]],
    ["a collector ERROR", [ownerAck(M1, { result: "ERROR" })]],
    ["an acknowledgement signed by someone else", [ownerAck(M1, {}, { signer: ATTACKER })]],
    ["an acknowledgement for another milestone", [ownerAck(M1, {}, { milestoneId: M2 })]],
    ["an acknowledgement with a malformed artifact hash", [ownerAck(M1, {}, { artifactHash: "0x12" })]],
    ["an acknowledgement whose override flag is not boolean", [ownerAck(M1, {}, { override: "yes" })]],
    ["an acknowledgement that expired before collection", [ownerAck(M1, {}, { deadline: "1791197999" })]], // collected at 1791198000
    ["an acknowledgement with a non-numeric deadline", [ownerAck(M1, {}, { deadline: "soon" })]],
    ["an acknowledgement whose payload is not an object", [ownerAck(M1, { payload: "ack" })]],
    ["an acknowledgement with a missing signer", [ownerAck(M1, { payload: { milestoneId: M1, artifactHash: `0x${"00".repeat(32)}`, override: false, deadline: "1893456000" } })]],
  ])("%s => HOLD EVIDENCE_MISSING", (_label, evidence) => {
    expectCheck(k09(context({ evidence })), "K-09", "HOLD", "EVIDENCE_MISSING");
  });

  it("freshness (policy.evidence.freshnessHours) applies to every type, inclusive at the boundary", () => {
    expectCheck(k09(context({ evidence: [ownerAck(M1, { collectedAt: "2026-10-02T12:00:00Z" })] })), "K-09", null, null); // exactly 72 h
    const stale = k09(context({ evidence: [ownerAck(M1, { collectedAt: "2026-10-02T11:59:59Z" })] }));
    expectCheck(stale, "K-09", "HOLD", "EVIDENCE_MISSING");
    expect(String(stale.checks.find((c) => c.id === "K-09")?.detail)).toContain("stale");
  });

  it("FAIL => HOLD EVIDENCE_FAILED; the latest observation decides (ties by evidenceId)", () => {
    expectCheck(k09(context({ evidence: [ownerAck(M1, { result: "FAIL" })] })), "K-09", "HOLD", "EVIDENCE_FAILED");
    const older = ownerAck(M1, { evidenceId: "c0000000-0000-4000-8000-000000000001", collectedAt: "2026-10-05T10:00:00Z" });
    const newerFail = ownerAck(M1, { evidenceId: "c0000000-0000-4000-8000-000000000002", result: "FAIL" });
    expectCheck(k09(context({ evidence: [newerFail, older] })), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(context({ evidence: [{ ...older, result: "FAIL" }, { ...newerFail, result: "PASS" }] })), "K-09", null, null);
    const tieA = ownerAck(M1, { evidenceId: "d0000000-0000-4000-8000-000000000001", result: "FAIL" });
    const tieB = ownerAck(M1, { evidenceId: "d0000000-0000-4000-8000-000000000002" });
    expectCheck(k09(context({ evidence: [tieB, tieA] })), "K-09", null, null);
    expectCheck(k09(context({ evidence: [{ ...tieA, result: "PASS" }, { ...tieB, result: "FAIL" }] })), "K-09", "HOLD", "EVIDENCE_FAILED");
  });

  it("no engagement, no signed milestone, or an unreadable evidence list fail closed", () => {
    expectCheck(k09(context({ engagement: null })), "K-09", "REJECT", "NO_ENGAGEMENT");
    expectCheck(evaluate({ ...intent(), milestoneId: H("not a milestone") }, context(), P), "K-09", "REJECT", "UNKNOWN_MILESTONE");
    expectCheck(k09(context({ evidence: null as unknown as Evidence[] })), "K-09", "HOLD", "KERNEL_ERROR");
  });
});

describe("K-09 source policy (production)", () => {
  it("a source other than the type's collector is denied: EVIDENCE_SOURCE_DENIED (fixtures never count in production)", () => {
    expectCheck(k09(context({ evidence: [ownerAck(M1, { source: "github:actions" })] })), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED");
    expectCheck(k09(context({ evidence: [fixture({ type: "OWNER_ACK" })] })), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED");
  });

  it("CI_PASS: success on the pinned commit passes; red CI, another commit or no commit fail; another repo/workflow is not evidence", () => {
    const spec: EvidenceRequirement[] = [{ type: "CI_PASS", repo: "acme/site", ref: SHA }];
    expectCheck(k09(ctxWithSpec(spec, [ci({})])), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(spec, [ci({ headSha: SHA.toUpperCase() })])), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(spec, [ci({ conclusion: "failure" })])), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(ctxWithSpec(spec, [ci({ headSha: "b".repeat(40) })])), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(ctxWithSpec(spec, [ci({ headSha: null })])), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(ctxWithSpec(spec, [ci({ repo: "evil/site" })])), "K-09", "HOLD", "EVIDENCE_MISSING");
    expectCheck(k09(ctxWithSpec(spec, [ci({}, { payload: [] })])), "K-09", "HOLD", "EVIDENCE_MISSING");
    const branch: EvidenceRequirement[] = [{ type: "CI_PASS", repo: "acme/site", ref: "main", workflow: "ci" }];
    expectCheck(k09(ctxWithSpec(branch, [ci({ ref: "main", headSha: "f".repeat(40), workflow: "ci" })])), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(branch, [ci({ ref: "main", workflow: "deploy" })])), "K-09", "HOLD", "EVIDENCE_MISSING");
  });

  it("URL_HEALTH: allowlisted URL with the expected status and pinned body passes; wrong status fails; wrong body is TAMPERED", () => {
    const spec: EvidenceRequirement[] = [{ type: "URL_HEALTH", url: URL, expectStatus: 200, contentSha256: PIN }];
    expectCheck(k09(ctxWithSpec(spec, [url({})])), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(spec, [url({ status: 500 })])), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(ctxWithSpec(spec, [url({ bodySha256: H("something else") })])), "K-09", "REJECT", "EVIDENCE_HASH_MISMATCH");
    expectCheck(k09(ctxWithSpec(spec, [url({ url: "https://acme.vercel.app/other" })])), "K-09", "HOLD", "EVIDENCE_MISSING");
    const unpinned: EvidenceRequirement[] = [{ type: "URL_HEALTH", url: URL, expectStatus: 200 }];
    expectCheck(k09(ctxWithSpec(unpinned, [url({ bodySha256: null })])), "K-09", null, null);
  });

  it("URL_HEALTH outside the allowlist is denied even when evidence exists (domains come from the signed spec AND the policy)", () => {
    const off = "https://evil.example/health";
    const spec: EvidenceRequirement[] = [{ type: "URL_HEALTH", url: off, expectStatus: 200 }];
    expectCheck(k09(ctxWithSpec(spec, [ev("URL_HEALTH", off, { url: off, status: 200, bodySha256: null })])), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED");
    expectCheck(k09(ctxWithSpec(spec, []), policy()), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED"); // default allowlist is empty
  });

  it("ARTIFACT_HASH: the kernel-computed hash must equal the signed spec hash", () => {
    const spec: EvidenceRequirement[] = [{ type: "ARTIFACT_HASH", sha256: PIN }];
    expectCheck(k09(ctxWithSpec(spec, [art(PIN)])), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(spec, [art(H("x"))])), "K-09", "REJECT", "EVIDENCE_HASH_MISMATCH");
    expectCheck(k09(ctxWithSpec(spec, [art(42)])), "K-09", "HOLD", "EVIDENCE_MISSING");
  });

  it("all_of: the most actionable reason is reported (TAMPERED > DENIED > FAILED > MISSING) and every requirement is listed", () => {
    const spec: EvidenceRequirement[] = [{ type: "OWNER_ACK" }, { type: "CI_PASS", repo: "acme/site", ref: SHA }, { type: "URL_HEALTH", url: "https://nope.example/x", expectStatus: 200 }];
    const e = k09(ctxWithSpec(spec, [ownerAck(), ci({ conclusion: "failure" })]));
    expectCheck(e, "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED");
    const detail = String(e.checks.find((c) => c.id === "K-09")?.detail);
    expect(detail).toContain("requirement 2 (URL_HEALTH)");
    expect(detail).toContain("requirement 1 (CI_PASS)");
    const withArtifact = k09(ctxWithSpec([...spec, { type: "ARTIFACT_HASH", sha256: PIN }], [ownerAck(), art(H("x"))]));
    expectCheck(withArtifact, "K-09", "REJECT", "EVIDENCE_HASH_MISMATCH");
  });

  it("the all_of is satisfied when its LAST requirement was satisfied, whatever the order", () => {
    const spec: EvidenceRequirement[] = [{ type: "OWNER_ACK" }, { type: "ARTIFACT_HASH", sha256: PIN }];
    const m = milestone(M1, "design", { evidenceSpec: spec });
    const early = art(PIN, { collectedAt: "2026-10-05T09:00:00Z" });
    const lateAck = ownerAck(M1, { collectedAt: "2026-10-05T11:30:00Z" });
    expect(assessEvidence(m, OWNER, ctxWithSpec(spec, [lateAck, early]), P).satisfiedAt).toBe("2026-10-05T11:30:00Z");
    const m2 = milestone(M1, "design", { evidenceSpec: [...spec].reverse() });
    expect(assessEvidence(m2, OWNER, ctxWithSpec([...spec].reverse(), [lateAck, early]), P).satisfiedAt).toBe("2026-10-05T11:30:00Z");
  });

  it("an OWNER_ACK that is not a valid acknowledgement is not an override either", () => {
    const spec: EvidenceRequirement[] = [{ type: "CI_PASS", repo: "acme/site", ref: SHA }];
    expectCheck(k09(ctxWithSpec(spec, [ownerAck(M1, {}, { override: true, signer: ATTACKER })])), "K-09", "HOLD", "EVIDENCE_MISSING");
  });

  it("an empty evidence spec (signed by both parties) is satisfied at invoiceReceivedAt", () => {
    const ctx = ctxWithSpec([], []);
    expectCheck(k09(ctx), "K-09", null, null);
    const m = ctx.engagement?.milestones[0];
    if (m === undefined) throw new Error("fixture");
    expect(assessEvidence(m, OWNER, ctx, P)).toMatchObject({ satisfied: true, satisfiedAt: ctx.invoiceReceivedAt });
  });
});

describe("owner override", () => {
  const spec: EvidenceRequirement[] = [{ type: "CI_PASS", repo: "acme/site", ref: SHA }, { type: "URL_HEALTH", url: URL, expectStatus: 200, contentSha256: PIN }];
  const override = ownerAck(M1, { evidenceId: "e0000000-0000-4000-8000-000000000001", collectedAt: "2026-10-05T11:30:00Z" }, { override: true });

  it("an OWNER_ACK with override=true satisfies missing or failed requirements when the policy allows it", () => {
    const e = k09(ctxWithSpec(spec, [override, ci({ conclusion: "failure" })]));
    expectCheck(e, "K-09", null, null);
    expect(String(e.checks.find((c) => c.id === "K-09")?.detail)).toContain("owner override");
    const m = ctxWithSpec(spec, []).engagement?.milestones[0];
    if (m === undefined) throw new Error("fixture");
    expect(assessEvidence(m, OWNER, ctxWithSpec(spec, [override]), P)).toMatchObject({ satisfied: true, satisfiedAt: "2026-10-05T11:30:00Z", overrideBy: override.evidenceId });
  });

  it("but never a TAMPERED one, never when the policy forbids overrides, never in the sandbox, never a stale or failed override", () => {
    expectCheck(k09(ctxWithSpec(spec, [override, url({ bodySha256: H("bad") })])), "K-09", "REJECT", "EVIDENCE_HASH_MISMATCH");
    const strict = policy({ evidence: { freshnessHours: 72, allowOwnerOverride: false, urlAllowlist: ALLOW } });
    expectCheck(k09(ctxWithSpec(spec, [override]), strict), "K-09", "HOLD", "EVIDENCE_MISSING");
    expectCheck(k09(ctxWithSpec(spec, [override], { profile: "sandbox" })), "K-09", "HOLD", "EVIDENCE_MISSING"); // no override in the sandbox
    expectCheck(k09(ctxWithSpec(spec, [{ ...override, collectedAt: "2026-10-01T00:00:00Z" }])), "K-09", "HOLD", "EVIDENCE_MISSING");
    expectCheck(k09(ctxWithSpec(spec, [{ ...override, result: "FAIL" }])), "K-09", "HOLD", "EVIDENCE_MISSING");
    expectCheck(k09(ctxWithSpec(spec, [{ ...override, source: "github:actions" }])), "K-09", "HOLD", "EVIDENCE_MISSING");
    const two = [override, { ...override, evidenceId: "e0000000-0000-4000-8000-000000000002", collectedAt: "2026-10-05T11:45:00Z" }];
    const m = ctxWithSpec(spec, []).engagement?.milestones[0];
    if (m === undefined) throw new Error("fixture");
    expect(assessEvidence(m, OWNER, ctxWithSpec(spec, two), P).overrideBy).toBe("e0000000-0000-4000-8000-000000000002");
  });
});

describe("sandbox profile (fixtures only, P-SANDBOX-NO-FETCH pure side)", () => {
  const spec: EvidenceRequirement[] = [{ type: "URL_HEALTH", url: URL, expectStatus: 200 }];

  it("a fixture for the exact spec entry is the only evidence; its result is authoritative", () => {
    expectCheck(k09(ctxWithSpec(spec, [fixture(spec[0] as EvidenceRequirement)], { profile: "sandbox" })), "K-09", null, null);
    expectCheck(k09(ctxWithSpec(spec, [fixture(spec[0] as EvidenceRequirement, { result: "FAIL" })], { profile: "sandbox" })), "K-09", "HOLD", "EVIDENCE_FAILED");
    expectCheck(k09(ctxWithSpec(spec, [], { profile: "sandbox" })), "K-09", "HOLD", "EVIDENCE_MISSING");
  });

  it("anything else is denied: a production-collected record, a fixture for another entry, a malformed fixture id or payload", () => {
    const other: EvidenceRequirement = { type: "URL_HEALTH", url: "https://acme.vercel.app/other", expectStatus: 200 };
    const noRequirement = { ...fixture(spec[0] as EvidenceRequirement), payload: { acknowledged: true } };
    for (const evidence of [[url({})], [fixture(other)], [{ ...fixture(spec[0] as EvidenceRequirement), source: "fixture:bad id!" }], [{ ...fixture(spec[0] as EvidenceRequirement), payload: "x" }], [noRequirement]]) {
      expectCheck(k09(ctxWithSpec(spec, evidence, { profile: "sandbox" })), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED");
    }
    const unknownProfile = { ...ctxWithSpec(spec, [url({})]), profile: "staging" as unknown as KernelContext["profile"] };
    expectCheck(k09(unknownProfile), "K-09", "HOLD", "EVIDENCE_SOURCE_DENIED"); // not exactly 'production' => fixtures only
  });

  it("the collection plan never hands out a URL in the sandbox; in production only allowlisted URLs", () => {
    const full: EvidenceRequirement[] = [{ type: "OWNER_ACK" }, { type: "CI_PASS", repo: "acme/site", ref: SHA }, { type: "URL_HEALTH", url: URL, expectStatus: 200 }, { type: "URL_HEALTH", url: "https://10.0.0.1/x", expectStatus: 200 }, { type: "ARTIFACT_HASH", sha256: PIN }];
    const m = milestone(M1, "design", { evidenceSpec: full });
    expect(evidenceCollectionPlan(m, "sandbox", P)).toEqual(full.map((_, index) => ({ kind: "FIXTURE", index })));
    expect(evidenceCollectionPlan(m, "production", P)).toEqual([
      { kind: "OWNER_ACK", index: 0 },
      { kind: "GITHUB_ACTIONS", index: 1, repo: "acme/site", ref: SHA },
      { kind: "URL_HEALTH", index: 2, url: URL },
      { kind: "DENIED", index: 3, reason: "IP_LITERAL" },
      { kind: "ARTIFACT", index: 4, sha256: PIN },
    ]);
  });
});

describe("urlSourceDecision (the pure half of the SSRF guard)", () => {
  it.each([
    ["http://acme.vercel.app/x", "SCHEME"],
    ["ftp://acme.vercel.app", "SCHEME"],
    ["https://user@acme.vercel.app/x", "USERINFO"],
    ["https://[::1]/x", "IP_LITERAL"],
    ["https://[::ffff:127.0.0.1]:443/", "IP_LITERAL"],
    ["https://acme.vercel.app:8443/x", "PORT"],
    ["https://acme.vercel.app:/x", "PORT"],
    ["https://localhost/x", "HOST_SYNTAX"],
    ["https://2130706433/x", "HOST_SYNTAX"],
    ["https://127.0.0.1/x", "IP_LITERAL"],
    ["https://0x7f.0.0.1/x", "IP_LITERAL"],
    ["https://169.254.169.254/latest", "IP_LITERAL"],
    ["https://acme.vercel.app./x", "HOST_SYNTAX"],
    ["https://-bad.vercel.app/x", "HOST_SYNTAX"],
    ["https://xn--caf-dma.vercel.app/x", null],
    [`https://cafe${String.fromCodePoint(0x301)}.vercel.app/x`, "HOST_SYNTAX"],
    [`https://${"a".repeat(250)}.app/x`, "HOST_SYNTAX"],
    ["https://vercel.app/x", "NOT_ALLOWLISTED"],
    ["https://evilvercel.app/x", "NOT_ALLOWLISTED"],
    ["https://acme.vercel.app.evil.example/x", "NOT_ALLOWLISTED"],
    ["https://ACME.Vercel.App/x", null],
    ["https://acme.vercel.app:443/x?q=1#f", null],
    ["https://acme.vercel.app", null],
    ["https://status.acme.example/ok", null],
    ["https://www.status.acme.example/ok", "NOT_ALLOWLISTED"],
  ])("%s => %s", (u, expected) => {
    const d = urlSourceDecision(u, ALLOW);
    expect(d.allowed ? null : d.reason).toBe(expected);
  });

  it("an empty allowlist denies everything; a non-string is refused", () => {
    expect(urlSourceDecision("https://acme.vercel.app", [])).toEqual({ allowed: false, reason: "NOT_ALLOWLISTED" });
    expect(urlSourceDecision(42 as unknown as string, ALLOW)).toEqual({ allowed: false, reason: "SCHEME" });
  });
});
