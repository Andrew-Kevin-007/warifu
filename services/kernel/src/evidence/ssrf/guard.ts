// The hardened egress guard (docs/04 K-09, RT-02): the ONLY code path through which the kernel service may fetch a URL for
// evidence. Order of every hop, each step fail-closed:
//   1. strict URL grammar (url.ts): https, port 443, no userinfo, no IP literal in any spelling, printable ASCII;
//   2. the host must be in the allowlist handed in by the caller. The caller derives that list from the SIGNED engagement's
//      evidence spec (and the tenant policy), never from an invoice, an intent or a redirect (service.ts);
//   3. DNS is resolved ONCE per host per request; EVERY answer must be a global unicast address (one private answer in a mixed
//      set is a rebinding attempt and denies the host); the first answer is PINNED;
//   4. the transport connects to the pinned IP (never to the name) and sets Host and TLS SNI to the name, so a second DNS lookup
//      can never redirect the connection;
//   5. redirects are followed only up to the configured maximum (0 for the sandbox and for GitHub), and each Location is
//      re-parsed, re-allowlisted and re-resolved from scratch (step 1 onwards); credentials are never forwarded;
//   6. time (5 s overall, DNS included) and size (1 MiB) caps. The body is returned as bytes and is never decoded or parsed here.
// The guard returns values, never throws for a denial; callers map a denial to `EVIDENCE_SOURCE_DENIED`.
import { classifyAddress } from "./ip";
import { hostMatches, parseEvidenceUrl } from "./url";
import type { UrlDenialCode } from "./url";

export interface Resolver {
  /** All A/AAAA answers for `host`, as text, in the order the resolver returned them. */
  resolve(host: string): Promise<readonly string[]>;
}

/** One pinned request. The transport MUST connect to `ip:443` and use `host` for the Host header and TLS SNI/verification. */
export interface PinnedRequest {
  readonly ip: string;
  readonly host: string;
  /** "/..." including the query. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly maxBodyBytes: number;
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  /** Only the headers the guard reads, lowercase names. */
  readonly location: string | null;
  readonly body: Uint8Array;
  /** The body was longer than `maxBodyBytes`; `body` holds at most that many bytes and must not be hashed as the whole. */
  readonly truncated: boolean;
}

export interface Transport {
  get(req: PinnedRequest): Promise<TransportResponse>;
}

export interface GuardLimits {
  readonly timeoutMs: number;
  readonly maxBodyBytes: number;
  readonly maxRedirects: number;
}

/** docs/04 K-09: 5 s, 1 MB, max 2 redirects. */
export const DEFAULT_LIMITS: GuardLimits = Object.freeze({ timeoutMs: 5_000, maxBodyBytes: 1_048_576, maxRedirects: 2 });

export type DenialCode = UrlDenialCode | "HOST_NOT_ALLOWED" | "DNS_NON_GLOBAL" | "REDIRECT_LIMIT" | "REDIRECT_TARGET_INVALID" | "EGRESS_DISABLED";
export type ErrorCode = "DNS_FAILED" | "TIMEOUT" | "TRANSPORT_ERROR";

export interface GuardedGetRequest {
  readonly url: unknown;
  /** Exact hostnames or `*.suffix` entries. Empty = nothing is allowed. */
  readonly allowedHosts: readonly string[];
  /** Extra request headers (lowercase names). `authorization` is sent on the first hop only. Host/connection headers are the transport's. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly limits?: Partial<GuardLimits>;
  /** A 3xx answer is the result (used when the spec expects a 3xx status); it is never followed. */
  readonly redirectIsResult?: boolean;
}

export type GuardedGetResult =
  | {
      readonly ok: true;
      readonly status: number;
      readonly body: Uint8Array;
      readonly truncated: boolean;
      readonly finalHost: string;
      readonly finalUrl: string;
      readonly redirects: number;
      readonly pinnedIp: string;
    }
  | { readonly ok: false; readonly kind: "denied"; readonly code: DenialCode }
  | { readonly ok: false; readonly kind: "error"; readonly code: ErrorCode };

