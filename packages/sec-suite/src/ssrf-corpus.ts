// SSRF corpus for SEC-02 (RT-02, docs/13 section 4.6). Pure data: no imports, so any package or test can read it.
// Every case must be DENIED by the evidence egress guard (services/kernel/src/evidence/ssrf) before any connection is made.
// The runner is test/sec02-ssrf.test.ts. A case names the stage that must stop it, so a regression that "denies for the wrong
// reason" (for example a DNS answer check masking a missing grammar check) is visible.
//
// Allowlist used by every case unless it says otherwise: ["app.example.com"].

export type SsrfCategory =
  | "scheme"
  | "metadata"
  | "loopback"
  | "rfc1918"
  | "link-local"
  | "ipv6"
  | "ipv4-mapped"
  | "ip-spelling"
  | "userinfo"
  | "port"
  | "host-grammar"
  | "allowlist"
  | "dns-rebinding"
  | "control-chars"
  | "unicode";

export type SsrfExpect =
  /** Stopped by the URL grammar, with this denial code. DNS is never asked. */
  | { readonly stage: "grammar"; readonly code: string }
  /** Parses fine but the host is not in the allowlist. DNS is never asked. */
  | { readonly stage: "allowlist" }
  /** Allowlisted name whose DNS answers contain a non-global address. The transport is never called. */
  | { readonly stage: "dns"; readonly answers: readonly string[] };

export interface SsrfCase {
  readonly id: string;
  readonly category: SsrfCategory;
  readonly url: string;
  readonly expect: SsrfExpect;
  /** Allowlist override (default ["app.example.com"]). */
  readonly allow?: readonly string[];
}

const g = (id: string, category: SsrfCategory, url: string, code: string): SsrfCase => ({ id, category, url, expect: { stage: "grammar", code } });
const NG = "IP_LITERAL_NON_GLOBAL";

