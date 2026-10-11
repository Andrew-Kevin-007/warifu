import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { artifactSha256, ciRuns, defaultEvidenceState, startMockEvidenceServer, type RunningMock } from "../src/evidence-stubs";
import { CI_REPO, WORLD } from "../src/world";

describe("local evidence stubs", () => {
  let mock: RunningMock;
  beforeAll(async () => {
    mock = await startMockEvidenceServer({
      ...defaultEvidenceState(),
      repos: { [CI_REPO]: ciRuns({ api: "success", deploy: "failure" }) },
    });
  });
  afterAll(async () => {
    await mock.close();
  });

  const refOf = (slug: string) => {
    const spec = WORLD["S-B"].template.milestones.find((m) => m.slug === slug)?.evidenceSpec[0];
    if (spec?.type !== "CI_PASS") throw new Error("expected a CI_PASS spec");
    return spec.ref;
  };

  it("binds loopback only", () => {
    expect(mock.baseUrl.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("serves a green run for one milestone's pinned ref and a red run for the other", async () => {
    const get = async (slug: string) => {
      const res = await fetch(`${mock.baseUrl}/repos/${CI_REPO}/actions/workflows/ci.yml/runs?head_sha=${refOf(slug)}`);
      expect(res.status).toBe(200);
      return (await res.json()) as { total_count: number; workflow_runs: Array<{ conclusion: string; head_sha: string }> };
    };
    const green = await get("api");
    const red = await get("deploy");
    expect(green.total_count).toBe(1);
    expect(green.workflow_runs[0]?.conclusion).toBe("success");
    expect(green.workflow_runs[0]?.head_sha).toBe(refOf("api"));
    expect(red.workflow_runs[0]?.conclusion).toBe("failure");
  });

  it("returns no runs for a ref that was never built, and 404 for an unknown repo (so missing evidence stays missing)", async () => {
    const none = await fetch(`${mock.baseUrl}/repos/${CI_REPO}/actions/workflows/ci.yml/runs?head_sha=${"0".repeat(40)}`);
    expect(((await none.json()) as { total_count: number }).total_count).toBe(0);
    const unknown = await fetch(`${mock.baseUrl}/repos/nobody/nothing/actions/workflows/ci.yml/runs`);
    expect(unknown.status).toBe(404);
  });

  it("serves health endpoints and hashable artifacts", async () => {
    expect((await fetch(`${mock.baseUrl}/health/ok`)).status).toBe(200);
    expect((await fetch(`${mock.baseUrl}/health/down`)).status).toBe(500);
    expect((await fetch(`${mock.baseUrl}/health/missing`)).status).toBe(404);
    const body = await (await fetch(`${mock.baseUrl}/artifacts/design-v3`)).text();
    expect(artifactSha256(body)).toMatch(/^0x[0-9a-f]{64}$/);
    expect((await fetch(`${mock.baseUrl}/artifacts/none`)).status).toBe(404);
  });

  it("is read-only", async () => {
    const res = await fetch(`${mock.baseUrl}/health/ok`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
