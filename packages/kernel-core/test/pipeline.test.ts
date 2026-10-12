// Pipeline, fail-closed guard (docs/04 §1: a required check that throws => HOLD KERNEL_ERROR), evaluate()'s
// last-resort path, contextHash and summarizeEvaluation.
import { describe, expect, it } from "vitest";
import type { LoadedPolicy } from "@symbolon/policy";
import { inspectUntrusted } from "@symbolon/schemas";
import {
  EVALUATION_ORDER,
  KERNEL_PIPELINE,
  KERNEL_VERSION,
  UNKNOWN_INTENT_ID,
  contextHash,
  evaluate,
  summarizeEvaluation,
  toJsonSafe,
} from "../src/index";
import type { KernelContext } from "../src/index";
import { runPipeline } from "../src/pipeline";
import type { PipelineConfig } from "../src/pipeline";
import { PHASE_A, PHASE_A_IDS, context, engagement, expectCheck, intent, phaseA, policy, summary } from "./helpers";

const boom = (): never => {
  throw new Error("injected failure with a secret-looking message sk-test-123");
};

describe("fail-closed guard", () => {
  it.each(PHASE_A.stages.map((s) => s.id))("a throwing %s becomes HOLD KERNEL_ERROR; every other check still runs; never RELEASE", (id) => {
    const config: PipelineConfig = { ...PHASE_A, stages: PHASE_A.stages.map((s) => (s.id === id ? { id, run: boom } : s)) };
    const e = runPipeline(config, intent(), context(), policy());
    expectCheck(e, id, "HOLD", "KERNEL_ERROR");
    expect(e.checks.map((c) => c.id)).toEqual(PHASE_A_IDS);
    expect(e.verdict).toBe("HOLD");
    expect(e.reasons).toEqual(["KERNEL_ERROR"]);
    expect(inspectUntrusted(e.checks.find((c) => c.id === id)?.detail ?? (undefined as never))).not.toContain("sk-test");
  });

  it("a throwing check with another failure keeps the higher severity and still lists KERNEL_ERROR", () => {
    const i = intent();
    i.extraction.a.payee.walletAddress = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    const config: PipelineConfig = { ...PHASE_A, stages: PHASE_A.stages.map((s) => (s.id === "K-07" ? { id: "K-07", run: boom } : s)) };
    const e = runPipeline(config, i, context(), policy());
    expect(e.verdict).toBe("REJECT");
    expect(e.reasons).toEqual(["PAYEE_MISMATCH", "KERNEL_ERROR"]);
  });

  it("a throwing pre-check (K-16 slot) becomes HOLD KERNEL_ERROR", () => {
    const config: PipelineConfig = { pre: [{ id: "K-16", run: boom }], stages: PHASE_A.stages, required: ["K-16", ...PHASE_A_IDS] };
    const e = runPipeline(config, intent(), context(), policy());
    expectCheck(e, "K-16", "HOLD", "KERNEL_ERROR");
    expect(e.verdict).toBe("HOLD");
  });

  it("a K-01 that throws stops the pipeline with HOLD KERNEL_ERROR (no intent to evaluate)", () => {
    const p = policy();
    const throwingPolicy = {
      policyHash: p.policyHash,
      decimals: p.decimals,
      amounts: p.amounts,
      get policy(): never {
        return boom();
      },
    } as LoadedPolicy;
    const e = runPipeline(PHASE_A, intent(), context(), throwingPolicy);
    expect(e.checks.map((c) => [c.id, c.code])).toEqual([["K-01", "KERNEL_ERROR"]]);
    expect(e.verdict).toBe("HOLD");
  });

  it("a real context fault (unparseable prior createdAt) is caught by the guard", () => {
    const e = phaseA(intent(), context({ priorDecisions: [summary({ createdAt: "yesterday", payee: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", amountBaseUnits: 1_000_000_000n })] }));
    expectCheck(e, "K-04", "HOLD", "KERNEL_ERROR");
    expect(e.verdict).toBe("HOLD");
  });

  it("if the facts cannot be derived, every later check is KERNEL_ERROR", () => {
    const broken = { ...engagement(), milestones: null } as unknown as ReturnType<typeof engagement>;
    const e = phaseA(intent(), { ...context(), engagement: broken, milestone: null });
    expectCheck(e, "K-01", null, null);
    for (const id of PHASE_A_IDS.slice(1)) expectCheck(e, id, "HOLD", "KERNEL_ERROR");
    expect(e.intentIdBound).toBe(false);
  });
});

describe("evaluate()", () => {
  it("runs the frozen kernel pipeline over every required check", () => {
    expect(Object.isFrozen(KERNEL_PIPELINE)).toBe(true);
    expect(KERNEL_PIPELINE.required).toEqual(EVALUATION_ORDER);
    expect([...KERNEL_PIPELINE.pre.map((p) => p.id), "K-01", ...KERNEL_PIPELINE.stages.map((s) => s.id)]).toEqual(EVALUATION_ORDER);
  });

  it("K-01 SCHEMA_INVALID short-circuits after the pre-check", () => {
    const e = evaluate({ nonsense: true }, context(), policy());
    expect(e.checks.map((c) => c.id)).toEqual(["K-16", "K-01"]);
    expect(e.verdict).toBe("REJECT");
    expect(e.reasons).toEqual(["SCHEMA_INVALID"]); // the K-16 pre-check passes (breaker OK)
  });

  it("never throws: a context that is not an object yields HOLD KERNEL_ERROR on every required check", () => {
    const e = evaluate(intent(), null as unknown as KernelContext, policy());
    expect(e.verdict).toBe("HOLD");
    expect(e.checks.map((c) => [c.id, c.code])).toEqual(EVALUATION_ORDER.map((id) => [id, "KERNEL_ERROR"]));
    expect(e.intentId).toBe(UNKNOWN_INTENT_ID);
    expect(e.policyHash).toBe(policy().policyHash);
    expect(e.kernelVersion).toBe(KERNEL_VERSION);
  });

  it("the last-resort path also survives a broken policy object", () => {
    expect(evaluate(intent(), null as unknown as KernelContext, null as unknown as LoadedPolicy).policyHash).toBeNull();
    expect(evaluate(intent(), null as unknown as KernelContext, { policyHash: 7 } as unknown as LoadedPolicy).policyHash).toBeNull();
  });

  it("reports the context hash, policy hash and kernel version", () => {
    const ctx = context();
    const e = evaluate(intent(), ctx, policy());
    const h = contextHash(ctx);
    expect(h.ok && e.contextHash === h.value).toBe(true);
    expect(e.policyHash).toBe(policy().policyHash);
    expect(e.invoiceReceivedAt).toBe(ctx.invoiceReceivedAt);
  });
});

describe("contextHash / toJsonSafe", () => {
  it("bigints become decimal strings, recursively", () => {
    expect(toJsonSafe({ a: 1n, b: [2n, { c: 3n }], d: "x", e: null, f: true, g: 1.5 })).toEqual({ a: "1", b: ["2", { c: "3" }], d: "x", e: null, f: true, g: 1.5 });
  });

  it("is deterministic and changes with any context field", () => {
    const a = contextHash(context());
    const b = contextHash(context());
    const c = contextHash(context({ payeeChangePending: true }));
    expect(a).toEqual(b);
    expect(a.ok && c.ok && a.value !== c.value).toBe(true);
  });

  it("a context that is not JSON fails closed (no hash), and evaluate reports null", () => {
    const weird = { ...context(), extra: () => 1 } as unknown as KernelContext;
    expect(contextHash(weird)).toEqual({ ok: false, error: { code: "CONTEXT_INVALID", message: "context is not canonicalizable (JCS)" } });
    expect(phaseA(intent(), weird).contextHash).toBeNull();
  });
});

describe("summarizeEvaluation", () => {
  const meta = { decisionId: "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9", createdAt: "2026-10-05T12:00:01Z" };

  it("builds the DecisionSummary the service stores", () => {
    const e = phaseA(intent());
    const s = summarizeEvaluation(e, meta);
    expect(s).toEqual({
      ok: true,
      value: {
        decisionId: meta.decisionId,
        intentId: e.intentId,
        verdict: "RELEASE",
        docHash: e.docHash,
        engagementId: e.engagementId,
        milestoneId: e.milestoneId,
        payee: e.payee,
        normInvoiceNo: "INV0042",
        amountBaseUnits: 1_000_000_000n,
        releaseAmountBaseUnits: 1_000_000_000n, // the scheduled plan's amountDue (no signed terms: the gross)
        createdAt: meta.createdAt,
      },
    });
  });

  it("carries the release amount when there is one", () => {
    const id = phaseA(intent()).intentId;
    const e = phaseA(intent(), context({ reevaluation: { decisionId: meta.decisionId, intentId: id, payAt: "2026-10-05T12:00:00Z", releaseAmountBaseUnits: 1_000_000_000n } }));
    const s = summarizeEvaluation(e, meta);
    expect(s.ok && s.value.releaseAmountBaseUnits).toBe(1_000_000_000n);
  });

  it("refuses a REPLAY (not a new decision), an evaluation without a document hash, and one without amounts stays null", () => {
    const replay = phaseA(intent(), context({ priorDecisions: [summary({ intentId: phaseA(intent()).intentId })] }));
    expect(summarizeEvaluation(replay, meta).ok).toBe(false);
    const failed = evaluate(intent(), null as unknown as KernelContext, policy());
    expect(summarizeEvaluation(failed, meta).ok).toBe(false);
    const rejected = summarizeEvaluation(phaseA({ junk: 1 }), meta);
    expect(rejected.ok && rejected.value.amountBaseUnits).toBeNull();
  });
});
