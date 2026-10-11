// Local evidence stubs for e2e-local runs (docs/07 §3.2): a mock "GitHub" with CI-success and CI-failure runs, a
// URL health endpoint and artifact files. It binds 127.0.0.1 only, serves canned data only, and never makes an
// outbound request. Production K-09 collectors fetch only from a signed allow-list and the sandbox uses
// fixtures with no fetching at all (docs/04 K-09), so this server is for the LOCAL profile.
//
// VERIFY(V-ATK-1): the route and JSON shape mimic GitHub's REST "list workflow runs for a workflow"
// (GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs?head_sha=... returning
// {total_count, workflow_runs: [{id, name, head_branch, head_sha, status, conclusion, created_at, updated_at}]}).
// That is from memory and was not checked against the docs offline; WP-13 owns the real collector and must
// confirm the fields it reads, then this stub follows the collector (docs/VERIFY_LOG.md).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sha256Utf8 } from "@symbolon/schemas";
import { CI_REPO, WORLD } from "./world";

export interface MockRun {
  readonly id: number;
  readonly name: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly status: "completed" | "in_progress" | "queued";
  readonly conclusion: "success" | "failure" | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MockEvidenceState {
  /** "owner/name" -> runs */
  readonly repos: Readonly<Record<string, readonly MockRun[]>>;
  /** path (e.g. "/health/ok") -> response */
  readonly health: Readonly<Record<string, { readonly status: number; readonly body: string }>>;
  /** artifact id -> file content (text) */
  readonly artifacts: Readonly<Record<string, string>>;
}

const RUN_TIME = "2026-11-02T08:00:00Z";

/** CI runs for the S-B milestones: `outcome` decides whether the run for each milestone's pinned ref is green or red. */
export function ciRuns(outcome: Readonly<Record<string, "success" | "failure">>): MockRun[] {
  const w = WORLD["S-B"];
  let id = 4000;
  const out: MockRun[] = [];
  for (const ms of w.template.milestones) {
    const req = ms.evidenceSpec[0];
    if (req === undefined || req.type !== "CI_PASS") continue;
    out.push({
      id: id++,
      name: req.workflow ?? "ci.yml",
      head_branch: "main",
      head_sha: req.ref,
      status: "completed",
      conclusion: outcome[ms.slug] ?? "failure",
      created_at: RUN_TIME,
      updated_at: RUN_TIME,
    });
  }
  return out;
}

export function defaultEvidenceState(): MockEvidenceState {
  return {
    repos: { [CI_REPO]: ciRuns({ api: "success", deploy: "success" }) },
    health: { "/health/ok": { status: 200, body: "ok" }, "/health/down": { status: 500, body: "down" } },
    artifacts: { "design-v3": "fixture artifact: not a real design file\n" },
  };
}

export function artifactSha256(content: string): string {
  return sha256Utf8(content);
}

export interface RunningMock {
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function startMockEvidenceServer(state: MockEvidenceState = defaultEvidenceState()): Promise<RunningMock> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string, type = "application/json") => {
      res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
      res.end(body);
    };
    if (req.method !== "GET") return send(405, JSON.stringify({ message: "method not allowed" }));
    const parts = url.pathname.split("/").filter((p) => p.length > 0);
    // /repos/{owner}/{repo}/actions/workflows/{workflow}/runs
    if (parts[0] === "repos" && parts[3] === "actions" && parts[4] === "workflows" && parts[6] === "runs") {
      const runs = state.repos[`${parts[1]}/${parts[2]}`];
      if (runs === undefined) return send(404, JSON.stringify({ message: "Not Found" }));
      const sha = url.searchParams.get("head_sha");
      const workflow = decodeURIComponent(parts[5] ?? "");
      const hit = runs.filter((r) => r.name === workflow && (sha === null || r.head_sha === sha));
      return send(200, JSON.stringify({ total_count: hit.length, workflow_runs: hit }));
    }
    if (parts[0] === "health") {
      const h = state.health[url.pathname];
      return h === undefined ? send(404, "not found", "text/plain") : send(h.status, h.body, "text/plain");
    }
    if (parts[0] === "artifacts") {
      const a = state.artifacts[parts[1] ?? ""];
      return a === undefined ? send(404, "not found", "text/plain") : send(200, a, "text/plain");
    }
    return send(404, JSON.stringify({ message: "Not Found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}
