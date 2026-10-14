// SEC-02: every SSRF corpus case is denied by the real evidence egress guard, at the stage the case names, and nothing is
// ever connected to. The two network edges (resolver, transport) are stubs that record calls; everything between is real.
import { describe, expect, it } from "vitest";
import { guardedGet } from "../../../services/kernel/src/evidence/ssrf/guard";
import type { GuardedGetResult } from "../../../services/kernel/src/evidence/ssrf/guard";
import { SSRF_CORPUS } from "../src/ssrf-corpus";
import type { SsrfCase } from "../src/ssrf-corpus";

const DEFAULT_ALLOW = ["app.example.com"] as const;

async function run(c: SsrfCase): Promise<{ result: GuardedGetResult; resolved: string[]; connected: number }> {
  const resolved: string[] = [];
  let connected = 0;
  const result = await guardedGet(
    {
      resolver: {
        async resolve(host) {
          resolved.push(host);
          if (c.expect.stage === "dns") return c.expect.answers;
          return ["93.184.216.34"];
        },
      },
      transport: {
        async get() {
          connected += 1;
          return { status: 200, location: null, body: new Uint8Array(0), truncated: false };
        },
      },
    },
    { url: c.url, allowedHosts: c.allow ?? DEFAULT_ALLOW },
  );
  return { result, resolved, connected };
}

describe("SEC-02: SSRF corpus", () => {
  it("has at least 40 cases and unique ids", () => {
    expect(SSRF_CORPUS.length).toBeGreaterThanOrEqual(40);
    expect(new Set(SSRF_CORPUS.map((c) => c.id)).size).toBe(SSRF_CORPUS.length);
  });

  it.each(SSRF_CORPUS.map((c) => [c.id, c] as const))("%s is denied before any connection", async (_id, c) => {
    const { result, resolved, connected } = await run(c);
    expect(connected).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe("denied");
    if (result.kind !== "denied") return;
    switch (c.expect.stage) {
      case "grammar":
        expect(result.code).toBe(c.expect.code);
        expect(resolved).toEqual([]);
        break;
      case "allowlist":
        expect(result.code).toBe("HOST_NOT_ALLOWED");
        expect(resolved).toEqual([]);
        break;
      case "dns":
        expect(result.code).toBe("DNS_NON_GLOBAL");
        break;
      default: {
        const never: never = c.expect;
        throw new Error(`unhandled stage ${JSON.stringify(never)}`);
      }
    }
  });
});
