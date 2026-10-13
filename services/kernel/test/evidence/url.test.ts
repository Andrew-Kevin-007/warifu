// Strict evidence-URL grammar and allowlist matching (docs/04 K-09, RT-02). Pure; no network.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hostMatches, originPatternHost, parseEvidenceUrl } from "../../src/evidence/ssrf/url";

describe("parseEvidenceUrl: accepted shapes", () => {
  it("accepts a plain https URL and canonicalizes host case, fragment and the empty path", () => {
    expect(parseEvidenceUrl("https://Example.COM")).toEqual({ ok: true, url: { host: "example.com", target: "/", canonical: "https://example.com/" } });
    expect(parseEvidenceUrl("https://example.com/health?x=1#frag")).toEqual({ ok: true, url: { host: "example.com", target: "/health?x=1", canonical: "https://example.com/health?x=1" } });
    expect(parseEvidenceUrl("https://example.com?x=1")).toMatchObject({ ok: true, url: { target: "/?x=1" } });
  });
  it("accepts an explicit :443 and nothing else", () => {
    expect(parseEvidenceUrl("https://example.com:443/a")).toMatchObject({ ok: true, url: { host: "example.com" } });
    for (const p of ["80", "8443", "0", "65535", "", "0443", "443a", "4430", "-443", "443.0"]) {
      expect(parseEvidenceUrl(`https://example.com:${p}/`), p).toEqual({ ok: false, code: "PORT_DENIED" });
    }
  });
  it("an '@' or backslash after the authority is harmless text, not userinfo", () => {
    expect(parseEvidenceUrl("https://example.com/path@x")).toMatchObject({ ok: true });
    expect(parseEvidenceUrl("https://example.com?u=a@b")).toMatchObject({ ok: true });
    expect(parseEvidenceUrl("https://example.com#@evil.test")).toMatchObject({ ok: true, url: { host: "example.com" } });
  });
});

