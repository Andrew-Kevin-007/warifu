// The public challenge proxy (WP-33): same-origin only, bounded, never forwards anything but the visitor's text-shaped JSON, passes the
// kernel's rate limit through, and degrades to "UNAVAILABLE / L2" (the page then shows the RECORDED replay) when the kernel is down.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { challengeGet, challengePost } from "../src/server/challenge-proxy";

const ENV = { WEB_SVC_URL: "http://127.0.0.1:9", WEB_SVC_SECRET: "s".repeat(40), WEB_SVC_TENANT_ID: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", WEB_SVC_PROFILE: "sandbox" };

const post = (body: unknown, headers: Record<string, string> = { origin: "https://challenge.example", host: "challenge.example" }): Request =>
  new Request("https://challenge.example/api/public/challenge/attempts", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("challenge proxy", () => {
  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses a cross-origin or origin-less post before touching the kernel", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect((await challengePost(post({ kind: "oneclick" }, { host: "challenge.example" }), "/v1/challenge/attempts")).status).toBe(403);
    expect((await challengePost(post({ kind: "oneclick" }, { origin: "https://evil.example", host: "challenge.example" }), "/v1/challenge/attempts")).status).toBe(403);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses oversize and malformed bodies", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect((await challengePost(post("x".repeat(9000)), "/v1/challenge/attempts")).status).toBe(413);
    expect((await challengePost(post("{not json"), "/v1/challenge/attempts")).status).toBe(400);
  });

  it("forwards the visitor's address as a header, never in the body, and wraps a live answer", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const h = init.headers as Record<string, string>;
      expect(h["X-Client-Ip"]).toBe("203.0.113.9");
      expect(String(init.body)).not.toContain("203.0.113.9");
      expect(h["Authorization"]).toMatch(/^Bearer v1\./);
      return new Response(JSON.stringify({ attemptId: "a" }), { status: 201 });
    });
    vi.stubGlobal("fetch", f);
    const req = new Request("https://challenge.example/api/public/challenge/attempts", {
      method: "POST",
      headers: { origin: "https://challenge.example", host: "challenge.example", "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
      body: JSON.stringify({ kind: "oneclick", attackId: "ATK-02" }),
    });
    const r = await challengePost(req, "/v1/challenge/attempts");
    expect(r.status).toBe(201);
    expect(await r.json()).toEqual({ source: "LIVE", data: { attemptId: "a" } });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("passes a rate limit through with Retry-After, and a level answer (L1/L2) through, without inventing a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "RATE_LIMITED", message: "m", detail: { retryAfterSeconds: 120 } } }), { status: 429, headers: { "retry-after": "120" } })));
    const limited = await challengePost(post({ kind: "oneclick" }), "/v1/challenge/attempts");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    expect(await limited.json()).toMatchObject({ code: "RATE_LIMITED", detail: { retryAfterSeconds: 120 } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "m", detail: { level: "L1" } } }), { status: 503 })));
    const l1 = await challengePost(post({ kind: "freeform" }), "/v1/challenge/attempts");
    expect(l1.status).toBe(503);
    expect(await l1.json()).toMatchObject({ source: "LIVE", detail: { level: "L1" } });
  });

  it("falls back to UNAVAILABLE / L2 when the kernel is unreachable or unconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    const down = await challengeGet("/v1/challenge/scenarios");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ source: "UNAVAILABLE", level: "L2" });
    vi.unstubAllEnvs();
    vi.stubEnv("WEB_SVC_URL", "");
    const unconfigured = await challengePost(post({ kind: "oneclick" }), "/v1/challenge/attempts");
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toMatchObject({ source: "UNAVAILABLE" });
  });

  it("a missing attempt is a 404 passed through as such", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "m", detail: {} } }), { status: 404 })));
    expect((await challengeGet("/v1/challenge/attempts/3f2504e0-4f89-41d3-9a0c-0305e82c3301")).status).toBe(404);
  });
});