export interface GuardDeps {
  readonly resolver: Resolver;
  readonly transport: Transport;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_ANSWERS = 32;
const denied = (code: DenialCode): GuardedGetResult => ({ ok: false, kind: "denied", code });
const failed = (code: ErrorCode): GuardedGetResult => ({ ok: false, kind: "error", code });

/** Resolve once and pin. Returns the pinned IP, or the result to give back. */
async function pinHost(resolver: Resolver, host: string): Promise<{ ip: string } | GuardedGetResult> {
  let answers: readonly string[];
  try {
    answers = await resolver.resolve(host);
  } catch {
    return failed("DNS_FAILED");
  }
  if (answers.length === 0) return failed("DNS_FAILED");
  const list = answers.slice(0, MAX_ANSWERS);
  for (const a of list) {
    const v = classifyAddress(a);
    if (v.kind !== "ip" || !v.global) return denied("DNS_NON_GLOBAL"); // one bad answer poisons the host
  }
  return { ip: list[0] as string };
}

/** Absolute https URL or same-host absolute path only; anything else (scheme-relative, relative, other schemes) is refused. */
function resolveLocation(currentHost: string, location: string): string | null {
  if (location.length === 0 || location.length > 2048) return null;
  if (location.startsWith("https://")) return location;
  if (location.startsWith("/") && !location.startsWith("//")) return `https://${currentHost}${location}`;
  return null;
}

async function run(d: GuardDeps, r: GuardedGetRequest, limits: GuardLimits, signal: AbortSignal): Promise<GuardedGetResult> {
  const pins = new Map<string, string>();
  let current: unknown = r.url;
  for (let hop = 0; ; hop++) {
    const parsed = parseEvidenceUrl(current);
    if (!parsed.ok) return denied(hop === 0 ? parsed.code : "REDIRECT_TARGET_INVALID");
    const { host, target, canonical } = parsed.url;
    if (!r.allowedHosts.some((a) => hostMatches(host, a))) return denied("HOST_NOT_ALLOWED");

    let ip = pins.get(host);
    if (ip === undefined) {
      const pin = await pinHost(d.resolver, host);
      if (!("ip" in pin)) return pin;
      ip = pin.ip;
      pins.set(host, ip);
    }
    if (signal.aborted) return failed("TIMEOUT");

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(r.headers ?? {})) {
      const name = k.toLowerCase();
      if (name === "host" || name === "connection" || name === "content-length" || name === "transfer-encoding" || name === "cookie") continue;
      if (name === "authorization" && hop > 0) continue; // never forwarded across a redirect
      headers[name] = v;
    }
    headers["accept-encoding"] = "identity"; // no decompression: the byte cap is the real cap

    let resp: TransportResponse;
    try {
      resp = await d.transport.get({ ip, host, path: target, headers, maxBodyBytes: limits.maxBodyBytes, signal });
    } catch {
      return signal.aborted ? failed("TIMEOUT") : failed("TRANSPORT_ERROR");
    }

    if (REDIRECT_STATUSES.has(resp.status) && resp.location !== null && r.redirectIsResult !== true) {
      if (hop >= limits.maxRedirects) return denied("REDIRECT_LIMIT");
      const next = resolveLocation(host, resp.location);
      if (next === null) return denied("REDIRECT_TARGET_INVALID");
      current = next;
      continue;
    }
    return { ok: true, status: resp.status, body: resp.body, truncated: resp.truncated, finalHost: host, finalUrl: canonical, redirects: hop, pinnedIp: ip };
  }
}

/** GET `r.url` under every rule above. Never throws. */
export async function guardedGet(d: GuardDeps, r: GuardedGetRequest): Promise<GuardedGetResult> {
  const limits: GuardLimits = { ...DEFAULT_LIMITS, ...(r.limits ?? {}) };
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<GuardedGetResult>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve(failed("TIMEOUT"));
    }, limits.timeoutMs);
  });
  try {
    return await Promise.race([run(d, r, limits, ac.signal).catch((): GuardedGetResult => failed("TRANSPORT_ERROR")), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
