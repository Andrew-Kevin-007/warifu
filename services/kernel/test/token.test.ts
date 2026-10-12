// SEC-14 / RT-31: service tokens. Every negative case is built from a real, correctly MACed token that is then
// altered in exactly one way, so a pass cannot come from "everything is rejected".
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceCache } from "../src/auth/nonce-cache";
import { MAC_DOMAIN, MAX_TTL_SECONDS, audienceFor, mintServiceToken, verifyServiceToken } from "../src/auth/token";
import type { VerifyContext } from "../src/auth/token";
import type { Profile } from "../src/boot";

const SECRET = randomBytes(32).toString("hex");
const OTHER_SECRET = randomBytes(32).toString("hex");
const TENANT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const NOW = 1_800_000_000;

function ctx(over: Partial<VerifyContext> = {}): VerifyContext {
  return { secret: SECRET, profile: "production", nowSec: NOW, nonces: new NonceCache(), bootedAtSec: NOW - 100, ...over };
}
const mint = (over: Partial<Parameters<typeof mintServiceToken>[0]> = {}) =>
  mintServiceToken({ secret: SECRET, profile: "production", tenantId: TENANT, nowSec: NOW, ...over });

/** Sign an arbitrary payload object with the real MAC construction (to test payload-level rejections). */
function forge(payload: unknown, secret = SECRET, profile: Profile = "production"): string {
  const seg = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const m = createHmac("sha256", Buffer.from(secret)).update(`${MAC_DOMAIN}\n${profile}\n${seg}`).digest("base64url");
  return `v1.${seg}.${m}`;
}
const good = { v: 1, tid: TENANT, aud: audienceFor("production"), iat: NOW, exp: NOW + 30, nonce: "AAAAAAAAAAAAAAAAAAAA" };

