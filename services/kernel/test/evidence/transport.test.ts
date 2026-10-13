// The socket-owning module. TLS itself is node's; what is ours, and tested here, is: connect to the pinned IP with the NAME as
// SNI/Host, verify certificates, enforce the byte cap while streaming, and tunnel through the egress proxy to ip:443 only.
// The https.request seam is faked (the network edge); the CONNECT proxy test uses a real local TCP server.
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectAuthority, createPinnedHttpsTransport } from "../../src/evidence/ssrf/transport";
import type { HttpsRequestFn } from "../../src/evidence/ssrf/transport";

interface Captured {
  opts?: Record<string, unknown>;
}

function fakeHttps(chunks: Uint8Array[], status = 200, headers: Record<string, string> = {}, cap: Captured = {}): HttpsRequestFn {
  const fn = ((opts: Record<string, unknown>, cb: (res: Readable & { statusCode?: number; headers: Record<string, string> }) => void) => {
    cap.opts = opts;
    const req = new EventEmitter() as EventEmitter & { end(): void };
    req.end = () => {
      const res = Readable.from(chunks) as Readable & { statusCode?: number; headers: Record<string, string> };
      res.statusCode = status;
      res.headers = headers;
      queueMicrotask(() => cb(res));
    };
    return req;
  }) as unknown as HttpsRequestFn;
  return fn;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const sig = new AbortController().signal;
const base = { ip: "93.184.216.34", host: "app.example.com", path: "/health?x=1", headers: { accept: "*/*" }, signal: sig };

describe("pinned https transport", () => {
  it("connects to the IP, verifies the certificate against the NAME, and sends Host for the name", async () => {
    const cap: Captured = {};
    const t = createPinnedHttpsTransport({ httpsRequestFn: fakeHttps([enc("hello")], 200, {}, cap) });
    const res = await t.get({ ...base, maxBodyBytes: 100 });
    expect(res).toMatchObject({ status: 200, truncated: false, location: null });
    expect(new TextDecoder().decode(res.body)).toBe("hello");
    expect(cap.opts).toMatchObject({ method: "GET", host: "93.184.216.34", port: 443, servername: "app.example.com", path: "/health?x=1", agent: false, rejectUnauthorized: true });
    expect(cap.opts?.["headers"]).toMatchObject({ host: "app.example.com", accept: "*/*", connection: "close" });
  });

  it("returns Location for the guard to re-validate, and ignores every other header", async () => {
    const t = createPinnedHttpsTransport({ httpsRequestFn: fakeHttps([], 302, { location: "https://cdn.example.com/x", "set-cookie": "a=b" }) });
    expect(await t.get({ ...base, maxBodyBytes: 10 })).toMatchObject({ status: 302, location: "https://cdn.example.com/x" });
  });

  it("stops at the byte cap, marks the body truncated, and never returns more than the cap", async () => {
    const t = createPinnedHttpsTransport({ httpsRequestFn: fakeHttps([enc("a".repeat(6)), enc("b".repeat(6)), enc("c".repeat(6))]) });
    const res = await t.get({ ...base, maxBodyBytes: 10 });
    expect(res.truncated).toBe(true);
    expect(res.body.byteLength).toBe(10);
    expect(new TextDecoder().decode(res.body)).toBe("aaaaaabbbb");
  });

  it("a body of exactly the cap is not truncated", async () => {
    const t = createPinnedHttpsTransport({ httpsRequestFn: fakeHttps([enc("a".repeat(10))]) });
    const res = await t.get({ ...base, maxBodyBytes: 10 });
    expect(res).toMatchObject({ truncated: false });
    expect(res.body.byteLength).toBe(10);
  });

  it("never turns certificate verification off (static check of the source)", () => {
    const src = readFileSync(join(import.meta.dirname, "../../src/evidence/ssrf/transport.ts"), "utf8");
    expect(src).not.toMatch(/rejectUnauthorized\s*:\s*false/);
    expect(src).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(src).not.toMatch(/checkServerIdentity/);
  });
});

describe("egress proxy tunnel", () => {
  it("formats the CONNECT target as the pinned IP and port 443 (brackets for IPv6)", () => {
    expect(connectAuthority("93.184.216.34")).toBe("93.184.216.34:443");
    expect(connectAuthority("2606:4700:4700::1111")).toBe("[2606:4700:4700::1111]:443");
  });

  it("asks the proxy for CONNECT ip:443 (never the name) and fails closed when the proxy refuses", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const proxy = createServer();
    proxy.on("connect", (req, socket) => {
      seen.push({ method: req.method ?? "", url: req.url ?? "" });
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const port = (proxy.address() as AddressInfo).port;
    try {
      const t = createPinnedHttpsTransport({ proxy: { host: "127.0.0.1", port }, httpsRequestFn: fakeHttps([enc("must not be reached")]) });
      await expect(t.get({ ...base, maxBodyBytes: 10 })).rejects.toThrow(/proxy/);
      expect(seen).toEqual([{ method: "CONNECT", url: "93.184.216.34:443" }]);
    } finally {
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  it("fails closed when the proxy is unreachable", async () => {
    const t = createPinnedHttpsTransport({ proxy: { host: "127.0.0.1", port: 1 }, httpsRequestFn: fakeHttps([enc("x")]) });
    await expect(t.get({ ...base, maxBodyBytes: 10 })).rejects.toBeDefined();
  });
});
