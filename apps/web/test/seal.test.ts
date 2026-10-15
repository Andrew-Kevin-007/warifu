import { describe, expect, it } from "vitest";
import { renderSealSvg, sealAlt } from "../src/lib/seal";
import type { SealInput } from "../src/lib/seal";
import { isEmbeddablePath, isRouteAllowed } from "../src/lib/security";

const base: SealInput = { state: "VALID", bound: "$1,250.00", horizonLabel: "24h", blockNumber: 1234, source: "LIVE" };

describe("seal", () => {
  it("VALID shows the bound and the as-of block", () => {
    const s = renderSealSvg(base);
    expect(s).toContain("INTACT");
    expect(s).toContain("$1,250.00");
    expect(s).toContain("as of block 1234");
    expect(s).not.toContain("RECORDED");
  });

  it("STALE is cracked and shows no figure", () => {
    const s = renderSealSvg({ ...base, state: "STALE" });
    expect(s).toContain("CRACKED: STALE");
    expect(s).not.toContain("$1,250.00");
    expect(s).toContain("<path");
  });

  it("UNVERIFIED and not-computed are blank, with no block and no figure", () => {
    for (const state of ["UNVERIFIED", "NOT_COMPUTED"] as const) {
      const s = renderSealSvg({ ...base, state });
      expect(s).not.toContain("$");
      expect(s).not.toContain("as of block");
      expect(s).toContain("no claim");
    }
  });

  it("labels the replay fallback", () => {
    expect(renderSealSvg({ ...base, source: "RECORDED" })).toContain("RECORDED");
  });

  it("refuses to print a bound that is not a plain money string (no untrusted text)", () => {
    const s = renderSealSvg({ ...base, bound: '$1"><script>alert(1)</script>' });
    expect(s).not.toContain("<script");
    expect(s).not.toContain("at most");
    expect(sealAlt({ ...base, bound: "evil" })).not.toContain("evil");
  });

  it("is app-origin only and embeddable", () => {
    const p = "/api/public/seal/0x" + "a".repeat(40);
    expect(isRouteAllowed("app", p)).toBe(true);
    expect(isRouteAllowed("challenge", p)).toBe(false);
    expect(isRouteAllowed("challenge", "/api/public/share/0x" + "a".repeat(64) + "/card.svg")).toBe(false);
    expect(isRouteAllowed("challenge", "/seal/0x" + "a".repeat(40))).toBe(false);
    expect(isEmbeddablePath(p)).toBe(true);
    expect(isEmbeddablePath("/api/public/receipt/0x" + "a".repeat(64))).toBe(false);
  });
});
