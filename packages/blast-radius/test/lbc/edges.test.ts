// Edge cases of the certificate helper modules found by the mutation check (scripts/mutation-check.mjs): digest ordering is
// ascending by id, integer range edges, decimal helpers, artifact ranges, report ordering.
import { hashJcs } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { computeBody } from "../../src/lbc/body";
import { matchArtifact, parseArtifact } from "../../src/lbc/code-match";
import { computeEngagementsDigest } from "../../src/lbc/digest";
import { computeWeakEvidenceExposure } from "../../src/lbc/terms";
import type { ParsedTerms } from "../../src/lbc/terms";
import { LbcError } from "../../src/lbc/types";
import { decimalCeil, decimalFloor } from "../../src/lbc/validation";
import { VAULT, engagement, exampleState, h32, headerAt, makeState } from "./helpers/fake-chain";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

describe("engagementsDigest ordering is ascending by id (pinned independently)", () => {
  it("equals the JCS hash of the entries sorted ascending by id string, for 3 engagements in any input order", () => {
    const es = ["a", "b", "c"].map((l) => engagement(l));
    const ids = es.map((e) => e.id).sort();
    const expected = hashJcs(
      ids.map((id) => {
        const e = es.find((x) => x.id === id)!;
        return { id: e.id, payee: e.payee.toLowerCase(), cap: e.cap.toString(), start: e.start.toString(), end: e.end.toString(), termsHash: e.termsHash, active: e.active };
      }),
    );
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [1, 0, 2]]) expect(computeEngagementsDigest(order.map((i) => es[i]!))).toBe(expected);
  });
});

describe("computeBody integer range edges", () => {
  const ok = (over: object, header = headerAt(100n)) => computeBody(exampleState(), header, { vault: VAULT, chainId: 31337n, detectionLatencySeconds: 300, ...over });
  it("accepts a chain id of 1 and of 2^53-1, refuses 0 and 2^53", () => {
    expect(() => ok({ chainId: 1n })).not.toThrow();
    expect(() => ok({ chainId: MAX_SAFE })).not.toThrow();
    expect(() => ok({ chainId: 0n })).toThrow(LbcError);
    expect(() => ok({ chainId: MAX_SAFE + 1n })).toThrow(LbcError);
  });
  it("accepts a detection latency of 0 (alarmed = the bound at t = 0) and refuses a negative or fractional one", () => {
    expect(ok({ detectionLatencySeconds: 0 }).bounds.T3c.alarmed).toEqual({ seconds: 0, value: "0", assumes: ["A-MON"] });
    expect(() => ok({ detectionLatencySeconds: -1 })).toThrow(/INVALID_OPTION/);
    expect(() => ok({ detectionLatencySeconds: 1.5 })).toThrow(/INVALID_OPTION/);
  });
  it("a block timestamp of exactly 2^53-1 is representable, one more is refused (never rounded)", () => {
    const st = makeState({ engagements: [engagement("far", { end: MAX_SAFE + 10n })] });
    expect(() => computeBody(st, { ...headerAt(100n), timestamp: MAX_SAFE }, { vault: VAULT, chainId: 31337n, detectionLatencySeconds: 300 })).not.toThrow();
    expect(() => computeBody(st, { ...headerAt(100n), timestamp: MAX_SAFE + 1n }, { vault: VAULT, chainId: 31337n, detectionLatencySeconds: 300 })).toThrow(/VALUE_OUT_OF_RANGE/);
  });
});

describe("artifact immutable ranges", () => {
  const art = (len: number, start: number) => parseArtifact({ deployedBytecode: { object: `0x${"11".repeat(len)}`, immutableReferences: { "1": [{ start, length: len - start }] } } });
  it("a range ending exactly at the end of the code is valid; one byte beyond is ARTIFACT_INVALID", () => {
    expect(() => art(8, 4)).not.toThrow();
    expect(() => parseArtifact({ deployedBytecode: { object: `0x${"11".repeat(8)}`, immutableReferences: { "1": [{ start: 4, length: 5 }] } } })).toThrow(/ARTIFACT_INVALID/);
  });
  it("on-chain code shorter than a range is a mismatch, not a crash", () => {
    expect(matchArtifact("0x1111", art(8, 4)).status).toBe("MISMATCH");
    expect(matchArtifact("0x", art(8, 4)).status).toBe("MISMATCH");
  });
});

describe("decimal helpers", () => {
  it("zero numerator is fine; zero or negative denominator and negative numerator are refused", () => {
    expect(decimalCeil(0n, 5n)).toBe("0.0");
    expect(decimalFloor(0n, 5n)).toBe("0.0");
    for (const f of [decimalCeil, decimalFloor]) {
      expect(() => f(1n, 0n)).toThrow(LbcError);
      expect(() => f(1n, -1n)).toThrow(LbcError);
      expect(() => f(-1n, 1n)).toThrow(LbcError);
    }
  });
});

describe("weak-evidence report order", () => {
  it("lists engagements ascending by id regardless of input order", () => {
    const a = engagement("o1");
    const b = engagement("o2");
    const t = (e: typeof a): ParsedTerms => ({ engagementId: e.id, termsHash: e.termsHash, cap: e.cap, milestones: [] });
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    for (const order of [[lo, hi], [hi, lo]]) {
      const r = computeWeakEvidenceExposure(order, [t(a), t(b)]);
      expect(r.perEngagement.map((x) => x.engagementId)).toEqual([lo.id, hi.id]);
    }
    expect(h32("x")).toBeTruthy();
  });
});
