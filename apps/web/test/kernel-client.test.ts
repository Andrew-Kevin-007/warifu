// The web tier's token minter must be accepted by the kernel's real verifier (and nothing else).
import { describe, expect, it } from "vitest";
import { NonceCache } from "../../../services/kernel/src/auth/nonce-cache";
import { verifyServiceToken } from "../../../services/kernel/src/auth/token";
import { kernelCall, loadKernelClientConfig, mintToken } from "../src/server/kernel-client";

const cfg = { baseUrl: "http://kernel.test", secret: "s".repeat(40), tenantId: "11111111-1111-4111-8111-111111111111", profile: "sandbox" as const };
const NOW = 1_800_000_000;

describe("kernel client token", () => {
  it("is accepted by the kernel verifier for the same profile and secret", () => {
    const r = verifyServiceToken(mintToken(cfg, NOW), { secret: cfg.secret, profile: "sandbox", nowSec: NOW, nonces: new NonceCache() });
    expect(r).toMatchObject({ ok: true, tenantId: cfg.tenantId });
  });
  it("is refused under another profile, secret, after expiry, and on replay", () => {
    const t = mintToken(cfg, NOW);
    const base = { nowSec: NOW, nonces: new NonceCache() };
    expect(verifyServiceToken(t, { ...base, secret: cfg.secret, profile: "production" })).toMatchObject({ ok: false });
    expect(verifyServiceToken(t, { ...base, secret: "x".repeat(40), profile: "sandbox" })).toMatchObject({ ok: false, reason: "BAD_MAC" });
    expect(verifyServiceToken(t, { ...base, secret: cfg.secret, profile: "sandbox", nowSec: NOW + 31 })).toMatchObject({ ok: false, reason: "EXPIRED" });
    const nonces = new NonceCache();
    expect(verifyServiceToken(t, { secret: cfg.secret, profile: "sandbox", nowSec: NOW, nonces }).ok).toBe(true);
    expect(verifyServiceToken(t, { secret: cfg.secret, profile: "sandbox", nowSec: NOW, nonces })).toMatchObject({ ok: false, reason: "REPLAYED" });
  });
  it("caps the ttl at 60 s", () => {
    const t = mintToken(cfg, NOW, 3600);
    expect(verifyServiceToken(t, { secret: cfg.secret, profile: "sandbox", nowSec: NOW, nonces: new NonceCache() }).ok).toBe(true);
    expect(verifyServiceToken(t, { secret: cfg.secret, profile: "sandbox", nowSec: NOW + 61, nonces: new NonceCache() }).ok).toBe(false);
  });
});

describe("kernelCall", () => {
  it("is UNAVAILABLE without configuration (pages fall back to RECORDED)", async () => {
    expect(loadKernelClientConfig({})).toBeNull();
    expect(await kernelCall("/v1/state", { config: null })).toEqual({ ok: false, status: 503, code: "UNAVAILABLE" });
  });
  it("refuses non-/v1 paths and never throws on network failure", async () => {
    expect(await kernelCall("/etc/passwd", { config: cfg })).toMatchObject({ ok: false, code: "BAD_PATH" });
    const failing = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
    expect(await kernelCall("/v1/state", { config: cfg, fetchImpl: failing })).toMatchObject({ ok: false, code: "UNAVAILABLE" });
  });
  it("sends a bearer token and surfaces the error code", async () => {
    let auth = "";
    const f = (async (_u: string, init: RequestInit) => {
      auth = String((init.headers as Record<string, string>)["Authorization"]);
      return new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "x" } }), { status: 404 });
    }) as unknown as typeof fetch;
    const r = await kernelCall("/v1/receipts/0x00", { config: cfg, fetchImpl: f });
    expect(auth).toMatch(/^Bearer v1\./);
    expect(r).toEqual({ ok: false, status: 404, code: "NOT_FOUND" });
  });
});
