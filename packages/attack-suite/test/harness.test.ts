// Harness tests (WP-23): state semantics, the B1 baseline, the Symbolon unit target, scoring by the oracle,
// the matrix invariants and the report. Real components throughout: the real kernel-core pipeline, the real
// oracle and the committed fixture generators; only the model is absent (reference reads).
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildApplicability } from "../src/applicability";
import { b1Target, REFERENCE_VALIDATOR_RULES, referenceValidator } from "../src/harness/b1";
import { buildMatrix } from "../src/harness/matrix";
import type { AttackMatrix } from "../src/harness/matrix";
import { agreement, intendedToOracleRelease } from "../src/harness/oracle-agreement";
import { renderMarkdown } from "../src/harness/report";
import { lossMoney, matchExpectation, runAttack } from "../src/harness/run";
import { applyPatch, cloneState, freshState, recordRelease, remainingFunding, FUNDING_BASE_UNITS, toOracleInstance } from "../src/harness/state";
import { makeSymbolonUnitTarget, toDecision } from "../src/harness/symbolon-unit";
import { buildAllAttacks, buildAttack } from "../src/registry";
import { usdc, WORLD } from "../src/world";
import type { AttackFixture, ExtractionRun } from "../src/types";
import { ATTACK_IDS } from "../src/types";
import { judgeRelease } from "@symbolon/oracle";

const matrix: AttackMatrix = buildMatrix({ gitSha: null });
const rows = buildApplicability().rows;
const rowFor = (id: string, target: string) => {
  const r = rows.find((x) => x.attackId === id && x.target === target);
  if (r === undefined) throw new Error(`no applicability row ${id} ${target}`);
  return r;
};
const result = (id: string, target: string) => {
  const r = matrix.attacks.find((x) => x.attackId === id && x.target === target);
  if (r === undefined) throw new Error(`no result ${id} ${target}`);
  return r;
};
const totals = (target: string) => {
  const t = matrix.totals.find((x) => x.target === target);
  if (t === undefined) throw new Error(`no totals ${target}`);
  return t;
};

describe("scenario-instance state", () => {
  it("a patch's clock is step-local; releases, statuses and evidence persist", () => {
    const s = freshState("S-A");
    const v1 = applyPatch(s, { now: "2027-01-01T00:00:00Z", milestoneStatus: { concept: "PAID" }, evidencePlan: "none", breakerHalted: true });
    expect(v1.now).toBe("2027-01-01T00:00:00Z");
    const v2 = applyPatch(s, {});
    expect(v2.now).toBe(s.baseNow);
    expect(s.milestoneStatus.get("concept")).toBe("PAID");
    expect(s.evidencePlan).toBe("none");
    expect(s.breakerHalted).toBe(true);
    expect(applyPatch(s, { engagement: "none" }).noEngagement).toBe(true);
    expect(applyPatch(s, {}).noEngagement).toBe(false);
  });

  it("prior releases enter the oracle instance, and the clone is independent", () => {
    const s = freshState("S-A");
    applyPatch(s, { priorReleases: [{ milestoneSlug: "concept", invoiceNumber: "INV-1", amountBaseUnits: usdc(8).toString(), payee: WORLD["S-A"].payee, at: "2026-11-01T09:00:00Z" }], milestoneStatus: { concept: "PAID" } });
    const c = cloneState(s);
    recordRelease(c, { ...fakeRelease(), stepId: "x", runLabel: "x", milestoneSlug: "final", invoiceNumber: null });
    expect(s.releases).toHaveLength(1);
    expect(c.releases).toHaveLength(2);
    const inst = toOracleInstance(s);
    expect(inst.releases).toHaveLength(1);
    expect(inst.milestonePaid).toHaveLength(1);
  });

  it("funding is finite and reduced by every release", () => {
    const s = freshState("S-A");
    expect(remainingFunding(s)).toBe(FUNDING_BASE_UNITS);
    recordRelease(s, { ...fakeRelease(), stepId: "x", runLabel: "x", milestoneSlug: "concept", invoiceNumber: null });
    expect(remainingFunding(s)).toBe(FUNDING_BASE_UNITS - usdc(8));
  });
});

