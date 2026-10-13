// Strict parsing of an evidence URL (docs/04 K-09 "SSRF guard", RT-02). Deliberately NOT `new URL()`: the WHATWG parser is
// lenient on purpose (it strips tabs/newlines, rewrites backslashes, accepts userinfo, normalizes odd IP spellings), and every
// leniency is a place where "what we checked" and "what the socket connects to" can differ. This parser accepts a small
// grammar and rejects everything else; the result carries only values we constructed ourselves.
//
// Accepted:  https://<LDH hostname>[:443]/<path>?<query>[#fragment]   printable ASCII only, <= 2048 chars, no userinfo,
//            no backslash, no percent-escapes in the authority, no IP literal of ANY spelling, no single-label or reserved
//            internal-looking names, no trailing dot.
// The hostname is a NAME. A literal IP (including decimal/octal/hex/short IPv4 and every IPv6 form) is refused, because the
// allowlist is a list of names; the IP classifier still runs on literals so the denial reason says what it was.
import { classifyHostLiteral } from "./ip";

export type UrlDenialCode =
  | "URL_MALFORMED"
  | "SCHEME_NOT_HTTPS"
  | "USERINFO"
  | "PORT_DENIED"
  | "IP_LITERAL"
  | "IP_LITERAL_NON_GLOBAL"
  | "HOST_INVALID";

export interface ParsedUrl {
  readonly host: string;
  /** "/..." including the query; never empty; fragment removed. */
  readonly target: string;
  /** Canonical `https://host/target` (port 443 implied). */
  readonly canonical: string;
}

export type UrlParse = { readonly ok: true; readonly url: ParsedUrl } | { readonly ok: false; readonly code: UrlDenialCode };

export const MAX_URL_CHARS = 2048;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Names that never leave a private network. Defence in depth: the allowlist and the DNS check already exclude them. */
const INTERNAL_SUFFIXES = ["localhost", "local", "localdomain", "internal", "intranet", "lan", "home", "corp", "private", "arpa"];

const deny = (code: UrlDenialCode): UrlParse => ({ ok: false, code });

export function parseEvidenceUrl(raw: unknown): UrlParse {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return deny("URL_MALFORMED");
  // printable ASCII only: no whitespace, controls, NUL, non-ASCII (IDN must be sent as punycode), no backslash
  if (!/^[\x21-\x7e]+$/.test(raw) || raw.includes("\\")) return deny("URL_MALFORMED");
  if (!raw.startsWith("https://")) return deny(/^[A-Za-z][A-Za-z0-9+.-]*:/.test(raw) ? "SCHEME_NOT_HTTPS" : "URL_MALFORMED");

  const afterScheme = raw.slice("https://".length);
  const end = afterScheme.search(/[/?#]/);
  const authority = end === -1 ? afterScheme : afterScheme.slice(0, end);
  const rest = end === -1 ? "" : afterScheme.slice(end);
  if (authority === "") return deny("URL_MALFORMED");
  if (authority.includes("@")) return deny("USERINFO");
  if (authority.includes("%")) return deny("HOST_INVALID");

  let hostPart = authority;
  let port: string | null = null;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close === -1) return deny("URL_MALFORMED");
    hostPart = authority.slice(0, close + 1);
    const after = authority.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) return deny("URL_MALFORMED");
      port = after.slice(1);
    }
  } else {
    const colon = authority.indexOf(":");
    if (colon !== -1) {
      hostPart = authority.slice(0, colon);
      port = authority.slice(colon + 1);
    }
  }
  if (port !== null && port !== "443") return deny("PORT_DENIED"); // empty, odd, zero-padded: all refused
  if (hostPart === "") return deny("URL_MALFORMED");

  const host = hostPart.toLowerCase();
  // IP literals: brackets, or a name whose last label looks numeric (the WHATWG "ends in a number" rule): classify, then refuse.
  const lastLabel = host.slice(host.lastIndexOf(".") + 1);
  const numericish = host.startsWith("[") || /^(?:[0-9]+|0[xX][0-9a-fA-F]*)$/.test(lastLabel);
  if (numericish) {
    const v = classifyHostLiteral(host);
    if (v.kind === "ip") return deny(v.global ? "IP_LITERAL" : "IP_LITERAL_NON_GLOBAL");
    return deny("HOST_INVALID"); // numeric-looking but not an address: a parser would reject it, so do we
  }

  if (host.length > 253 || host.endsWith(".")) return deny("HOST_INVALID");
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => LABEL.test(l))) return deny("HOST_INVALID");
  if (INTERNAL_SUFFIXES.includes(labels[labels.length - 1] as string)) return deny("HOST_INVALID");

  const noFragment = rest.split("#")[0] as string;
  const target = noFragment === "" ? "/" : noFragment.startsWith("?") ? `/${noFragment}` : noFragment;
  return { ok: true, url: { host, target, canonical: `https://${host}${target}` } };
}

/**
 * Match a host against allowlist entries. An entry is a lowercase hostname, or `*.suffix` meaning "one or more labels, then
 * .suffix" (so `*.vercel.app` never matches the bare `vercel.app` and never `evilvercel.app`).
 */
export function hostMatches(host: string, entry: string): boolean {
  if (entry.startsWith("*.")) {
    const suffix = entry.slice(1); // ".vercel.app"
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === entry;
}

/** Turn a policy origin pattern ("https://*.vercel.app", "https://edithstudio.vercel.app") into a host pattern, or null if it is not one. */
export function originPatternHost(pattern: string): string | null {
  if (!pattern.startsWith("https://")) return null;
  const h = pattern.slice("https://".length).toLowerCase();
  if (!/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(h)) return null;
  return h;
}
