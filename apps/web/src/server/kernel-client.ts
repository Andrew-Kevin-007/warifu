// Server-only kernel client (TB-2, RT-31). Mints the short-lived HMAC service token exactly as
// services/kernel/src/auth/token.ts verifies it, and calls the kernel's /v1 API. The browser never sees the token, the
// secret, or the kernel URL: this module is imported only from route handlers and server components.
//
//   token = "v1." + b64url(payload JSON) + "." + b64url(HMAC-SHA256(secret, "symbolon-svc-token/1\n" + profile + "\n" + payloadSegment))
//   payload = { v:1, tid, aud:"kernel:<profile>", iat, exp (<= 60 s), nonce }
//
// The web env names deliberately avoid the kernel's own variable names (test:web-env forbids those in apps/web).
// A missing configuration is an `unavailable` result, so pages fall back to the RECORDED replay bundle (INV-21).
import { createHmac, randomBytes } from "node:crypto";

if (typeof window !== "undefined") throw new Error("kernel-client is server-only");

const MAC_DOMAIN = "symbolon-svc-token/1";

export type KernelProfile = "production" | "sandbox";

export interface KernelClientConfig {
  readonly baseUrl: string;
  readonly secret: string;
  readonly tenantId: string;
  readonly profile: KernelProfile;
}

/** A PASTE_*_HERE value is the template's "not pasted yet" marker: it reads as unset. */
const pasted = (v: string | undefined): string | undefined => (v === undefined || /^PASTE_[A-Z0-9_]*_HERE$/.test(v.trim()) ? undefined : v);

export function loadKernelClientConfig(env: Record<string, string | undefined> = process.env): KernelClientConfig | null {
  const baseUrl = pasted(env["WEB_SVC_URL"]);
  const secret = pasted(env["WEB_SVC_SECRET"]);
  const tenantId = pasted(env["WEB_SVC_TENANT_ID"]);
  const profile = env["WEB_SVC_PROFILE"] === "sandbox" ? "sandbox" : env["WEB_SVC_PROFILE"] === "production" ? "production" : null;
  if (!baseUrl || !secret || !tenantId || profile === null) return null;
  if (!/^https?:\/\//.test(baseUrl)) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), secret, tenantId, profile };
}

export function mintToken(cfg: KernelClientConfig, nowSec: number, ttlSec = 30, nonce: string = randomBytes(18).toString("base64url")): string {
  const payload = { v: 1, tid: cfg.tenantId, aud: `kernel:${cfg.profile}`, iat: nowSec, exp: nowSec + Math.min(ttlSec, 60), nonce };
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", Buffer.from(cfg.secret, "utf8")).update(`${MAC_DOMAIN}\n${cfg.profile}\n${segment}`).digest();
  return `v1.${segment}.${mac.toString("base64url")}`;
}

export type KernelResult<T> =
  | { readonly ok: true; readonly status: number; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly detail?: Readonly<Record<string, string | number | boolean | null>>; readonly retryAfter?: number };

/** Bounded, flat copy of the kernel's error `detail` (scalars only, short strings): safe to hand to a page. */
function safeDetail(json: unknown): Record<string, string | number | boolean | null> | undefined {
  const d = typeof json === "object" && json !== null && "error" in json ? (json as { error?: { detail?: unknown } }).error?.detail : undefined;
  if (typeof d !== "object" || d === null || Array.isArray(d)) return undefined;
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(d).slice(0, 8)) {
    if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) && (typeof v === "number" || typeof v === "boolean" || v === null)) out[k] = v;
    else if (/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(k) && typeof v === "string") out[k] = v.slice(0, 64);
  }
  return out;
}

export interface KernelCallOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  /** The visitor's address, forwarded for the challenge's salted-hash rate limits (the kernel hashes it at once; never stored raw). */
  readonly clientIp?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly config?: KernelClientConfig | null;
}

/** One call. Never throws: network errors, timeouts and bad JSON are `{ ok:false, code:"UNAVAILABLE" }`. */
export async function kernelCall<T>(path: string, o: KernelCallOptions = {}): Promise<KernelResult<T>> {
  const cfg = o.config === undefined ? loadKernelClientConfig() : o.config;
  if (cfg === null) return { ok: false, status: 503, code: "UNAVAILABLE" };
  if (!path.startsWith("/v1/")) return { ok: false, status: 400, code: "BAD_PATH" };
  const f = o.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${mintToken(cfg, Math.floor(Date.now() / 1000))}`,
    Accept: "application/json",
  };
  if (o.body !== undefined) headers["Content-Type"] = "application/json";
  if (o.idempotencyKey !== undefined) headers["Idempotency-Key"] = o.idempotencyKey;
  if (o.clientIp !== undefined && /^[0-9a-fA-F:.]{3,45}$/.test(o.clientIp)) headers["X-Client-Ip"] = o.clientIp;
  try {
    const res = await f(`${cfg.baseUrl}${path}`, {
      method: o.method ?? "GET",
      headers,
      ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, data: json as T };
    const code = typeof json === "object" && json !== null && "error" in json ? String((json as { error?: { code?: unknown } }).error?.code ?? "ERROR") : "ERROR";
    const ra = Number.parseInt(res.headers.get("retry-after") ?? "", 10);
    const detail = safeDetail(json);
    return { ok: false, status: res.status, code: code.slice(0, 64), ...(detail === undefined ? {} : { detail }), ...(Number.isFinite(ra) && ra > 0 && ra < 86_400 ? { retryAfter: ra } : {}) };
  } catch {
    return { ok: false, status: 502, code: "UNAVAILABLE" };
  }
}
