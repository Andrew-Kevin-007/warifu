// Security headers + CSP (WP-17; INV-15/16, SEC-06/07). Pure functions so they are unit-testable; src/proxy.ts applies them.
// Next 16 renamed `middleware` to `proxy`; the nonce is generated per request and forwarded in `x-nonce`.

export type Profile = "app" | "challenge";

export const PROFILE: Profile = process.env.NEXT_PUBLIC_PROFILE === "challenge" ? "challenge" : "app";

/** Routes served by the `challenge` profile (docs/PROJECT_BRIEF 6.2.3): public, read-only, no wallet, no cookies. */
const CHALLENGE_ALLOWED = [
  /^\/$/,
  /^\/about$/,
  /^\/docs$/,
  /^\/challenge(\/|$)/,
  /^\/attack-lab$/,
  /^\/certificate(\/|$)/,
  /^\/judge$/,
  /^\/replay(\/|$)/,
  /^\/security$/,
  /^\/blast-radius$/,
  /^\/audit(\/|$)/,
  /^\/pilot$/,
  /^\/api\/public(\/|$)/,
  /^\/_next\//,
];

export function isRouteAllowed(profile: Profile, pathname: string): boolean {
  if (profile === "app") return true;
  return CHALLENGE_ALLOWED.some((re) => re.test(pathname)) || /\.[a-z0-9]{2,5}$/i.test(pathname);
}

export interface CspOptions {
  readonly nonce: string;
  readonly dev?: boolean;
  readonly profile?: Profile;
  /** extra connect-src origins (public RPC; the kernel is server-side only so it is never listed) */
  readonly connectOrigins?: readonly string[];
}

export function buildCsp(o: CspOptions): string {
  const dev = o.dev === true;
  const profile = o.profile ?? PROFILE;
  const connect = ["'self'", ...(o.connectOrigins ?? []), ...(dev ? ["ws:", "http://localhost:*"] : [])];
  void profile;
  const d: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${o.nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", `'nonce-${o.nonce}'`, ...(dev ? ["'unsafe-inline'"] : [])],
    // framer-motion / gsap write inline style attributes at runtime; style ELEMENTS still need the nonce.
    "style-src-attr": ["'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:"],
    "font-src": ["'self'"],
    "connect-src": connect,
    "worker-src": ["'self'", "blob:"],
    "media-src": ["'self'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "frame-src": ["'none'"],
  };
  const parts = Object.entries(d).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (!dev) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

/** Static headers on every response (SECURITY.md; docs/13 SEC-06). */
export function securityHeaders(profile: Profile = PROFILE): Record<string, string> {
  return {
    "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      profile === "challenge"
        ? "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()"
        : "camera=(), microphone=(), geolocation=(), usb=()",
  };
}
