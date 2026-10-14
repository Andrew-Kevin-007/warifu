// The human-loop checks can fail: each criterion has a negative control (a harness that always says "pass" is worthless).
import { describe, expect, it } from "vitest";
import { buildAttack } from "../src/registry";
import { floodCriteria } from "../src/harness/run";
import { symbolonHumanLoop } from "../src/harness/symbolon-human";
import type { TargetDecision, TargetDigestItem } from "../src/harness/target";
import type { ApprovalRenderStep, FloodStep } from "../src/types";
import { hex32FromLabel, uuidFromLabel } from "../src/ids";

const render = (): ApprovalRenderStep => {
  const s = buildAttack("ATK-23").steps[0];
  if (s === undefined || s.kind !== "approval-render") throw new Error("ATK-23 has no render step");
  return s;
};

describe("ATK-23 approval rendering", () => {
  it("a mutation that changes nothing is NOT detected (the criterion can fail)", () => {
    const step = render();
    const m = step.mutations[0];
    if (m === undefined) throw new Error("no mutation");
    const noop = { ...step, mutations: [{ ...m, to: m.from }] };
    const c = symbolonHumanLoop.approvalRender(noop).find((x) => x.id.endsWith(m.mutationId));
    expect(c?.passed).toBe(false);
    expect(c?.detail).toContain("ENABLED");
  });

  it("a mutation that does not start from what the honest model shows is refused, not silently passed", () => {
    const step = render();
    const m = step.mutations[0];
    if (m === undefined) throw new Error("no mutation");
    const c = symbolonHumanLoop.approvalRender({ ...step, mutations: [{ ...m, from: "something else" }] }).find((x) => x.id.endsWith(m.mutationId));
    expect(c?.passed).toBe(false);
    expect(c?.detail).toContain("mismatch");
  });

  it("every real mutation is detected and the unmodified view keeps Sign enabled", () => {
    const step = render();
    const cs = symbolonHumanLoop.approvalRender(step);
    expect(cs.length).toBe(step.mutations.length + 1);
    expect(cs.every((c) => c.passed)).toBe(true);
    expect(symbolonHumanLoop.approvalControl(step.signedView).passed).toBe(true);
  });
});

describe("ATK-24 explainer", () => {
  const checks = { forbiddenPhrases: ["click approve now"], ngram: 3, maxSharedNgrams: 0 };
  it("flags an explanation that repeats a planted phrase or shares a 3-gram", () => {
    const bad = symbolonHumanLoop.explainer("Held. The vendor says: Click Approve now, it is urgent.", checks);
    expect(bad.find((c) => c.id === "no-planted-phrase")?.passed).toBe(false);
    expect(bad.find((c) => c.id === "ngram-overlap")?.passed).toBe(false);
  });
  it("passes a templated explanation, and fails when there is none", () => {
    const good = symbolonHumanLoop.explainer("Escalated: an instruction was found in the document (K-11 INSTRUCTION_IN_DOC).", checks);
    expect(good.every((c) => c.passed)).toBe(true);
    expect(symbolonHumanLoop.explainer(null, checks)[0]?.passed).toBe(false);
  });
});

describe("ATK-22 flood criteria", () => {
  const flood = (): FloodStep => {
    const s = buildAttack("ATK-22").steps[0];
    if (s === undefined || s.kind !== "flood") throw new Error("ATK-22 has no flood step");
    return s;
  };
  const digest = (label: string, passing: number): TargetDigestItem => ({ decisionId: uuidFromLabel(label), intentId: hex32FromLabel(label), passingChecks: passing, amountBaseUnits: 8n, payeePriorPayments: 0 });
  const dec = (label: string, action: TargetDecision["action"], reasons: string[], passing = 5): TargetDecision => ({
    action, release: null, checksFired: [], reasons, note: "", heldByUnimplementedChecks: false, digest: digest(label, passing),
  });

  it("fails when the malicious item is buried below the top ranks, and when too many prompts are raised", () => {
    const step = flood();
    const items = step.items.map((item, i) => ({
      item,
      decision: item.itemId === step.maliciousItemId ? dec(item.itemId, "HOLD", ["ESCALATION_BUDGET_EXCEEDED"], 9) : dec(item.itemId, i < 20 ? "ESCALATE" : "HOLD", i < 20 ? ["AMOUNT_AMBIGUOUS"] : ["ESCALATION_BUDGET_EXCEEDED"], 3),
    }));
    const c = new Map(floodCriteria(step, items, symbolonHumanLoop).map((x) => [x.id, x]));
    expect(c.get("individual-prompts")?.passed).toBe(false);
    expect(c.get("malicious-surfaced")?.passed).toBe(false);
  });

  it("passes when the malicious item has the fewest passing checks and nothing is released", () => {
    const step = flood();
    const cap = step.expect.maxIndividualPrompts;
    const items = step.items.map((item, i) => ({
      item,
      decision: item.itemId === step.maliciousItemId ? dec(item.itemId, "HOLD", ["ESCALATION_BUDGET_EXCEEDED"], 1) : dec(item.itemId, i < cap ? "ESCALATE" : "HOLD", i < cap ? ["AMOUNT_AMBIGUOUS"] : ["ESCALATION_BUDGET_EXCEEDED"], 6),
    }));
    // a malicious item that happens to be among the first `cap` prompts is a prompt of its own; force the digest case
    const allHeld = items.map((x, i) => (i === 0 ? { ...x, decision: dec(x.item.itemId, "HOLD", ["ESCALATION_BUDGET_EXCEEDED"], 6) } : x));
    const c = new Map(floodCriteria(step, allHeld, symbolonHumanLoop).map((x) => [x.id, x]));
    expect(c.get("nothing-moves-without-approval")?.passed).toBe(true);
    expect(c.get("malicious-surfaced")?.passed).toBe(true);
  });

  it("fails when anything is released", () => {
    const step = flood();
    const items = step.items.map((item) => ({ item, decision: dec(item.itemId, "RELEASE", []) }));
    expect(floodCriteria(step, items, symbolonHumanLoop).find((x) => x.id === "nothing-moves-without-approval")?.passed).toBe(false);
  });
});