function fakeRelease() {
  const w = WORLD["S-A"];
  const m = w.template.milestones[1];
  if (m === undefined) throw new Error("no milestone");
  return {
    milestoneId: m.milestoneId,
    payee: w.payee,
    amount: usdc(8),
    time: "2026-11-02T09:00:00Z",
    invoiceReceivedAt: "2026-11-02T09:00:00Z",
    termsBasis: "none" as const,
    clockAnchor: null,
    ownerApproved: false,
  };
}

describe("B1 reference validator", () => {
  const baseRun = (): ExtractionRun => {
    const f = buildAttack("ATK-02");
    const step = f.steps[0];
    if (step === undefined || step.kind !== "submit") throw new Error("shape");
    const run = step.runs[0];
    if (run === undefined) throw new Error("shape");
    return structuredClone(run);
  };

  it("passes an ordinary invoice with HIGH confidence", () => {
    expect(referenceValidator(baseRun().a)).toEqual({ valid: true, confidence: "HIGH", rule: null });
  });
  it("V1 non-invoice, V2 no amount, V3 no payee, V4 injection anomaly, V5 ambiguous separator", () => {
    const a = baseRun().a;
    expect(referenceValidator({ ...a, docType: "CREDIT_NOTE" })).toMatchObject({ valid: false, rule: "V1" });
    expect(referenceValidator({ ...a, amount: { ...a.amount, parsedBaseUnits: null } })).toMatchObject({ valid: false, rule: "V2" });
    expect(referenceValidator({ ...a, payee: { ...a.payee, walletAddress: null, legalName: null } })).toMatchObject({ valid: false, rule: "V3" });
    expect(referenceValidator({ ...a, anomalies: [{ code: "INSTRUCTION_IN_DOC", quote: "x" as never }] })).toMatchObject({ valid: true, confidence: "LOW", rule: "V4" });
    expect(referenceValidator({ ...a, anomalies: [{ code: "HIDDEN_CHARS", quote: "x" as never }] })).toMatchObject({ confidence: "LOW", rule: "V4" });
    expect(referenceValidator({ ...a, amount: { ...a.amount, decimalSeparatorGuess: "ambiguous" } })).toMatchObject({ confidence: "LOW", rule: "V5" });
    expect(REFERENCE_VALIDATOR_RULES).toHaveLength(5);
  });
  it("does not flag an address-change claim (a pattern validator does not look for it)", () => {
    const a = baseRun().a;
    expect(referenceValidator({ ...a, payee: { ...a.payee, claimsAddressChange: true } }).confidence).toBe("HIGH");
  });
});

