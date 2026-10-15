import { describe, expect, it } from "vitest";
import { buildCsp } from "../src/lib/security";

describe("CSP per build profile (INV-16)", () => {
  it("app profile allows WebAssembly (3D scenes) and runtime style elements, but never unsafe-eval or script unsafe-inline", () => {
    const csp = buildCsp({ nonce: "n1", profile: "app" });
    expect(csp).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(eval|inline)'/);
    expect(csp).toMatch(/style-src-elem 'self' 'unsafe-inline'/);
  });

  it("challenge profile stays strict: no wasm, no runtime style elements", () => {
    const csp = buildCsp({ nonce: "n1", profile: "challenge" });
    expect(csp).not.toContain("wasm-unsafe-eval");
    expect(csp).not.toContain("style-src-elem");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-(eval|inline)'/);
  });
});
