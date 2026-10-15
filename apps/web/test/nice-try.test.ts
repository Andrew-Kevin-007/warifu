import { describe, expect, it } from "vitest";
import { REASON_CODES, VERDICTS } from "@symbolon/schemas";
import { GENERIC_PHRASES, NICE_TRY_PHRASES, niceTry } from "../src/lib/nice-try";
import { renderCardSvg } from "../src/lib/share-card";

const H1 = "0x" + "ab".repeat(32);
const BANNED = /\b(proven|provably|guaranteed|audited|unhackable|unbreakable|risk-free)\b|100 ?% secure/i;

describe("nice-try phrase banks", () => {
  it("covers every reason code with at least three phrasings", () => {
    for (const c of REASON_CODES) {
      const bank = NICE_TRY_PHRASES[c];
      expect(bank, c).toBeDefined();
      expect(bank.length, c).toBeGreaterThanOrEqual(3);
    }
    expect(Object.keys(NICE_TRY_PHRASES).sort()).toEqual([...REASON_CODES].sort());
  });

  it("has verdict-level banks for every verdict", () => {
    for (const v of VERDICTS) expect(GENERIC_PHRASES[v].length).toBeGreaterThanOrEqual(3);
  });

  it("phrases are non-empty, free of banned words and of digits (no typed figures)", () => {
    const all = [...Object.values(NICE_TRY_PHRASES), ...Object.values(GENERIC_PHRASES)].flat();
    for (const p of all) {
      expect(p.trim().length).toBeGreaterThan(2);
      expect(BANNED.test(p), p).toBe(false);
      expect(/[0-9]/.test(p), p).toBe(false);
      expect(/[<>&"`]/.test(p), p).toBe(false);
    }
  });

  it("is deterministic per receipt hash and varies across hashes", () => {
    const a = niceTry({ verdict: "REJECT", reasons: ["PAYEE_MISMATCH"], receiptHash: H1 });
    expect(niceTry({ verdict: "REJECT", reasons: ["PAYEE_MISMATCH"], receiptHash: H1 })).toEqual(a);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(niceTry({ verdict: "REJECT", reasons: ["PAYEE_MISMATCH"], receiptHash: "0x" + i.toString(16).padStart(8, "0") + "0".repeat(56) }).line);
    expect(seen.size).toBeGreaterThan(1);
    expect(a.reasonCode).toBe("PAYEE_MISMATCH");
  });

  it("RELEASE never gets a rejection line; an empty or malformed input still yields a line", () => {
    expect(niceTry({ verdict: "RELEASE", reasons: ["TIMING_CLAMPED"], receiptHash: H1 }).reasonCode).toBeNull();
    expect(niceTry({ verdict: "HOLD", reasons: [], receiptHash: "junk" }).line.length).toBeGreaterThan(0);
  });
});

describe("share card", () => {
  it("renders verdict, reason code, hash and the audit pointer", () => {
    const n = niceTry({ verdict: "REJECT", reasons: ["PAYEE_MISMATCH"], receiptHash: H1 });
    const s = renderCardSvg({ verdict: "REJECT", reasonCode: n.reasonCode, receiptHash: H1, line: n.line, source: "LIVE" });
    expect(s).toContain("REJECT");
    expect(s).toContain("PAYEE_MISMATCH");
    expect(s).toContain(H1.slice(0, 34));
    expect(s).toContain("/audit");
  });

  it("rejects non-hash and non-verdict inputs rather than echoing them", () => {
    expect(() => renderCardSvg({ verdict: "REJECT", reasonCode: null, receiptHash: "<script>", line: "x", source: "LIVE" })).toThrow();
    expect(() => renderCardSvg({ verdict: "<b>", reasonCode: null, receiptHash: H1, line: "x", source: "LIVE" })).toThrow();
  });

  it("drops a reason code that is not an enum-looking token", () => {
    const s = renderCardSvg({ verdict: "HOLD", reasonCode: "evil <x>", receiptHash: H1, line: "Held.", source: "LIVE" });
    expect(s).not.toContain("evil");
  });
});