describe("B1 on the fixtures (oracle-scored)", () => {
  it("pays the lookalike wallet of ATK-02 and the oracle calls it O1", () => {
    const r = result("ATK-02", "b1");
    expect(r.outcome).toBe("LOSS");
    expect(r.oracle?.predicates).toContain("O1");
    expect(BigInt(r.lossBaseUnits)).toBeGreaterThan(0n);
  });

  it("declines the credit note read faithfully but pays the sign-flipped read (ATK-07)", () => {
    const step = result("ATK-07", "b1").steps[0];
    expect(step?.runs.map((x) => [x.label, x.action])).toEqual([["careful", "REJECT"], ["sign-flipped", "RELEASE"]]);
  });

  it("blocks some injections (the validator is not a strawman): ATK-10 has declined runs and paid runs", () => {
    const actions = result("ATK-10", "b1").steps.flatMap((s) => s.runs.map((r) => r.action));
    expect(actions).toContain("REJECT");
    expect(actions).toContain("RELEASE");
  });

  it("retries pay twice: ATK-08 is an O3 duplicate", () => {
    expect(result("ATK-08", "b1").oracle?.predicates).toContain("O3");
  });

  it("does not look at the clock: ATK-16 releases out of the engagement window (O4)", () => {
    expect(result("ATK-16", "b1").oracle?.predicates).toContain("O4");
  });

  it("releases without evidence (ATK-15, O6) and past category and velocity limits (ATK-03/14, O5)", () => {
    expect(result("ATK-15", "b1").oracle?.predicates).toContain("O6");
    expect(result("ATK-03", "b1").oracle?.predicates).toContain("O5");
    expect(result("ATK-14", "b1").oracle?.predicates).toContain("O5");
  });

  it("an escrow cannot pay more than it holds: ATK-05's absurd scale cannot exceed the funding", () => {
    expect(BigInt(result("ATK-05", "b1").lossBaseUnits)).toBeLessThanOrEqual(FUNDING_BASE_UNITS * BigInt(result("ATK-05", "b1").trials));
    const huge = result("ATK-05", "b1").steps.flatMap((s) => s.runs).filter((r) => r.release !== null && BigInt(r.release.amountBaseUnits) > FUNDING_BASE_UNITS);
    expect(huge).toEqual([]);
  });

  it("signal-scored attacks record their signals (ATK-09 has no money movement at all)", () => {
    const r = result("ATK-09", "b1");
    expect(r.scoring).toBe("signal");
    expect(r.notes.filter((n) => n.startsWith("signal:")).length).toBeGreaterThan(0);
    expect(r.oracle?.releases).toBe(0);
  });

  it("is N/A on ATK-17 and ATK-22..24 with the applicability reason, and nothing is run", () => {
    for (const id of ["ATK-17", "ATK-22", "ATK-23", "ATK-24"]) {
      const r = result(id, "b1");
      expect(r.outcome).toBe("N/A");
      expect(r.notes).toEqual([rowFor(id, "b1").reason]);
      expect(r.steps).toEqual([]);
    }
  });
});

describe("Symbolon unit target (real kernel-core pipeline)", () => {
  it("has no release path in this build: K-09..K-14 and K-16 are reported as unimplemented, K-01..K-08 are not", () => {
    const t = matrix.targets.find((x) => x.id === "symbolon");
    expect(t?.unimplementedChecks).toEqual(["K-09", "K-10", "K-11", "K-12", "K-13", "K-14", "K-16"]);
    expect(t?.releasePathAvailable).toBe(false);
  });

  it("never releases: no run of any attack or honest fixture ends in RELEASE", () => {
    const actions = matrix.attacks.filter((a) => a.target === "symbolon").flatMap((a) => a.steps.flatMap((s) => s.runs.map((r) => r.action)));
    expect(actions.length).toBeGreaterThan(100);
    expect(actions).not.toContain("RELEASE");
    expect(matrix.honest.find((h) => h.target === "symbolon")?.released).toBe(0);
  });

  it("really runs the implemented checks: a lookalike payee is REJECTed by K-06, an unknown vendor by K-05", () => {
    const k06 = result("ATK-02", "symbolon").steps[0]?.runs[0];
    expect(k06?.action).toBe("REJECT");
    expect(k06?.checksFired).toContain("K-06");
    expect(k06?.reasons).toContain("PAYEE_MISMATCH");
    const k05 = result("ATK-13", "symbolon").steps[0]?.runs[0];
    expect(k05?.reasons).toContain("NO_ENGAGEMENT");
    expect(result("ATK-16", "symbolon").steps.every((s) => s.runs.every((r) => r.reasons.includes("OUT_OF_WINDOW")))).toBe(true);
  });

  it("flags a HOLD that exists only because later checks are missing, and does not flag a real REJECT", () => {
    expect(result("ATK-03", "symbolon").steps[0]?.runs[0]?.heldByUnimplementedChecks).toBe(true);
    expect(result("ATK-02", "symbolon").steps[0]?.runs[0]?.heldByUnimplementedChecks).toBe(false);
  });

  it("reports the steps it cannot run, with reasons, instead of calling them blocked", () => {
    for (const id of ["ATK-09", "ATK-17", "ATK-23"]) expect(result(id, "symbolon").outcome).toBe("NOT_RUN");
    expect(result("ATK-17", "symbolon").steps.every((s) => s.status === "NOT_RUN" && s.reason.length > 20)).toBe(true);
    expect(result("ATK-22", "symbolon").complete).toBe(false);
    expect(result("ATK-24", "symbolon").complete).toBe(false);
    expect(result("ATK-01", "symbolon").notes.join(" ")).toContain("NOT_RUN");
  });

  it("the Evaluation -> decision adapter maps a RELEASE with signed terms (adapter test with a synthetic evaluation)", () => {
    const w = WORLD["S-A"];
    const m = w.template.milestones[0];
    if (m === undefined) throw new Error("no milestone");
    const ctx = { invoiceReceivedAt: "2026-11-02T09:00:00Z", ownerApproval: null } as never;
    const e = {
      verdict: "RELEASE", checks: [], reasons: [], payee: w.payee, milestoneId: m.milestoneId, releaseAmountBaseUnits: usdc(8).toString(),
      payAt: "2026-11-02T09:00:00Z", invoiceReceivedAt: "2026-11-02T09:00:00Z",
    } as never;
    const d = toDecision(e, ctx);
    expect(d.action).toBe("RELEASE");
    expect(d.release).toMatchObject({ payee: w.payee, amount: usdc(8), termsBasis: "signed", clockAnchor: "2026-11-02T09:00:00Z", ownerApproved: false });
    expect(() => toDecision({ ...(e as object), releaseAmountBaseUnits: null } as never, ctx)).toThrow(/without/);
  });

  it("is deterministic: two runs give identical results", () => {
    const a = runAttack(buildAttack("ATK-04"), makeSymbolonUnitTarget(), rowFor("ATK-04", "symbolon"));
    const b = runAttack(buildAttack("ATK-04"), makeSymbolonUnitTarget(), rowFor("ATK-04", "symbolon"));
    expect(a).toEqual(b);
  });
});