describe("parseEvidenceUrl: refusals", () => {
  const cases: Array<[string, unknown, string]> = [
    ["non-string", 42, "URL_MALFORMED"],
    ["undefined", undefined, "URL_MALFORMED"],
    ["empty", "", "URL_MALFORMED"],
    ["too long", `https://example.com/${"a".repeat(2100)}`, "URL_MALFORMED"],
    ["http", "http://example.com/", "SCHEME_NOT_HTTPS"],
    ["file", "file:///etc/passwd", "SCHEME_NOT_HTTPS"],
    ["gopher", "gopher://example.com:70/_x", "SCHEME_NOT_HTTPS"],
    ["javascript", "javascript:alert(1)", "SCHEME_NOT_HTTPS"],
    ["data", "data:text/plain;base64,AAAA", "SCHEME_NOT_HTTPS"],
    ["uppercase scheme", "HTTPS://example.com/", "SCHEME_NOT_HTTPS"],
    ["no scheme", "example.com/health", "URL_MALFORMED"],
    ["scheme-relative", "//example.com/", "URL_MALFORMED"],
    ["single slash", "https:/example.com/", "SCHEME_NOT_HTTPS"],
    ["userinfo", "https://user:pw@example.com/", "USERINFO"],
    ["userinfo trick", "https://example.com@evil.test/", "USERINFO"],
    ["userinfo percent", "https://example.com%40evil.test/", "HOST_INVALID"],
    ["backslash", "https://example.com\\@evil.test/", "URL_MALFORMED"],
    ["backslash path", "https://example.com/a\\b", "URL_MALFORMED"],
    ["space", "https://exa mple.com/", "URL_MALFORMED"],
    ["tab", "https://example.com/\t", "URL_MALFORMED"],
    ["newline", "https://example.com/a\nHost: evil.test", "URL_MALFORMED"],
    ["crlf", "https://example.com/\r\n", "URL_MALFORMED"],
    ["nul", "https://example.com/\u0000", "URL_MALFORMED"],
    ["non-ascii host", "https://ɡoogle.com/", "URL_MALFORMED"],
    ["fullwidth digits", "https://１２７.0.0.1/", "URL_MALFORMED"],
    ["empty host", "https:///path", "URL_MALFORMED"],
    ["empty host with port", "https://:443/", "URL_MALFORMED"],
    ["trailing dot", "https://example.com./", "HOST_INVALID"],
    ["double dot", "https://example..com/", "HOST_INVALID"],
    ["leading dot", "https://.example.com/", "HOST_INVALID"],
    ["underscore", "https://exa_mple.com/", "HOST_INVALID"],
    ["leading hyphen", "https://-example.com/", "HOST_INVALID"],
    ["single label", "https://intranet/", "HOST_INVALID"],
    ["localhost", "https://localhost/", "HOST_INVALID"],
    ["subdomain of localhost", "https://app.localhost/", "HOST_INVALID"],
    ["dot-local", "https://printer.local/", "HOST_INVALID"],
    ["dot-internal", "https://metadata.google.internal/", "HOST_INVALID"],
    ["percent in host", "https://exa%6dple.com/", "HOST_INVALID"],
    ["IPv4", "https://93.184.216.34/", "IP_LITERAL"],
    ["metadata IP", "https://169.254.169.254/latest/meta-data/", "IP_LITERAL_NON_GLOBAL"],
    ["loopback", "https://127.0.0.1/", "IP_LITERAL_NON_GLOBAL"],
    ["loopback short", "https://127.1/", "IP_LITERAL_NON_GLOBAL"],
    ["decimal IP", "https://2130706433/", "IP_LITERAL_NON_GLOBAL"],
    ["hex IP", "https://0x7f000001/", "IP_LITERAL_NON_GLOBAL"],
    ["hex IP dotted", "https://0x7f.0x0.0x0.0x1/", "IP_LITERAL_NON_GLOBAL"],
    ["octal IP", "https://0177.0.0.1/", "IP_LITERAL_NON_GLOBAL"],
    ["octal metadata", "https://0251.0376.0251.0376/", "IP_LITERAL_NON_GLOBAL"],
    ["uppercase hex IP", "https://0X7F000001/", "IP_LITERAL_NON_GLOBAL"],
    ["zero", "https://0/", "IP_LITERAL_NON_GLOBAL"],
    ["numeric tail on a name", "https://example.0x1/", "HOST_INVALID"],
    ["numeric tail digits", "https://example.123/", "HOST_INVALID"],
    ["IPv6 loopback", "https://[::1]/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 loopback long", "https://[0:0:0:0:0:0:0:1]:443/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 mapped", "https://[::ffff:127.0.0.1]/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 mapped hex", "https://[::ffff:7f00:1]/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 ULA", "https://[fd00:ec2::254]/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 link-local", "https://[fe80::1]/", "IP_LITERAL_NON_GLOBAL"],
    ["IPv6 zone id", "https://[fe80::1%25eth0]/", "HOST_INVALID"],
    ["IPv6 global literal", "https://[2606:4700:4700::1111]/", "IP_LITERAL"],
    ["IPv6 unterminated", "https://[::1/", "URL_MALFORMED"],
    ["IPv6 junk after bracket", "https://[::1]x/", "URL_MALFORMED"],
    ["IPv6 not an address", "https://[zzzz]/", "HOST_INVALID"],
  ];
  it.each(cases)("%s", (_name, input, code) => {
    expect(parseEvidenceUrl(input)).toEqual({ ok: false, code });
  });

  it("property: no string made of an IPv4 literal in a decimal, hex or octal spelling is ever accepted", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), fc.constantFrom("dec", "hex", "oct", "dotted"), (n, kind) => {
        const host = kind === "dec" ? String(n) : kind === "hex" ? `0x${n.toString(16)}` : kind === "oct" ? `0${n.toString(8)}` : [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
        expect(parseEvidenceUrl(`https://${host}/`).ok).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it("property: arbitrary text after https:// never yields an accepted URL whose host is not a plain LDH name", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 80 }), (s) => {
        const r = parseEvidenceUrl(`https://${s}`);
        if (r.ok) expect(r.url.host).toMatch(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
      }),
      { numRuns: 500 },
    );
  });
});

describe("allowlist matching", () => {
  it("exact entries match exactly; wildcard entries need at least one extra label", () => {
    expect(hostMatches("app.example.com", "app.example.com")).toBe(true);
    expect(hostMatches("app.example.com", "example.com")).toBe(false);
    expect(hostMatches("a.vercel.app", "*.vercel.app")).toBe(true);
    expect(hostMatches("a.b.vercel.app", "*.vercel.app")).toBe(true);
    expect(hostMatches("vercel.app", "*.vercel.app")).toBe(false);
    expect(hostMatches("evilvercel.app", "*.vercel.app")).toBe(false);
    expect(hostMatches("a.vercel.app.evil.test", "*.vercel.app")).toBe(false);
    expect(hostMatches("a.vercel.app", "")).toBe(false);
  });
  it("turns policy origin patterns into host patterns and refuses everything else", () => {
    expect(originPatternHost("https://*.vercel.app")).toBe("*.vercel.app");
    expect(originPatternHost("https://EdithStudio.vercel.app")).toBe("edithstudio.vercel.app");
    for (const bad of ["http://a.example.com", "*.vercel.app", "https://", "https://a b.example.com", "https://*", "https://a.*.example.com", "https://example", "https://example.com/path"]) {
      expect(originPatternHost(bad), bad).toBeNull();
    }
  });
});
