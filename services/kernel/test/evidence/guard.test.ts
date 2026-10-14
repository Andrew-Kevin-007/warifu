// The guard end to end with a stub resolver and a stub transport (the two network edges). Everything between them is the real
// code: URL grammar, allowlist, DNS answer classification, pinning, redirect re-validation, caps (docs/04 K-09, RT-02).
import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, guardedGet } from "../../src/evidence/ssrf/guard";
import type { GuardDeps, PinnedRequest, TransportResponse } from "../../src/evidence/ssrf/guard";

const PUBLIC_A = "93.184.216.34";
const PUBLIC_B = "93.184.216.35";
const enc = new TextEncoder();

interface Rig extends GuardDeps {
  readonly resolved: string[];
  readonly requests: PinnedRequest[];
}

function rig(dns: Record<string, readonly string[] | Error>, respond: (req: PinnedRequest, n: number) => Promise<TransportResponse> | TransportResponse): Rig {
  const resolved: string[] = [];
  const requests: PinnedRequest[] = [];
  return {
    resolved,
    requests,
    resolver: {
      async resolve(host) {
        resolved.push(host);
        const a = dns[host];
        if (a === undefined) throw new Error("NXDOMAIN");
        if (a instanceof Error) throw a;
        return a;
      },
    },
    transport: {
      async get(req) {
        requests.push(req);
        return respond(req, requests.length);
      },
    },
  };
}

const ok = (body = "ok", status = 200): TransportResponse => ({ status, location: null, body: enc.encode(body), truncated: false });
const redirect = (to: string, status = 302): TransportResponse => ({ status, location: to, body: new Uint8Array(0), truncated: false });
const url = "https://app.example.com/health";

describe("happy path and pinning", () => {
  it("resolves once, connects to the pinned IP, sets Host from the name, asks for identity encoding", async () => {
    const r = rig({ "app.example.com": [PUBLIC_A, PUBLIC_B] }, () => ok());
    const res = await guardedGet(r, { url, allowedHosts: ["app.example.com"], headers: { accept: "*/*" } });
    expect(res).toMatchObject({ ok: true, status: 200, finalHost: "app.example.com", finalUrl: url, redirects: 0, pinnedIp: PUBLIC_A, truncated: false });
    expect(r.resolved).toEqual(["app.example.com"]);
    expect(r.requests).toHaveLength(1);
    expect(r.requests[0]).toMatchObject({ ip: PUBLIC_A, host: "app.example.com", path: "/health", maxBodyBytes: DEFAULT_LIMITS.maxBodyBytes });
    expect(r.requests[0]?.headers).toMatchObject({ accept: "*/*", "accept-encoding": "identity" });
  });

  it("DNS rebinding: a resolver that would answer differently the second time is asked once, and the connection goes to the first answer", async () => {
    let calls = 0;
    const requests: PinnedRequest[] = [];
    const d: GuardDeps = {
      resolver: { resolve: async () => (++calls === 1 ? [PUBLIC_A] : ["127.0.0.1"]) },
      transport: { get: async (q) => (requests.push(q), ok()) },
    };
    const res = await guardedGet(d, { url, allowedHosts: ["app.example.com"] });
    expect(res).toMatchObject({ ok: true, pinnedIp: PUBLIC_A });
    expect(calls).toBe(1);
    expect(requests.map((q) => q.ip)).toEqual([PUBLIC_A]);
  });

  it("drops Host/Cookie/Connection/Content-Length/Transfer-Encoding supplied by the caller", async () => {
    const r = rig({ "app.example.com": [PUBLIC_A] }, () => ok());
    await guardedGet(r, { url, allowedHosts: ["app.example.com"], headers: { Host: "evil.test", Cookie: "a=b", Connection: "keep-alive", "Content-Length": "9", "Transfer-Encoding": "chunked", "X-Ok": "1" } });
    expect(Object.keys(r.requests[0]?.headers ?? {}).sort()).toEqual(["accept-encoding", "x-ok"]);
  });
});