describe("expectation matching", () => {
  const d = (over: Partial<Parameters<typeof matchExpectation>[1]> = {}): Parameters<typeof matchExpectation>[1] => ({
    action: "REJECT", release: null, checksFired: ["K-06"], reasons: ["PAYEE_MISMATCH"], note: "", heldByUnimplementedChecks: false, ...over,
  });
  it("MATCH when every listed condition holds", () => {
    expect(matchExpectation({ verdictIn: ["REJECT"], reasonsAnyOf: ["PAYEE_MISMATCH"], checksAnyOf: ["K-06"] }, d(), [])).toEqual({ expectation: "MATCH", note: "" });
  });
  it("MISMATCH when an implemented check disagrees", () => {
    expect(matchExpectation({ verdictIn: ["ESCALATE"] }, d(), []).expectation).toBe("MISMATCH");
    expect(matchExpectation({ verdictIn: ["REJECT"], reasonsAllOf: ["OVERPAY"] }, d(), []).expectation).toBe("MISMATCH");
  });
  it("INCONCLUSIVE when the unmet part belongs to a check the build lacks", () => {
    const held = d({ action: "HOLD", checksFired: ["K-12"], reasons: ["KERNEL_ERROR"], heldByUnimplementedChecks: true });
    expect(matchExpectation({ verdictIn: ["ESCALATE"], reasonsAnyOf: ["CATEGORY_BUDGET"], checksAnyOf: ["K-12"] }, held, ["K-12"]).expectation).toBe("INCONCLUSIVE");
  });
  it("a real mismatch is not hidden by a pending one in the same expectation", () => {
    const held = d({ action: "REJECT", checksFired: ["K-06"], reasons: ["PAYEE_MISMATCH"] });
    expect(matchExpectation({ verdictIn: ["ESCALATE"], reasonsAnyOf: ["CATEGORY_BUDGET"] }, held, ["K-12"]).expectation).toBe("MISMATCH");
  });
});

