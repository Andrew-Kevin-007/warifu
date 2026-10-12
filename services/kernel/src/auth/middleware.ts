// Bearer authentication for every /v1 route except the probes. The tenant that every query is scoped to comes from the
// verified token and from nowhere else: a body or URL that names a different tenant is refused (TENANT_MISMATCH).
import { createMiddleware } from "hono/factory";
import { ApiError } from "../errors";
import type { Logger } from "../log";
import type { Profile } from "../boot";
import { NonceCache } from "./nonce-cache";
import type { NonceStore } from "./nonce-store";
import { verifyServiceTokenDurable } from "./token";

export interface AuthInfo {
  readonly tenantId: string;
  readonly nonce: string;
}

export interface AppEnv {
  Variables: {
    auth: AuthInfo;
    requestId: string;
  };
}

export interface AuthOptions {
  readonly secret: string;
  readonly profile: Profile;
  /** Epoch milliseconds. */
  readonly clock: () => number;
  /** Durable replay protection (Postgres). Required: there is no in-memory-only mode in the service. */
  readonly nonceStore: NonceStore;
  readonly nonces?: NonceCache;
  readonly maxTtlSec?: number;
  readonly logger: Logger;
}

const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/;

export function authMiddleware(o: AuthOptions) {
  const nonces = o.nonces ?? new NonceCache();
  return createMiddleware<AppEnv>(async (c, next) => {
    const header = c.req.header("authorization");
    const unauthenticated = (why: string): ApiError => {
      o.logger.warn("auth.rejected", { reason: why, requestId: c.get("requestId") });
      return new ApiError(
        "UNAUTHENTICATED",
        "missing or invalid service token",
        {},
        { "WWW-Authenticate": "Bearer" },
      );
    };
    if (header === undefined) throw unauthenticated("NO_HEADER");
    const m = BEARER.exec(header);
    if (m === null || m[1] === undefined) throw unauthenticated("BAD_SCHEME");
    const nowSec = Math.floor(o.clock() / 1000);
    const r = await verifyServiceTokenDurable(
      m[1],
      {
        secret: o.secret,
        profile: o.profile,
        nowSec,
        nonces,
        ...(o.maxTtlSec === undefined ? {} : { maxTtlSec: o.maxTtlSec }),
      },
      o.nonceStore,
    );
    if (!r.ok) {
      // A full nonce cache is an availability problem on our side, not a bad credential.
      if (r.reason === "STORE_ERROR") {
        o.logger.error("auth.nonce_store_failed", { requestId: c.get("requestId") });
        throw new ApiError(
          "UNAVAILABLE",
          "authentication is temporarily unavailable",
          {},
          { "Retry-After": "5" },
        );
      }
      if (r.reason === "CACHE_FULL")
        throw new ApiError(
          "UNAVAILABLE",
          "service is busy; retry shortly",
          {},
          { "Retry-After": "5" },
        );
      throw unauthenticated(r.reason);
    }
    c.set("auth", { tenantId: r.tenantId, nonce: r.nonce });
    await next();
  });
}

/** Refuse a request that names a tenant other than the token's. Absent = fine (the token's tenant is used). */
export function assertSameTenant(auth: AuthInfo, named: string | null | undefined): void {
  if (named === undefined || named === null) return;
  if (named.toLowerCase() !== auth.tenantId)
    throw new ApiError("TENANT_MISMATCH", "the request names a different tenant than the token");
}
