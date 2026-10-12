// Web -> kernel service tokens (docs/05 section 4, RT-31, SEC-14).
//
//   token   = "v1." + b64url(payload JSON) + "." + b64url(HMAC-SHA256(secret, DOMAIN "\n" profile "\n" payloadSegment))
//   payload = { v:1, tid:<tenant uuid>, aud:"kernel:<profile>", iat, exp, nonce }        (epoch seconds)
//
// The token binds tenant + audience + expiry + nonce. There is no `alg` field to confuse: the algorithm is fixed by the
// version prefix. The profile is part of the MAC input and of the audience, so a token minted for one profile cannot
// verify in the other even if (by mistake) both were configured with the same secret. Verification order is chosen so
// that nothing derived from attacker-controlled bytes is parsed before the MAC checks out:
//   shape -> strict base64url -> constant-time MAC -> strict payload parse -> audience -> clock -> nonce (last).
// Tokens issued before this process booted are refused (the nonce cache does not survive a restart, so a token
// captured earlier must not become replayable after one).
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import type { NonceCache } from "./nonce-cache";
import type { NonceStore } from "./nonce-store";
import type { Profile } from "../boot";

export const TOKEN_VERSION = "v1";
export const MAC_DOMAIN = "symbolon-svc-token/1";
export const MAX_TOKEN_CHARS = 1024;
export const MAX_TTL_SECONDS = 60;
/** Tolerated clock difference between the minting web tier and this service. */
export const CLOCK_SKEW_SECONDS = 5;

export const audienceFor = (profile: Profile): string => `kernel:${profile}`;

const B64URL = /^[A-Za-z0-9_-]+$/;

const PayloadSchema = z.strictObject({
  v: z.literal(1),
  tid: z.uuid(),
  aud: z.string().min(1).max(64),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/),
});
export type TokenPayload = z.infer<typeof PayloadSchema>;

export type TokenFailure =
  | "MALFORMED"
  | "BAD_MAC"
  | "BAD_PAYLOAD"
  | "WRONG_AUDIENCE"
  | "EXPIRED"
  | "NOT_YET_VALID"
  | "TTL_TOO_LONG"
  | "BEFORE_BOOT"
  | "REPLAYED"
  | "CACHE_FULL"
  | "STORE_ERROR";

export type TokenResult =
  | {
      readonly ok: true;
      readonly tenantId: string;
      readonly nonce: string;
      readonly expiresAt: number;
    }
  | { readonly ok: false; readonly reason: TokenFailure };

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/** Strict decode: only canonical unpadded base64url round-trips; anything else is refused. */
function b64urlDecode(s: string): Buffer | null {
  if (!B64URL.test(s)) return null;
  const buf = Buffer.from(s, "base64url");
  return buf.toString("base64url") === s ? buf : null;
}

function mac(secret: string, profile: Profile, payloadSegment: string): Buffer {
  return createHmac("sha256", Buffer.from(secret, "utf8"))
    .update(`${MAC_DOMAIN}\n${profile}\n${payloadSegment}`)
    .digest();
}

export interface MintOptions {
  readonly secret: string;
  readonly profile: Profile;
  readonly tenantId: string;
  /** Epoch seconds. */
  readonly nowSec: number;
  readonly ttlSec?: number;
  readonly nonce?: string;
  readonly audience?: string;
}

/** Mint a token. Used by tests and operator tooling; the web tier receives pre-signed tokens. */
export function mintServiceToken(o: MintOptions): string {
  const ttl = o.ttlSec ?? 30;
  const payload: TokenPayload = {
    v: 1,
    tid: o.tenantId,
    aud: o.audience ?? audienceFor(o.profile),
    iat: o.nowSec,
    exp: o.nowSec + ttl,
    nonce: o.nonce ?? randomBytes(18).toString("base64url"),
  };
  const segment = b64urlEncode(JSON.stringify(payload));
  return `${TOKEN_VERSION}.${segment}.${b64urlEncode(mac(o.secret, o.profile, segment))}`;
}

export interface VerifyContext {
  readonly secret: string;
  readonly profile: Profile;
  readonly nowSec: number;
  readonly nonces: NonceCache;
  /**
   * Only for the in-memory-only path (unit tests / no database): epoch seconds at which this process started; tokens
   * issued earlier are refused. Not needed (and not used) with a durable NonceStore.
   */
  readonly bootedAtSec?: number;
  readonly maxTtlSec?: number;
}

export function verifyServiceToken(token: string, ctx: VerifyContext): TokenResult {
  const fail = (reason: TokenFailure): TokenResult => ({ ok: false, reason });
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS)
    return fail("MALFORMED");
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return fail("MALFORMED");
  const [, payloadSegment = "", macSegment = ""] = parts;
  const given = b64urlDecode(macSegment);
  if (given === null || b64urlDecode(payloadSegment) === null) return fail("MALFORMED");

  const expected = mac(ctx.secret, ctx.profile, payloadSegment);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail("BAD_MAC");

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8"));
  } catch {
    return fail("BAD_PAYLOAD");
  }
  const parsed = PayloadSchema.safeParse(json);
  if (!parsed.success) return fail("BAD_PAYLOAD");
  const p = parsed.data;

  if (p.aud !== audienceFor(ctx.profile)) return fail("WRONG_AUDIENCE");
  if (p.exp <= ctx.nowSec) return fail("EXPIRED");
  if (p.iat > ctx.nowSec + CLOCK_SKEW_SECONDS) return fail("NOT_YET_VALID");
  if (p.exp <= p.iat || p.exp - p.iat > Math.min(ctx.maxTtlSec ?? MAX_TTL_SECONDS, MAX_TTL_SECONDS))
    return fail("TTL_TOO_LONG");
  if (ctx.bootedAtSec !== undefined && p.iat < ctx.bootedAtSec) return fail("BEFORE_BOOT");

  const seen = ctx.nonces.checkAndInsert(p.nonce, p.exp, ctx.nowSec);
  if (seen === "REPLAYED") return fail("REPLAYED");
  if (seen === "FULL") return fail("CACHE_FULL");
  return { ok: true, tenantId: p.tid.toLowerCase(), nonce: p.nonce, expiresAt: p.exp };
}

/**
 * Durable verification: the in-memory cache is a fast first check; the database claim is the source of truth. A store
 * error, or a store that says "already used", rejects. Either way the nonce stays burnt in memory.
 */
export async function verifyServiceTokenDurable(
  token: string,
  ctx: VerifyContext,
  store: NonceStore,
): Promise<TokenResult> {
  const r = verifyServiceToken(token, ctx);
  if (!r.ok) return r;
  try {
    const first = await store.claim(r.nonce, r.tenantId, r.expiresAt);
    return first ? r : { ok: false, reason: "REPLAYED" };
  } catch {
    return { ok: false, reason: "STORE_ERROR" };
  }
}