describe("loss accounting", () => {
  const w = WORLD["S-A"];
  const base = () => ({ ...fakeRelease(), milestoneId: w.template.milestones[0]?.milestoneId ?? null });
  it("wrong recipient and duplicates count in full; overpay counts the excess; a rule break with the right amount counts zero", () => {
    const s = freshState("S-A");
    const wrong = { ...base(), payee: "0x47689bfD0AeDF57e4f8E08b959F40E609d5f5b97" as const };
    expect(lossMoney(s, wrong, judgeRelease(toOracleInstance(s), wrong))).toBe(usdc(8));
    const over = { ...base(), amount: usdc(10) };
    expect(lossMoney(s, over, judgeRelease(toOracleInstance(s), over))).toBe(usdc(2));
    const late = { ...base(), time: "2027-02-01T00:00:00Z" };
    const v = judgeRelease(toOracleInstance(s), late);
    expect(v.predicates).toContain("O4");
    expect(lossMoney(s, late, v)).toBe(0n);
    const ok = base();
    expect(lossMoney(s, ok, judgeRelease(toOracleInstance(s), ok))).toBe(0n);
  });
});

describe("matrix invariants", () => {
  it("has a result for every attack on every target that ran, 24 each", () => {
    for (const target of ["symbolon", "b1"]) {
      expect(matrix.attacks.filter((a) => a.target === target).map((a) => a.attackId)).toEqual([...ATTACK_IDS]);
    }
  });

  it("N/A appears exactly where applicability.json says applicable=false, with its reason", () => {
    for (const a of matrix.attacks) {
      const row = rowFor(a.attackId, a.target);
      expect(a.outcome === "N/A").toBe(row.applicable !== true);
      if (a.outcome === "N/A") expect(a.notes).toEqual([row.reason]);
    }
  });

  it("B1 loses on at least 12 applicable attacks (G4) and reports x of y", () => {
    const b1 = totals("b1");
    expect(b1.oracleScored.loss + b1.signalScored.loss).toBeGreaterThanOrEqual(12);
    expect(b1.applicable).toBe(b1.oracleScored.applicable + b1.signalScored.applicable);
    expect(b1.notApplicable).toBe(4);
  });

  it("Symbolon's loss count is 0 on every oracle-judged release, and the report refuses to read that as evidence", () => {
    const s = totals("symbolon");
    expect(s.lossTrials).toBe(0);
    expect(s.lossBaseUnits).toBe("0");
    expect(s.lossRate?.upper95Method).toBe("rule-of-three");
    expect(s.lossRate?.upper95).toBeCloseTo(3 / s.trials, 12);
    const md = renderMarkdown(matrix);
    expect(md).toContain("Release path available in this build: **no**");
    expect(md).toContain("not evidence about the missing checks");
  });

  it("NOT_RUN is never counted as blocked, held or escalated", () => {
    const s = totals("symbolon");
    const byOutcome = (o: string) => matrix.attacks.filter((a) => a.target === "symbolon" && a.outcome === o).length;
    expect(s.oracleScored.notRun + s.signalScored.notRun).toBe(byOutcome("NOT_RUN"));
    expect(s.oracleScored.blocked + s.signalScored.blocked).toBe(byOutcome("BLOCKED"));
    expect(s.oracleScored.applicable).toBe(s.oracleScored.loss + s.oracleScored.blocked + s.oracleScored.escalated + s.oracleScored.held + s.oracleScored.noop + s.oracleScored.notRun);
  });

  it("trial counts equal the extraction runs recorded in the steps", () => {
    for (const a of matrix.attacks) expect(a.trials).toBe(a.steps.reduce((n, s) => n + s.runs.length, 0));
  });

  it("every B1 control passes except where B1's lack of terms logic overpays the discount (ATK-21)", () => {
    const b1 = matrix.attacks.filter((a) => a.target === "b1" && a.outcome !== "N/A");
    expect(b1.filter((a) => a.control.status !== "PASS").map((a) => a.attackId)).toEqual(["ATK-21"]);
  });

  it("Symbolon's controls are all over-blocked in this build, and say why", () => {
    const sym = matrix.attacks.filter((a) => a.target === "symbolon" && a.control.status === "OVERBLOCKED");
    expect(sym.length).toBe(23);
    expect(sym.every((a) => a.control.detail.includes("not implemented"))).toBe(true);
  });

  it("the honest corpus: B1 overpays discounts it does not model; Symbolon holds all 12 only because checks are missing", () => {
    const b1 = matrix.honest.find((h) => h.target === "b1");
    const sym = matrix.honest.find((h) => h.target === "symbolon");
    expect(b1?.n).toBe(12);
    expect(b1?.releasedLoss).toBeGreaterThan(0);
    expect(sym?.held).toBe(12);
    expect(sym?.heldByUnimplementedChecks).toBe(12);
    expect(sym?.rejected).toBe(0);
  });

  it("is deterministic and carries the provenance fields", () => {
    expect(buildMatrix({ gitSha: null })).toEqual(matrix);
    expect(matrix.provenance.models).toContain("no model was called");
    expect(matrix.provenance.recordedOutputs).toBe(false);
    expect(matrix.provenance.fixtureManifestSha256).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("the report is derived from the matrix: changing a computed number changes the text", () => {
    const md = renderMarkdown(matrix);
    const bumped: AttackMatrix = { ...matrix, totals: matrix.totals.map((t) => (t.target === "b1" ? { ...t, oracleScored: { ...t.oracleScored, loss: 987 } } : t)) };
    expect(renderMarkdown(bumped)).not.toBe(md);
    expect(renderMarkdown(bumped)).toContain("987");
    expect(md).not.toContain("987 of");
  });

  it("the report passes the repo claims lint (no overclaiming words)", async () => {
    const lintPath = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "claims-lint.mjs")).href;
    const mod = (await import(/* @vite-ignore */ lintPath)) as { lintText: (t: string) => unknown[] };
    expect(mod.lintText(renderMarkdown(matrix))).toEqual([]);
    expect(mod.lintText("this is unbreakable and proven")).toHaveLength(2); // the lint can fail
  });
});