export const SSRF_CORPUS: readonly SsrfCase[] = [
  // --- schemes ---------------------------------------------------------------------------------------------------------------
  g("scheme-http", "scheme", "http://app.example.com/health", "SCHEME_NOT_HTTPS"),
  g("scheme-file", "scheme", "file:///etc/passwd", "SCHEME_NOT_HTTPS"),
  g("scheme-gopher", "scheme", "gopher://app.example.com:6379/_INFO", "SCHEME_NOT_HTTPS"),
  g("scheme-ftp", "scheme", "ftp://app.example.com/x", "SCHEME_NOT_HTTPS"),
  g("scheme-dict", "scheme", "dict://app.example.com:11211/stat", "SCHEME_NOT_HTTPS"),
  g("scheme-ldap", "scheme", "ldap://app.example.com/", "SCHEME_NOT_HTTPS"),
  g("scheme-javascript", "scheme", "javascript:alert(document.domain)", "SCHEME_NOT_HTTPS"),
  g("scheme-data", "scheme", "data:text/html;base64,PHNjcmlwdD4=", "SCHEME_NOT_HTTPS"),
  g("scheme-ws", "scheme", "ws://app.example.com/socket", "SCHEME_NOT_HTTPS"),
  g("scheme-uppercase", "scheme", "HTTPS://app.example.com/", "SCHEME_NOT_HTTPS"),
  g("scheme-single-slash", "scheme", "https:/app.example.com/", "SCHEME_NOT_HTTPS"),
  g("scheme-missing", "scheme", "app.example.com/health", "URL_MALFORMED"),
  g("scheme-relative", "scheme", "//app.example.com/health", "URL_MALFORMED"),

  // --- cloud metadata and link-local ----------------------------------------------------------------------------------------
  g("meta-aws-ipv4", "metadata", "https://169.254.169.254/latest/meta-data/iam/security-credentials/", NG),
  g("meta-aws-decimal", "metadata", "https://2852039166/latest/meta-data/", NG),
  g("meta-aws-hex", "metadata", "https://0xa9fea9fe/latest/meta-data/", NG),
  g("meta-aws-octal", "metadata", "https://0251.0376.0251.0376/latest/meta-data/", NG),
  g("meta-aws-ipv6", "metadata", "https://[fd00:ec2::254]/latest/meta-data/", NG),
  g("meta-gcp-name", "metadata", "https://metadata.google.internal/computeMetadata/v1/", "HOST_INVALID"),
  g("meta-azure-ipv4", "metadata", "https://169.254.169.254/metadata/instance?api-version=2021-02-01", NG),
  g("meta-alibaba-cgnat", "metadata", "https://100.100.100.200/latest/meta-data/", NG),
  g("link-local-edge", "link-local", "https://169.254.0.1/", NG),
  g("link-local-ipv6", "link-local", "https://[fe80::1]/", NG),

  // --- loopback ---------------------------------------------------------------------------------------------------------------
  g("loop-127-0-0-1", "loopback", "https://127.0.0.1/admin", NG),
  g("loop-127-short", "loopback", "https://127.1/", NG),
  g("loop-127-three-part", "loopback", "https://127.0.1/", NG),
  g("loop-decimal", "loopback", "https://2130706433/", NG),
  g("loop-hex", "loopback", "https://0x7f000001/", NG),
  g("loop-hex-dotted", "loopback", "https://0x7f.0x0.0x0.0x1/", NG),
  g("loop-octal", "loopback", "https://017700000001/", NG),
  g("loop-octal-dotted", "loopback", "https://0177.0.0.01/", NG),
  g("loop-uppercase-hex", "loopback", "https://0X7F000001/", NG),
  g("loop-unspecified", "loopback", "https://0.0.0.0/", NG),
  g("loop-zero", "loopback", "https://0/", NG),
  g("loop-localhost", "loopback", "https://localhost/", "HOST_INVALID"),
  g("loop-localhost-subdomain", "loopback", "https://admin.localhost/", "HOST_INVALID"),
  g("loop-ipv6", "loopback", "https://[::1]/", NG),
  g("loop-ipv6-long", "loopback", "https://[0000:0000:0000:0000:0000:0000:0000:0001]/", NG),
  g("loop-ipv6-unspecified", "loopback", "https://[::]/", NG),

  // --- private ranges -------------------------------------------------------------------------------------------------------
  g("rfc1918-10", "rfc1918", "https://10.0.0.1/", NG),
  g("rfc1918-172", "rfc1918", "https://172.16.0.1/", NG),
  g("rfc1918-172-top", "rfc1918", "https://172.31.255.255/", NG),
  g("rfc1918-192", "rfc1918", "https://192.168.1.1/", NG),
  g("rfc1918-cgnat", "rfc1918", "https://100.64.0.1/", NG),
  g("rfc1918-10-decimal", "rfc1918", "https://167772161/", NG),
  g("rfc1918-ula", "rfc1918", "https://[fc00::1]/", NG),
  g("rfc1918-ula-fd", "rfc1918", "https://[fd12:3456:789a::1]/", NG),

  // --- IPv6 and IPv4-mapped/transition forms --------------------------------------------------------------------------------
  g("v6-mapped-dotted", "ipv4-mapped", "https://[::ffff:127.0.0.1]/", NG),
  g("v6-mapped-hex", "ipv4-mapped", "https://[::ffff:7f00:1]/", NG),
  g("v6-mapped-private", "ipv4-mapped", "https://[::ffff:10.0.0.1]/", NG),
  g("v6-mapped-metadata", "ipv4-mapped", "https://[::ffff:169.254.169.254]/", NG),
  g("v6-mapped-public", "ipv4-mapped", "https://[::ffff:93.184.216.34]/", NG), // public inside a mapped form: still denied, never unwrapped
  g("v6-nat64", "ipv6", "https://[64:ff9b::7f00:1]/", NG),
  g("v6-6to4", "ipv6", "https://[2002:7f00:1::]/", NG),
  g("v6-teredo", "ipv6", "https://[2001::1]/", NG),
  g("v6-documentation", "ipv6", "https://[2001:db8::1]/", NG),
  g("v6-global-literal", "ipv6", "https://[2606:4700:4700::1111]/", "IP_LITERAL"), // a public literal is refused too: the allowlist is names
  g("v6-zone-id", "ipv6", "https://[fe80::1%25eth0]/", "HOST_INVALID"),
  g("v6-unterminated", "ipv6", "https://[::1/", "URL_MALFORMED"),
  g("v4-global-literal", "ip-spelling", "https://93.184.216.34/", "IP_LITERAL"),

  // --- userinfo -----------------------------------------------------------------------------------------------------------------
  g("userinfo-basic", "userinfo", "https://user:pass@app.example.com/", "USERINFO"),
  g("userinfo-host-trick", "userinfo", "https://app.example.com@evil.test/", "USERINFO"),
  g("userinfo-allowed-as-user", "userinfo", "https://app.example.com:443@127.0.0.1/", "USERINFO"),
  g("userinfo-percent", "userinfo", "https://app.example.com%40evil.test/", "HOST_INVALID"),
  g("userinfo-backslash", "userinfo", "https://evil.test\\@app.example.com/", "URL_MALFORMED"),

  // --- ports -----------------------------------------------------------------------------------------------------------------
  g("port-80", "port", "https://app.example.com:80/", "PORT_DENIED"),
  g("port-8443", "port", "https://app.example.com:8443/", "PORT_DENIED"),
  g("port-22", "port", "https://app.example.com:22/", "PORT_DENIED"),
  g("port-6379", "port", "https://app.example.com:6379/", "PORT_DENIED"),
  g("port-zero", "port", "https://app.example.com:0/", "PORT_DENIED"),
  g("port-empty", "port", "https://app.example.com:/", "PORT_DENIED"),
  g("port-padded", "port", "https://app.example.com:0443/", "PORT_DENIED"),
  g("port-garbage", "port", "https://app.example.com:443a/", "PORT_DENIED"),

  // --- host grammar, controls and unicode ----------------------------------------------------------------------------------
  g("host-trailing-dot", "host-grammar", "https://app.example.com./", "HOST_INVALID"),
  g("host-double-dot", "host-grammar", "https://app..example.com/", "HOST_INVALID"),
  g("host-underscore", "host-grammar", "https://app_x.example.com/", "HOST_INVALID"),
  g("host-single-label", "host-grammar", "https://intranet/", "HOST_INVALID"),
  g("host-dot-internal", "host-grammar", "https://db.internal/", "HOST_INVALID"),
  g("host-dot-local", "host-grammar", "https://printer.local/", "HOST_INVALID"),
  g("host-numeric-tail", "host-grammar", "https://app.example.123/", "HOST_INVALID"),
  g("host-empty", "host-grammar", "https:///path", "URL_MALFORMED"),
  g("ctl-crlf-injection", "control-chars", "https://app.example.com/ok\r\nHost: 169.254.169.254\r\n\r\n", "URL_MALFORMED"),
  g("ctl-tab", "control-chars", "https://app.example.com/\t", "URL_MALFORMED"),
  g("ctl-nul", "control-chars", "https://app.example.com/\u0000", "URL_MALFORMED"),
  g("ctl-space-in-host", "control-chars", "https://app .example.com/", "URL_MALFORMED"),
  g("ctl-backslash-path", "control-chars", "https://app.example.com\\evil.test/", "URL_MALFORMED"),
  g("unicode-idn-homoglyph", "unicode", "https://app.examplе.com/", "URL_MALFORMED"), // Cyrillic e
  g("unicode-fullwidth-ip", "unicode", "https://１２７.0.0.1/", "URL_MALFORMED"),
  g("unicode-ideographic-dot", "unicode", "https://app。example。com/", "URL_MALFORMED"),
  g("over-long", "host-grammar", `https://app.example.com/${"a".repeat(2100)}`, "URL_MALFORMED"),

  // --- allowlist confusion ---------------------------------------------------------------------------------------------------
  { id: "allow-other-host", category: "allowlist", url: "https://evil.example.com/", expect: { stage: "allowlist" } },
  { id: "allow-suffix-confusion", category: "allowlist", url: "https://app.example.com.evil.test/", expect: { stage: "allowlist" } },
  { id: "allow-prefix-confusion", category: "allowlist", url: "https://evilapp.example.com/", expect: { stage: "allowlist" } },
  { id: "allow-parent-domain", category: "allowlist", url: "https://example.com/", expect: { stage: "allowlist" } },
  { id: "allow-wildcard-bare", category: "allowlist", url: "https://vercel.app/", expect: { stage: "allowlist" }, allow: ["*.vercel.app"] },
  { id: "allow-wildcard-lookalike", category: "allowlist", url: "https://evilvercel.app/", expect: { stage: "allowlist" }, allow: ["*.vercel.app"] },
  { id: "allow-wildcard-suffix-attack", category: "allowlist", url: "https://a.vercel.app.evil.test/", expect: { stage: "allowlist" }, allow: ["*.vercel.app"] },

  // --- DNS rebinding and poisoned answers (allowlisted name, bad answers; stub resolver) ----------------------------------------
  { id: "dns-loopback", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["127.0.0.1"] } },
  { id: "dns-metadata", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["169.254.169.254"] } },
  { id: "dns-rfc1918", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["10.1.2.3"] } },
  { id: "dns-cgnat", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["100.64.9.9"] } },
  { id: "dns-ipv6-loopback", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["::1"] } },
  { id: "dns-ipv6-ula", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["fd00::1234"] } },
  { id: "dns-ipv4-mapped", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["::ffff:127.0.0.1"] } },
  { id: "dns-mixed-public-first", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["93.184.216.34", "10.0.0.5"] } },
  { id: "dns-mixed-private-last-of-many", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["93.184.216.34", "93.184.216.35", "2606:4700:4700::1111", "192.168.0.1"] } },
  { id: "dns-documentation", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["203.0.113.7"] } },
  { id: "dns-unspecified", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["0.0.0.0"] } },
  { id: "dns-garbage-answer", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["not-an-address"] } },
  { id: "dns-numeric-spelling-answer", category: "dns-rebinding", url: "https://app.example.com/", expect: { stage: "dns", answers: ["2130706433"] } },
];

