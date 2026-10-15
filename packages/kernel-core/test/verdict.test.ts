// Verdict algebra (docs/04 §1) and its fail-closed rules, plus the CheckResult builders.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { CheckResultSchema, inspectUntrusted } from "@symbolon/schemas";
import type { CheckId, CheckResult, OnFail } from "@symbolon/schemas";
import { EVALUATION_ORDER, SKIPPABLE_CHECKS, aggregate, severity, verdictForOnFail } from "../src/index";
import { combine, fail, issueCodes, kernelError, note, pass, replayResult } from "../src/verdict";

const IDS: CheckId[] = ["K-01", "K-02", "K-03"];
const allPass = (ids: readonly CheckId[] = IDS): CheckResult[] => ids.map((id) => pass(id, "ok"));

describe("severity", () => {
  it("REJECT > ESCALATE > HOLD > RELEASE", () => {
    expect([severity("RELEASE"), severity("HOLD"), severity("ESCALATE"), severity("REJECT")]).toEqual([0, 1, 2, 3]);
  });

  it("verdictForOnFail maps each onFail, and a corrupted value to HOLD (fail closed)", () => {
    expect(verdictForOnFail("REJECT")).toBe("REJECT");
    expect(verdictForOnFail("ESCALATE")).toBe("ESCALATE");
    expect(verdictForOnFail("HOLD")).toBe("HOLD");
    expect(verdictForOnFail("RELEASE" as unknown as OnFail)).toBe("HOLD");
  });
});