describe("oracle/fixture agreement", () => {
  const fixtures = buildAllAttacks();

  it("the oracle reports every predicate each fixture lists, for every intended release (0 disagreements)", () => {
    const all = fixtures.flatMap((f) => agreement(f));
    expect(all.length).toBeGreaterThanOrEqual(19);
    expect(all.filter((r) => r.missing.length > 0)).toEqual([]);
    expect(matrix.agreement.disagreements).toBe(0);
  });

  it("negative control: a fixture that claims a predicate the oracle does not see is a disagreement", () => {
    const f = buildAttack("ATK-02");
    const planted: AttackFixture = {
      ...f,
      intendedLoss: f.intendedLoss === null ? null : { ...f.intendedLoss, releases: f.intendedLoss.releases.map((r) => ({ ...r, predicates: [...r.predicates, "O4" as const] })) },
    };
    const rowsOut = agreement(planted);
    expect(rowsOut.some((r) => r.missing.includes("O4"))).toBe(true);
  });

  it("an intended release of an ATK-21 attack carries invoice-stated terms (O8); other attacks do not", () => {
    const f = buildAttack("ATK-21");
    const spec = f.intendedLoss?.releases[0];
    if (spec === undefined) throw new Error("no release");
    expect(intendedToOracleRelease("ATK-21", spec, null).termsBasis).toBe("invoice-stated");
    expect(intendedToOracleRelease("ATK-02", spec, null).termsBasis).toBe("signed");
  });
});

describe("B1 target contract", () => {
  it("is labelled as ours and SIMULATED, and refuses step kinds it has no counterpart for", () => {
    expect(b1Target.provenance).toContain("ours");
    expect(b1Target.provenance).toContain("SIMULATED");
    const f = buildAttack("ATK-17");
    const step = f.steps[0];
    if (step === undefined) throw new Error("no step");
    expect(b1Target.cannotRun(step)).toContain("N/A");
  });
});