/** Redirect chains (SEC-02): the first hop is a legitimate allowlisted URL; a later Location tries to escape. Scripted transport. */
export interface RedirectCase {
  readonly id: string;
  /** Location headers answered by successive hops. */
  readonly locations: readonly string[];
  readonly expectCode: string;
  /** Number of connections that may have been made before the denial (the legitimate first hop and any allowed ones). */
  readonly connections: number;
}

export const SSRF_REDIRECT_CORPUS: readonly RedirectCase[] = [
  { id: "redirect-to-metadata", locations: ["https://169.254.169.254/latest/meta-data/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-metadata-decimal", locations: ["https://2852039166/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-loopback-hex", locations: ["https://0x7f000001/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-ipv6-loopback", locations: ["https://[::1]/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-ipv4-mapped", locations: ["https://[::ffff:10.0.0.1]/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-http", locations: ["http://app.example.com/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-file", locations: ["file:///etc/passwd"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-gopher", locations: ["gopher://app.example.com:6379/_FLUSHALL"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-userinfo", locations: ["https://app.example.com@evil.test/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-odd-port", locations: ["https://app.example.com:6379/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-scheme-relative", locations: ["//evil.test/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-relative-path", locations: ["../../admin"], expectCode: "REDIRECT_TARGET_INVALID", connections: 1 },
  { id: "redirect-to-other-host", locations: ["https://evil.test/"], expectCode: "HOST_NOT_ALLOWED", connections: 1 },
  { id: "redirect-to-internal-name", locations: ["https://internal.example.com/"], expectCode: "HOST_NOT_ALLOWED", connections: 1 },
  { id: "redirect-after-allowed-hop", locations: ["/step2", "https://169.254.169.254/"], expectCode: "REDIRECT_TARGET_INVALID", connections: 2 },
  { id: "redirect-loop-over-limit", locations: ["/a", "/b", "/c", "/d"], expectCode: "REDIRECT_LIMIT", connections: 3 },
];

/** URLs that MUST pass the grammar and allowlist (positive controls: the guard is not simply denying everything). */
export const SSRF_CONTROLS: readonly string[] = [
  "https://app.example.com/health",
  "https://app.example.com",
  "https://APP.Example.COM/Health?x=1&y=2",
  "https://app.example.com:443/health",
  "https://app.example.com/path@with-at-sign",
  "https://app.example.com/?next=https://evil.test/",
  "https://app.example.com#@evil.test",
];