describe("aggregate", () => {
  it("all required checks PASS => RELEASE with no reasons", () => {
    expect(aggregate(allPass(), IDS)).toEqual({ verdict: "RELEASE", reasons: [] });
  });

  it("highest severity among FAILs wins; reasons in check order, de-duplicated", () => {
    const checks = [
      fail("K-01", "HOLD", "EVIDENCE_MISSING", "x"),
      fail("K-02", "REJECT", "OVERPAY", "x"),
      fail("K-03", "ESCALATE", "OVERPAY", "x"),
    ];
    expect(aggregate(checks, IDS)).toEqual({ verdict: "REJECT", reasons: ["EVIDENCE_MISSING", "OVERPAY"] });
  });

  it("a check result list that is missing, duplicating or adding a check never releases", () => {
    expect(aggregate(allPass(["K-01", "K-02"]), IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
    expect(aggregate(allPass(["K-01", "K-02", "K-02"]), IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
    expect(aggregate(allPass(["K-01", "K-02", "K-04"]), IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
    expect(aggregate([], [])).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
    expect(aggregate([], IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
  });

  it("completeness only matters for RELEASE (a REJECT stays a REJECT without KERNEL_ERROR noise)", () => {
    expect(aggregate([fail("K-01", "REJECT", "SCHEMA_INVALID", "x")], IDS)).toEqual({ verdict: "REJECT", reasons: ["SCHEMA_INVALID"] });
  });

  it("SKIP is legal only for a skippable check (K-13); any other SKIP is HOLD KERNEL_ERROR", () => {
    expect(SKIPPABLE_CHECKS.has("K-13")).toBe(true);
    const skip = (id: CheckId): CheckResult => ({ ...pass(id, "x"), status: "SKIP" });
    expect(aggregate([pass("K-01", "x"), skip("K-13")], ["K-01", "K-13"])).toEqual({ verdict: "RELEASE", reasons: [] });
    expect(aggregate([pass("K-01", "x"), skip("K-02")], ["K-01", "K-02"])).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
  });

  it("a FAIL without onFail or without a code counts as HOLD KERNEL_ERROR (never weaker than its onFail)", () => {
    expect(aggregate([replayResult("K-01", "x", []), pass("K-02", "x"), pass("K-03", "x")], IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
    const noCode: CheckResult = { ...fail("K-01", "REJECT", "OVERPAY", "x"), code: null };
    expect(aggregate([noCode, pass("K-02", "x"), pass("K-03", "x")], IDS)).toEqual({ verdict: "REJECT", reasons: ["KERNEL_ERROR"] });
  });

  it("a kernel fault behind a more severe finding of the same check still reaches the reasons (WP-05)", () => {
    const k14 = combine("K-14", [{ onFail: "ESCALATE", code: "TERMS_MISMATCH", detail: "t" }, { onFail: "HOLD", code: "KERNEL_ERROR", detail: "no schedule" }], "");
    expect(k14.code).toBe("TERMS_MISMATCH");
    expect(aggregate([pass("K-01", "x"), k14], ["K-01", "K-14"])).toEqual({ verdict: "ESCALATE", reasons: ["TERMS_MISMATCH", "KERNEL_ERROR"] });
    // positive control: the same check without the fault adds nothing
    const clean = combine("K-14", [{ onFail: "ESCALATE", code: "TERMS_MISMATCH", detail: "t" }, { onFail: "HOLD", code: "LIQUIDITY", detail: "l" }], "");
    expect(aggregate([pass("K-01", "x"), clean], ["K-01", "K-14"])).toEqual({ verdict: "ESCALATE", reasons: ["TERMS_MISMATCH"] });
  });

  it("a corrupted status is HOLD KERNEL_ERROR", () => {
    const bogus = { ...pass("K-01", "x"), status: "MAYBE" } as unknown as CheckResult;
    expect(aggregate([bogus, pass("K-02", "x"), pass("K-03", "x")], IDS)).toEqual({ verdict: "HOLD", reasons: ["KERNEL_ERROR"] });
  });

  it("property: adding any FAIL never improves the verdict (P-MONO at the algebra level)", () => {
    const onFail = fc.constantFrom<OnFail>("REJECT", "ESCALATE", "HOLD");
    const result = fc.oneof(
      fc.constant<"PASS">("PASS"),
      onFail,
    );
    fc.assert(
      fc.property(fc.array(result, { minLength: 15, maxLength: 15 }), fc.integer({ min: 0, max: 14 }), onFail, (statuses, at, extra) => {
        const checks = EVALUATION_ORDER.map((id, i) => {
          const s = statuses[i] as "PASS" | OnFail;
          return s === "PASS" ? pass(id, "x") : fail(id, s, "KERNEL_ERROR", "x");
        });
        const before = aggregate(checks, EVALUATION_ORDER);
        // "Adding a failing condition": check `at` becomes a FAIL at least as severe as whatever it was.
        const worse = checks.map((c, i) => {
          if (i !== at) return c;
          const current = c.onFail === null ? null : verdictForOnFail(c.onFail);
          const keep = current !== null && severity(current) > severity(verdictForOnFail(extra));
          return fail(c.id, keep && c.onFail !== null ? c.onFail : extra, "OVERPAY", "x");
        });
        const after = aggregate(worse, EVALUATION_ORDER);
        expect(severity(after.verdict)).toBeGreaterThanOrEqual(severity(before.verdict));
        expect(severity(after.verdict)).toBeGreaterThanOrEqual(severity(verdictForOnFail(extra)));
      }),
      { numRuns: 1000 },
    );
  });
});

describe("issueCodes (every finding of the failing checks, not only the check's own worst code)", () => {
  it("lists secondary issues that `reasons` omits, in check order, de-duplicated; PASS and SKIP add nothing", () => {
    const k06 = combine("K-06", [{ onFail: "ESCALATE", code: "ADDRESS_CHANGE_CLAIMED", detail: "claim" }, { onFail: "REJECT", code: "PAYEE_MISMATCH", detail: "wallet" }], "");
    const checks = [pass("K-01", "x"), k06, fail("K-03", "HOLD", "EVIDENCE_MISSING", "x"), fail("K-04", "HOLD", "ADDRESS_CHANGE_CLAIMED", "dup")];
    // the verdict algebra's `reasons` keeps one code per check (the worst), as documented in aggregate()
    expect(aggregate(checks, IDS).reasons).toEqual(["PAYEE_MISMATCH", "EVIDENCE_MISSING", "ADDRESS_CHANGE_CLAIMED"]);
    expect(issueCodes(checks)).toEqual(["ADDRESS_CHANGE_CLAIMED", "PAYEE_MISMATCH", "EVIDENCE_MISSING"]);
    expect(issueCodes([pass("K-01", "x"), { ...pass("K-13", "x"), status: "SKIP" as const, code: "SCREENING_DISABLED" }, note("K-14", "LATE", "flag")])).toEqual([]);
    expect(issueCodes([])).toEqual([]);
  });
});

describe("combine", () => {
  it("no issues => PASS with the pass detail and refs", () => {
    const r = combine("K-06", [], "fine", ["ref"]);
    expect(r).toMatchObject({ status: "PASS", onFail: null, code: null, refs: ["ref"] });
    expect(inspectUntrusted(r.detail)).toBe("fine");
  });

  it("the most severe issue wins; ties keep the first; every issue is listed; refs are concatenated", () => {
    const r = combine(
      "K-04",
      [
        { onFail: "ESCALATE", code: "DUPLICATE_DOC", detail: "d1", refs: ["a"] },
        { onFail: "REJECT", code: "MILESTONE_ALREADY_PAID", detail: "d2", refs: ["b"] },
        { onFail: "REJECT", code: "OVERPAY", detail: "d3" },
      ],
      "unused",
    );
    expect(r).toMatchObject({ status: "FAIL", onFail: "REJECT", code: "MILESTONE_ALREADY_PAID", refs: ["a", "b"] });
    expect(inspectUntrusted(r.detail)).toBe("DUPLICATE_DOC: d1 | MILESTONE_ALREADY_PAID: d2 | OVERPAY: d3");
  });

  it("a single issue keeps its own detail", () => {
    expect(inspectUntrusted(combine("K-06", [{ onFail: "HOLD", code: "PAYEE_CHANGE_PENDING", detail: "only" }], "x").detail)).toBe("only");
  });

  it("at equal severity KERNEL_ERROR takes the code whatever its position; a more severe issue still wins; two faults are both listed", () => {
    const held = { onFail: "HOLD", code: "ESCALATION_BUDGET_EXCEEDED", detail: "b" } as const;
    const fault = { onFail: "HOLD", code: "KERNEL_ERROR", detail: "k" } as const;
    expect(combine("K-12", [held, fault], "").code).toBe("KERNEL_ERROR");
    expect(combine("K-12", [fault, held], "").code).toBe("KERNEL_ERROR");
    expect(combine("K-12", [{ onFail: "ESCALATE", code: "HUMAN_REQUIRED", detail: "h" }, fault], "")).toMatchObject({ onFail: "ESCALATE", code: "HUMAN_REQUIRED" });
    expect(inspectUntrusted(combine("K-12", [fault, { ...fault, detail: "second" }], "").detail)).toBe("KERNEL_ERROR: k | KERNEL_ERROR: second");
  });
});

describe("builders produce schema-valid, bounded CheckResults", () => {
  it("names come from CHECK_NAMES; detail and refs are bounded", () => {
    const long = "é".repeat(2500);
    const r = fail("K-08", "REJECT", "OVERPAY", long, Array.from({ length: 40 }, (_, i) => `r${i}${"x".repeat(300)}`));
    expect(r.name).toBe("AMOUNT_CONFORMANCE");
    expect(Array.from(inspectUntrusted(r.detail))).toHaveLength(2000);
    expect(inspectUntrusted(r.detail).endsWith("…")).toBe(true);
    expect(r.refs).toHaveLength(32);
    expect(r.refs.every((x) => Array.from(x).length <= 256)).toBe(true);
    expect(CheckResultSchema.safeParse(r).success).toBe(true);
    // astral characters are never split into lone surrogates
    const astral = kernelError("K-01", "😀".repeat(2100));
    expect(CheckResultSchema.safeParse(astral).success).toBe(true);
    expect(kernelError("K-02", "x")).toMatchObject({ status: "FAIL", onFail: "HOLD", code: "KERNEL_ERROR" });
  });
});