describe("SEC-14 service tokens", () => {
  it("accepts a fresh token and returns the bound tenant", () => {
    const r = verifyServiceToken(mint(), ctx());
    expect(r).toMatchObject({ ok: true, tenantId: TENANT });
  });

  it("rejects an expired token (and accepts it one second earlier)", () => {
    const t = mint({ ttlSec: 30 });
    expect(verifyServiceToken(t, ctx({ nowSec: NOW + 29 })).ok).toBe(true);
    expect(verifyServiceToken(mint({ nonce: "B".repeat(20) }), ctx({ nowSec: NOW + 30 }))).toEqual({ ok: false, reason: "EXPIRED" });
    expect(verifyServiceToken(mint({ nonce: "C".repeat(20) }), ctx({ nowSec: NOW + 3600 }))).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("rejects the wrong audience (a validly MACed token for another audience)", () => {
    const t = mint({ audience: "kernel:sandbox" });
    expect(verifyServiceToken(t, ctx())).toEqual({ ok: false, reason: "WRONG_AUDIENCE" });
    expect(verifyServiceToken(forge({ ...good, aud: "other-service" }), ctx())).toEqual({ ok: false, reason: "WRONG_AUDIENCE" });
  });

  it("rejects a replayed nonce while it is live, and accepts distinct nonces", () => {
    const c = ctx();
    const t = mint();
    expect(verifyServiceToken(t, c).ok).toBe(true);
    expect(verifyServiceToken(t, c)).toEqual({ ok: false, reason: "REPLAYED" });
    expect(verifyServiceToken(mint(), c).ok).toBe(true);
  });

  it("a different tenant needs a different MAC: swapping tid keeps the old MAC and fails", () => {
    const [v, seg, m] = mint().split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(seg, "base64url").toString("utf8")) as Record<string, unknown>;
    payload["tid"] = "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8";
    const swapped = `${v}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${m}`;
    expect(verifyServiceToken(swapped, ctx())).toEqual({ ok: false, reason: "BAD_MAC" });
  });

  it("rejects a bit-flipped MAC and a bit-flipped payload", () => {
    const t = mint();
    const [v, seg, m] = t.split(".") as [string, string, string];
    const flip = (s: string): string => {
      const b = Buffer.from(s, "base64url");
      b[b.length >> 1] = (b[b.length >> 1] ?? 0) ^ 0x01;
      return b.toString("base64url");
    };
    expect(verifyServiceToken(`${v}.${seg}.${flip(m)}`, ctx())).toEqual({ ok: false, reason: "BAD_MAC" });
    expect(verifyServiceToken(`${v}.${flip(seg)}.${m}`, ctx())).toEqual({ ok: false, reason: "BAD_MAC" });
  });

  it("rejects algorithm-confusion attempts: JWT-style none, other versions, missing or extra segments", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(good)).toString("base64url");
    for (const t of [`${header}.${body}.`, `${header}.${body}.AAAA`, `v2.${body}.AAAA`, `v1.${body}`, `v1.${body}.AAAA.extra`, `none.${body}.`, "", "v1..", "..."]) {
      expect(verifyServiceToken(t, ctx()).ok, t).toBe(false);
    }
    // A payload that carries `alg` is not in the schema, even when correctly MACed.
    expect(verifyServiceToken(forge({ ...good, alg: "none" }), ctx())).toEqual({ ok: false, reason: "BAD_PAYLOAD" });
  });

  it("rejects non-canonical base64url spellings of an otherwise valid token", () => {
    const [v, seg, m] = mint().split(".") as [string, string, string];
    expect(verifyServiceToken(`${v}.${seg}=.${m}`, ctx()).ok).toBe(false);
    expect(verifyServiceToken(`${v}.${"+" + seg.slice(1)}.${m}`, ctx()).ok).toBe(false);
    expect(verifyServiceToken(`${v}.${seg}.${m}=`, ctx()).ok).toBe(false);
  });

  it("rejects payloads with a wrong shape even when the MAC is valid", () => {
    for (const p of [
      { ...good, v: 2 },
      { ...good, tid: "not-a-uuid" },
      { ...good, nonce: "short" },
      { ...good, iat: "1800000000" },
      { ...good, extra: 1 },
      { ...good, exp: undefined },
      "just a string",
      null,
      [good],
    ]) {
      expect(verifyServiceToken(forge(p), ctx()), JSON.stringify(p)).toEqual({ ok: false, reason: "BAD_PAYLOAD" });
    }
  });

  it("uses separate secrets per profile: a token never verifies under the other profile or another secret", () => {
    // Same secret in both profiles (a misconfiguration the boot guards cannot see): the profile is in the MAC input.
    const prod = mintServiceToken({ secret: SECRET, profile: "production", tenantId: TENANT, nowSec: NOW });
    const sand = mintServiceToken({ secret: SECRET, profile: "sandbox", tenantId: TENANT, nowSec: NOW });
    expect(verifyServiceToken(prod, ctx({ profile: "sandbox" }))).toEqual({ ok: false, reason: "BAD_MAC" });
    expect(verifyServiceToken(sand, ctx({ profile: "production" }))).toEqual({ ok: false, reason: "BAD_MAC" });
    expect(verifyServiceToken(sand, ctx({ profile: "sandbox" })).ok).toBe(true);
    expect(verifyServiceToken(mint(), ctx({ secret: OTHER_SECRET }))).toEqual({ ok: false, reason: "BAD_MAC" });
  });

  it("refuses a lifetime above 60 s, an exp before iat, a future iat, and tokens issued before this process booted", () => {
    expect(MAX_TTL_SECONDS).toBe(60);
    expect(verifyServiceToken(mint({ ttlSec: 60 }), ctx()).ok).toBe(true);
    expect(verifyServiceToken(mint({ ttlSec: 61, nonce: "D".repeat(20) }), ctx())).toEqual({ ok: false, reason: "TTL_TOO_LONG" });
    expect(verifyServiceToken(forge({ ...good, exp: good.iat - 1, nonce: "E".repeat(20) }), ctx({ nowSec: NOW - 2 }))).toEqual({ ok: false, reason: "TTL_TOO_LONG" });
    expect(verifyServiceToken(forge({ ...good, iat: NOW + 6, exp: NOW + 20, nonce: "F".repeat(20) }), ctx())).toEqual({ ok: false, reason: "NOT_YET_VALID" });
    expect(verifyServiceToken(mint({ nowSec: NOW - 10, ttlSec: 30, nonce: "G".repeat(20) }), ctx({ bootedAtSec: NOW - 5 }))).toEqual({ ok: false, reason: "BEFORE_BOOT" });
  });

  it("an oversized token is rejected before any parsing", () => {
    expect(verifyServiceToken(`v1.${"A".repeat(5000)}.AAAA`, ctx())).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("fails closed when the nonce cache is full of live nonces, and recovers once they expire", () => {
    const nonces = new NonceCache(2);
    const c = ctx({ nonces });
    expect(verifyServiceToken(mint({ nonce: "H".repeat(20) }), c).ok).toBe(true);
    expect(verifyServiceToken(mint({ nonce: "I".repeat(20) }), c).ok).toBe(true);
    expect(verifyServiceToken(mint({ nonce: "J".repeat(20) }), c)).toEqual({ ok: false, reason: "CACHE_FULL" });
    const later = ctx({ nonces, nowSec: NOW + 31 });
    expect(verifyServiceToken(mintServiceToken({ secret: SECRET, profile: "production", tenantId: TENANT, nowSec: NOW + 31 }), later).ok).toBe(true);
  });

  it("the MAC comparison is constant time (timingSafeEqual on equal-length buffers; no string comparison of MACs)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/auth/token.ts", import.meta.url), "utf8");
    expect(src).toContain("timingSafeEqual(given, expected)");
    expect(src).not.toMatch(/macSegment\s*[!=]==/);
  });
});