describe("denials never reach the transport", () => {
  it("not in the allowlist (including look-alikes) is denied before DNS is even asked", async () => {
    for (const u of ["https://evil.example.com/", "https://app.example.com.evil.test/", "https://evilapp.example.com/", "https://example.com/"]) {
      const r = rig({}, () => ok());
      expect(await guardedGet(r, { url: u, allowedHosts: ["app.example.com"] })).toEqual({ ok: false, kind: "denied", code: "HOST_NOT_ALLOWED" });
      expect(r.resolved).toEqual([]);
      expect(r.requests).toEqual([]);
    }
  });

  it("an empty allowlist denies everything", async () => {
    const r = rig({ "app.example.com": [PUBLIC_A] }, () => ok());
    expect(await guardedGet(r, { url, allowedHosts: [] })).toMatchObject({ kind: "denied", code: "HOST_NOT_ALLOWED" });
    expect(r.requests).toEqual([]);
  });

  it("grammar violations are denied before the allowlist or DNS", async () => {
    for (const [u, code] of [
      ["http://app.example.com/", "SCHEME_NOT_HTTPS"],
      ["https://user@app.example.com/", "USERINFO"],
      ["https://app.example.com:8443/", "PORT_DENIED"],
      ["https://127.0.0.1/", "IP_LITERAL_NON_GLOBAL"],
      ["https://[::1]/", "IP_LITERAL_NON_GLOBAL"],
      [42, "URL_MALFORMED"],
    ] as const) {
      const r = rig({}, () => ok());
      expect(await guardedGet(r, { url: u, allowedHosts: ["app.example.com", "127.0.0.1"] })).toEqual({ ok: false, kind: "denied", code });
      expect(r.resolved).toEqual([]);
      expect(r.requests).toEqual([]);
    }
  });

  it.each([
    ["loopback", ["127.0.0.1"]],
    ["metadata", ["169.254.169.254"]],
    ["rfc1918 10/8", ["10.0.0.5"]],
    ["rfc1918 172.16/12", ["172.16.4.4"]],
    ["rfc1918 192.168/16", ["192.168.1.10"]],
    ["cgnat", ["100.64.0.9"]],
    ["IPv6 loopback", ["::1"]],
    ["IPv6 ULA", ["fc00::1"]],
    ["IPv6 link-local", ["fe80::1"]],
    ["IPv4-mapped", ["::ffff:127.0.0.1"]],
    ["IPv4-mapped public", ["::ffff:93.184.216.34"]],
    ["mixed: public first then private", [PUBLIC_A, "10.0.0.5"]],
    ["mixed: private last of many", [PUBLIC_A, PUBLIC_B, "2606:4700:4700::1111", "127.0.0.1"]],
    ["unparseable answer", ["not-an-ip"]],
    ["numeric spelling answer", ["2130706433"]],
  ])("DNS answer %s is denied and nothing is connected", async (_n, answers) => {
    const r = rig({ "app.example.com": answers }, () => ok());
    expect(await guardedGet(r, { url, allowedHosts: ["app.example.com"] })).toEqual({ ok: false, kind: "denied", code: "DNS_NON_GLOBAL" });
    expect(r.requests).toEqual([]);
  });

  it("a name that does not resolve is an error (not a pass, not a denial of the source)", async () => {
    const r = rig({}, () => ok());
    expect(await guardedGet(r, { url, allowedHosts: ["app.example.com"] })).toEqual({ ok: false, kind: "error", code: "DNS_FAILED" });
    const r2 = rig({ "app.example.com": [] }, () => ok());
    expect(await guardedGet(r2, { url, allowedHosts: ["app.example.com"] })).toEqual({ ok: false, kind: "error", code: "DNS_FAILED" });
    expect(r.requests).toEqual([]);
  });
});

