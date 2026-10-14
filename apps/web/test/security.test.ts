import { describe, expect, it } from "vitest";
import { buildCsp, isRouteAllowed, securityHeaders } from "../src/lib/security";

describe("CSP (WP-17, SEC-06)", () => {
  const csp = buildCsp({ nonce: "abc123", dev: false, profile: "app", connectOrigins: ["https://rpc.example"] });
  it("is nonce-based with strict-dynamic and no unsafe-eval/inline script in production", () => {
    expect(csp).toContain("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe/);
  });
  it("forbids framing, plugins, base-uri and remote frames", () => {
    for (const d of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "frame-src 'none'", "default-src 'self'"]) {
      expect(csp).toContain(d);
    }
  });
  it("only allows listed connect origins", () => {
    expect(csp).toContain("connect-src 'self' https://rpc.example");
  });
  it("has no wildcard sources", () => {
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
  });
});

describe("security headers", () => {
  it("sets the standard set", () => {
    const h = securityHeaders("app");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["Strict-Transport-Security"]).toMatch(/max-age=/);
  });
});

describe("build profiles (INV-16)", () => {
  it("the challenge profile serves only the public allow-list", () => {
    for (const p of ["/", "/challenge", "/attack-lab", "/certificate/0xabc", "/judge", "/replay/main", "/security", "/api/public/attack/latest"]) {
      expect(isRouteAllowed("challenge", p)).toBe(true);
    }
    for (const p of ["/dashboard", "/engagements/new", "/sign/tok", "/intents/1", "/api/owner/x"]) {
      expect(isRouteAllowed("challenge", p)).toBe(false);
    }
  });
  it("an extension never admits a non-public path on the challenge profile", () => {
    for (const p of ["/api/owner/x.json", "/sign/tok.abc", "/dashboard.json", "/%2e%2e/sign/x", "/challenge/../sign/x", "/challenge/%2e%2e/sign/x", "/api/public/../owner/x", "/challenge//x", "/judge.", "/media/..%2fx.png", "/engagements/new.png", "/media/sub/dir/a.png"]) {
      expect(isRouteAllowed("challenge", p), p).toBe(false);
    }
  });
  it("real public assets still pass on the challenge profile", () => {
    for (const p of ["/favicon.ico", "/icon.svg", "/apple-touch-icon.png", "/site.webmanifest", "/fonts/inter.woff2", "/media/hero.png", "/videos/a.webm", "/_next/static/chunks/a.js"]) {
      expect(isRouteAllowed("challenge", p), p).toBe(true);
    }
  });
  it("the app profile serves routes but refuses traversal tricks", () => {
    expect(isRouteAllowed("app", "/dashboard")).toBe(true);
    for (const p of ["/a/../dashboard", "/%2e%2e/x", "/a//b"]) expect(isRouteAllowed("app", p), p).toBe(false);
  });
});