describe("redirects are re-validated hop by hop", () => {
  const allowed = ["app.example.com", "cdn.example.com"];
  const dns = { "app.example.com": [PUBLIC_A], "cdn.example.com": [PUBLIC_B], "internal.example.com": ["10.1.2.3"], "evil.test": [PUBLIC_B] };

  it("follows an allowed redirect (absolute and same-host absolute path), re-pinning the new host", async () => {
    const r = rig(dns, (_q, n) => (n === 1 ? redirect("https://cdn.example.com/x") : n === 2 ? redirect("/final") : ok("done")));
    const res = await guardedGet(r, { url, allowedHosts: allowed });
    expect(res).toMatchObject({ ok: true, finalHost: "cdn.example.com", finalUrl: "https://cdn.example.com/final", redirects: 2, pinnedIp: PUBLIC_B });
    expect(r.requests.map((q) => [q.ip, q.host, q.path])).toEqual([
      [PUBLIC_A, "app.example.com", "/health"],
      [PUBLIC_B, "cdn.example.com", "/x"],
      [PUBLIC_B, "cdn.example.com", "/final"],
    ]);
  });

  it.each([
    ["redirect to the metadata IP", "https://169.254.169.254/latest/meta-data/", "REDIRECT_TARGET_INVALID"],
    ["redirect to a hex IP", "https://0x7f000001/", "REDIRECT_TARGET_INVALID"],
    ["redirect to loopback IPv6", "https://[::1]/", "REDIRECT_TARGET_INVALID"],
    ["redirect to http", "http://app.example.com/", "REDIRECT_TARGET_INVALID"],
    ["redirect to file", "file:///etc/passwd", "REDIRECT_TARGET_INVALID"],
    ["redirect with userinfo", "https://app.example.com@evil.test/", "REDIRECT_TARGET_INVALID"],
    ["redirect to a non-443 port", "https://app.example.com:8443/", "REDIRECT_TARGET_INVALID"],
    ["scheme-relative redirect", "//evil.test/", "REDIRECT_TARGET_INVALID"],
    ["relative-path redirect", "next", "REDIRECT_TARGET_INVALID"],
    ["empty Location", "", "REDIRECT_TARGET_INVALID"],
    ["redirect to a host outside the allowlist", "https://evil.test/", "HOST_NOT_ALLOWED"],
    ["redirect to an allowlisted name that resolves privately", "https://internal.example.com/", "HOST_NOT_ALLOWED"],
  ])("%s is denied", async (_n, to, code) => {
    const r = rig(dns, () => redirect(to));
    expect(await guardedGet(r, { url, allowedHosts: allowed })).toEqual({ ok: false, kind: "denied", code });
    expect(r.requests).toHaveLength(1); // only the first hop was ever connected
  });

  it("an allowlisted redirect target whose DNS turns private is denied by the DNS check", async () => {
    const r = rig(dns, () => redirect("https://internal.example.com/"));
    expect(await guardedGet(r, { url, allowedHosts: [...allowed, "internal.example.com"] })).toEqual({ ok: false, kind: "denied", code: "DNS_NON_GLOBAL" });
    expect(r.requests).toHaveLength(1);
  });

  it("enforces the redirect limit (default 2) and zero when configured", async () => {
    const loop = rig(dns, () => redirect("/again"));
    expect(await guardedGet(loop, { url, allowedHosts: allowed })).toEqual({ ok: false, kind: "denied", code: "REDIRECT_LIMIT" });
    expect(loop.requests).toHaveLength(3); // the original request plus 2 followed redirects
    const none = rig(dns, () => redirect("/again"));
    expect(await guardedGet(none, { url, allowedHosts: allowed, limits: { maxRedirects: 0 } })).toEqual({ ok: false, kind: "denied", code: "REDIRECT_LIMIT" });
    expect(none.requests).toHaveLength(1);
  });

  it("a 3xx without Location is just a response; redirectIsResult returns a 3xx with Location as the result", async () => {
    const noLoc = rig(dns, () => ({ status: 304, location: null, body: new Uint8Array(0), truncated: false }));
    expect(await guardedGet(noLoc, { url, allowedHosts: allowed })).toMatchObject({ ok: true, status: 304 });
    const asResult = rig(dns, () => redirect("https://evil.test/", 301));
    expect(await guardedGet(asResult, { url, allowedHosts: allowed, redirectIsResult: true })).toMatchObject({ ok: true, status: 301 });
    expect(asResult.requests).toHaveLength(1);
  });

  it("never forwards the Authorization header across a redirect", async () => {
    const r = rig(dns, (_q, n) => (n === 1 ? redirect("https://cdn.example.com/x") : ok()));
    await guardedGet(r, { url, allowedHosts: allowed, headers: { authorization: "Bearer placeholder-token" } });
    expect(r.requests[0]?.headers["authorization"]).toBe("Bearer placeholder-token");
    expect(r.requests[1]?.headers["authorization"]).toBeUndefined();
  });
});

describe("caps", () => {
  it("passes the body cap to the transport and reports truncation without pretending the body is whole", async () => {
    const r = rig({ "app.example.com": [PUBLIC_A] }, () => ({ status: 200, location: null, body: enc.encode("x".repeat(10)), truncated: true }));
    const res = await guardedGet(r, { url, allowedHosts: ["app.example.com"], limits: { maxBodyBytes: 10 } });
    expect(res).toMatchObject({ ok: true, truncated: true });
    expect(r.requests[0]?.maxBodyBytes).toBe(10);
  });

  it("times out a hung transport (and aborts its signal)", async () => {
    let aborted = false;
    const d: GuardDeps = {
      resolver: { resolve: async () => [PUBLIC_A] },
      transport: {
        get: (q) =>
          new Promise<TransportResponse>((_resolve, reject) => {
            q.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      },
    };
    const t0 = Date.now();
    expect(await guardedGet(d, { url, allowedHosts: ["app.example.com"], limits: { timeoutMs: 60 } })).toEqual({ ok: false, kind: "error", code: "TIMEOUT" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(aborted).toBe(true);
  });

  it("times out a hung resolver", async () => {
    const d: GuardDeps = { resolver: { resolve: () => new Promise<string[]>(() => undefined) }, transport: { get: async () => ok() } };
    expect(await guardedGet(d, { url, allowedHosts: ["app.example.com"], limits: { timeoutMs: 60 } })).toEqual({ ok: false, kind: "error", code: "TIMEOUT" });
  });

  it("a transport failure is an error result, never a throw, and carries no message", async () => {
    const d: GuardDeps = { resolver: { resolve: async () => [PUBLIC_A] }, transport: { get: async () => Promise.reject(new Error("ECONNRESET secret-ish detail")) } };
    const res = await guardedGet(d, { url, allowedHosts: ["app.example.com"] });
    expect(res).toEqual({ ok: false, kind: "error", code: "TRANSPORT_ERROR" });
  });

  it("the documented defaults: 5 s, 1 MiB, 2 redirects", () => {
    expect(DEFAULT_LIMITS).toEqual({ timeoutMs: 5_000, maxBodyBytes: 1_048_576, maxRedirects: 2 });
    expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
  });
});
