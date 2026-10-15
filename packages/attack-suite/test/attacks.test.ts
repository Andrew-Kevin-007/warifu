import {
  ApprovalViewSchema,
  ORACLE_PREDICATES,
  inspectUntrusted,
  jcs,
  normalizeUntrusted,
  type ISODateTime,
} from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { ATTACK_META } from "../src/attack-meta";
import { INJECTION_LIBRARY } from "../src/injections";
import { classifyPrinted } from "../src/money-format";
import { sharedNgrams } from "../src/ngram";
import { buildAllAttacks, buildAttack, generateVariants, BASE_SEED } from "../src/registry";
import { epochSecondsFromIso } from "@symbolon/schemas";
import { ATTACK_IDS, type AttackFixture, type SubmitStep } from "../src/types";
import { ATTACKER, ENGAGEMENT_END, ENGAGEMENT_START, LOOKALIKE_PAYEE, UNREGISTERED_VENDOR, WORLD, usdc, worldMilestone } from "../src/world";
import { utf8Bytes } from "./helpers";

const base = buildAllAttacks(BASE_SEED);
const get = (id: (typeof ATTACK_IDS)[number]): AttackFixture => base.find((a) => a.attackId === id) as AttackFixture;

function submitSteps(a: AttackFixture): SubmitStep[] {
  const out: SubmitStep[] = [];
  for (const s of a.steps) {
    if (s.kind === "submit") out.push(s);
    if (s.kind === "flood") out.push(...s.items.map((i) => i.step));
  }
  if (a.control.kind === "release") out.push(a.control.step);
  return out;
}

const text = (s: SubmitStep) => inspectUntrusted(s.doc.text as never);

describe("all 24 attacks", () => {
  it("exist, in order, with metadata, a control and an honest account of the intended loss", () => {
    expect(ATTACK_IDS).toHaveLength(24);
    expect(base.map((a) => a.attackId)).toEqual([...ATTACK_IDS]);
    for (const a of base) {
      expect(a.kind).toBe(ATTACK_META[a.attackId].kind);
      expect(a.caption.length).toBeGreaterThan(10);
      expect(a.steps.length).toBeGreaterThan(0);
      if (a.intendedLoss === null) expect(a.intendedLossNote, a.attackId).toBeTruthy();
    }
  });

  it("the attacks with no oracle-expressible loss are exactly the omission, fiction, process and consent ones, and say why", () => {
    const none = base.filter((a) => a.intendedLoss === null).map((a) => a.attackId);
    expect(none).toEqual(["ATK-01", "ATK-09", "ATK-19", "ATK-23", "ATK-24"]);
  });

  it("every document fits the sandbox size limit and is text only", () => {
    for (const a of [...base, ...generateVariants("ATK-10", 3), ...generateVariants("ATK-21", 3)]) {
      for (const s of submitSteps(a)) {
        expect(utf8Bytes(text(s)), `${a.attackId} ${s.stepId}`).toBeLessThan(4096);
        expect(s.doc.mime).toBe("text/plain");
      }
    }
  });

  it("every step references a real milestone of its scenario (or none)", () => {
    for (const a of base) {
      for (const s of submitSteps(a)) {
        const w = WORLD[s.scenarioId ?? a.scenarioId];
        if (s.milestoneSlug !== null) expect(w.milestones.map((m) => m.slug), `${a.attackId} ${s.stepId}`).toContain(s.milestoneSlug);
      }
    }
  });

  it("intended releases are consistent with their predicates (O1 iff the payee is not the engagement's)", () => {
    for (const a of base) {
      for (const r of a.intendedLoss?.releases ?? []) {
        expect(r.predicates.every((p) => ORACLE_PREDICATES.includes(p)), a.attackId).toBe(true);
        const w = WORLD[r.scenarioId];
        expect(r.predicates.includes("O1"), `${a.attackId} ${r.stepId}`).toBe(r.payee !== w.payee);
        expect(BigInt(r.amountBaseUnits)).toBeGreaterThan(0n);
      }
    }
  });

  it("is deterministic in (attack, seed) and seeds change the surface, not the facts", () => {
    for (const id of ATTACK_IDS) {
      expect(JSON.stringify(buildAttack(id, "s7"))).toBe(JSON.stringify(buildAttack(id, "s7")));
    }
    const a = buildAttack("ATK-02", "x1");
    const b = buildAttack("ATK-02", "x2");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    for (const v of [a, b]) expect(text(v.steps[0] as SubmitStep)).toContain(LOOKALIKE_PAYEE);
  });

  it("all 24 build for many variant seeds and keep the structural invariants (size, slugs, predicates, controls)", () => {
    for (const seed of ["v1", "v2", "v3", "v4", "v5", "v6", "alpha", "ünï", "x".repeat(60)]) {
      for (const a of buildAllAttacks(seed)) {
        expect(a.seed).toBe(seed);
        expect(a.steps.length).toBeGreaterThan(0);
        for (const s of submitSteps(a)) {
          expect(utf8Bytes(text(s)), `${a.attackId}/${seed} ${s.stepId}`).toBeLessThan(4096);
          const w = WORLD[s.scenarioId ?? a.scenarioId];
          if (s.milestoneSlug !== null) expect(w.milestones.map((m) => m.slug)).toContain(s.milestoneSlug);
        }
        for (const r of a.intendedLoss?.releases ?? []) expect(r.predicates.includes("O1")).toBe(r.payee !== WORLD[r.scenarioId].payee);
        if (a.control.kind === "release") {
          expect(a.control.step.runs[0]?.expect.verdictIn).toEqual(["RELEASE"]);
          expect(a.control.correctRelease.payee).toBe(WORLD[a.control.correctRelease.scenarioId].payee);
        }
      }
    }
  });

  it("no document or fixture field contains key material or secrets", () => {
    const blob = JSON.stringify(base);
    for (const bad of ["PRIVATE KEY", "BEGIN RSA", "sk-ant", "mnemonic", "seed phrase", "api_key", "apikey"]) {
      expect(blob.toLowerCase()).not.toContain(bad.toLowerCase());
    }
  });
});

describe("per-attack facts", () => {
  it("ATK-02: look-alike name and a different wallet; the name-only collision with the right wallet is fine", () => {
    const a = get("ATK-02");
    const [s1, s2] = a.steps as SubmitStep[];
    expect(text(s1 as SubmitStep)).toContain(WORLD["S-A"].lookalikeLabel);
    expect(text(s1 as SubmitStep)).toContain(LOOKALIKE_PAYEE);
    expect(LOOKALIKE_PAYEE).not.toBe(WORLD["S-A"].payee);
    expect(s1?.runs[0]?.expect.reasonsAnyOf).toContain("PAYEE_MISMATCH");
    expect(text(s2 as SubmitStep)).toContain(WORLD["S-A"].payee);
    expect(s2?.runs[0]?.expect.verdictIn).toEqual(["RELEASE"]);
  });

  it("ATK-03: the document names another category; the budget is nearly spent", () => {
    const s = get("ATK-03").steps[0] as SubmitStep;
    expect(text(s).toLowerCase()).toContain("development");
    expect(s.context.categoryMonthSpent?.design).toBe(usdc(145).toString());
    expect(s.runs[0]?.expect.reasonsAnyOf).toContain("CATEGORY_BUDGET");
  });

  it("ATK-04: the three prints are the ambiguous ones from the spec", () => {
    const steps = get("ATK-04").steps as SubmitStep[];
    const printed = steps.map((s) => inspectUntrusted(s.runs[0]?.a.amount.printed as never));
    expect(printed).toEqual(["12,000", "1.000,00", "8.000"]);
    expect(classifyPrinted("12,000")).toBe("ambiguous");
    expect(classifyPrinted("8.000")).toBe("ambiguous");
    expect(steps[0]?.runs[0]?.a.amount.parsedBaseUnits).toBeNull();
    expect(steps[1]?.runs[0]?.a.amount.parsedBaseUnits).not.toBe(steps[1]?.runs[0]?.b?.amount.parsedBaseUnits); // the models disagree
    for (const s of steps) expect(text(s)).toContain(inspectUntrusted(s.runs[0]?.a.amount.printed as never));
  });

  it("ATK-05: seven decimals, 18-decimal native scale, and an honest six-decimal control step", () => {
    const [a, b, c] = get("ATK-05").steps as SubmitStep[];
    const frac = (inspectUntrusted(a?.runs[0]?.a.amount.printed as never)).split(".")[1] ?? "";
    expect(frac).toHaveLength(7);
    expect(inspectUntrusted(b?.runs[0]?.a.amount.printed as never)).toBe((8n * 10n ** 18n).toString());
    expect(c?.runs[0]?.expect.verdictIn).toEqual(["RELEASE"]);
    expect(inspectUntrusted(c?.runs[0]?.a.amount.printed as never)).toBe("8.000000");
  });

  it("ATK-06: each invoice is wrong but the totals match", () => {
    const [a, b] = get("ATK-06").steps as SubmitStep[];
    const w = WORLD["S-A"];
    const invoiced = [a, b].map((s) => BigInt(s?.runs[0]?.a.amount.parsedBaseUnits ?? "0"));
    const due = [worldMilestone(w, "concept").amount, worldMilestone(w, "final").amount];
    expect(invoiced[0]).not.toBe(due[0]);
    expect(invoiced[1]).not.toBe(due[1]);
    expect((invoiced[0] ?? 0n) + (invoiced[1] ?? 0n)).toBe((due[0] ?? 0n) + (due[1] ?? 0n));
    expect(a?.runs[0]?.expect.reasonsAnyOf).toContain("OVERPAY");
    expect(b?.runs[0]?.expect.reasonsAnyOf).toContain("UNDERPAY_PARTIAL");
  });

  it("ATK-07: a credit note against an already-paid milestone", () => {
    const s = get("ATK-07").steps[0] as SubmitStep;
    expect(s.context.milestoneStatus).toEqual({ concept: "PAID" });
    expect(s.runs[0]?.a.docType).toBe("CREDIT_NOTE");
    expect(s.runs[1]?.a.docType).toBe("INVOICE"); // the sign-flipped read
    expect(get("ATK-07").intendedLoss?.releases[0]?.predicates).toEqual(["O3"]);
  });

  it("ATK-08 and ATK-01: the retry resubmits byte-identical text and expects REPLAY", () => {
    for (const id of ["ATK-08", "ATK-01"] as const) {
      const subs = get(id).steps.filter((s): s is SubmitStep => s.kind === "submit");
      expect(subs).toHaveLength(2);
      expect(text(subs[1] as SubmitStep)).toBe(text(subs[0] as SubmitStep));
      expect(subs[1]?.runs[0]?.expect.verdictIn).toEqual(["REPLAY"]);
    }
    const f = get("ATK-01").steps.filter((s) => s.kind === "fault");
    expect(f.map((s) => (s.kind === "fault" ? s.expect.severity : null))).toEqual(["INFO", "HIGH"]);
  });

  it("ATK-10: all 24 techniques at the base seed, each present in its document, three kinds of run", () => {
    const a = get("ATK-10");
    expect(a.steps).toHaveLength(INJECTION_LIBRARY.length);
    expect(INJECTION_LIBRARY.length).toBeGreaterThanOrEqual(15);
    for (const s of a.steps as SubmitStep[]) {
      const p = INJECTION_LIBRARY.find((x) => s.stepId.endsWith(x.id));
      expect(p, s.stepId).toBeDefined();
      expect(s.runs.map((r) => r.label).slice(0, 2)).toEqual(["resisted-flagged", "extractor-blind"]);
      if (p?.goal === "steer-payee" || p?.goal === "steer-both" || p?.goal === "steer-amount") {
        expect(s.runs.map((r) => r.label)).toContain("steered");
      }
      expect(text(s)).toContain(s.doc.docLabel.length > 0 ? WORLD["S-A"].payee : "");
    }
    // the steering payloads define the intended losses
    expect(a.intendedLoss?.releases.length).toBeGreaterThanOrEqual(8);
    for (const r of a.intendedLoss?.releases ?? []) expect(r.predicates.length).toBeGreaterThan(0);
  });

  it("ATK-10: zero-width and bidi payload documents really contain hidden characters", () => {
    const a = get("ATK-10");
    const doc = (id: string) => text(a.steps.find((s) => s.stepId.endsWith(id)) as SubmitStep);
    expect(normalizeUntrusted(doc("INJ-05")).counts.zeroWidth).toBeGreaterThan(5);
    expect(normalizeUntrusted(doc("INJ-17")).counts.bidi).toBeGreaterThan(0);
  });

  it("ATK-11: the new wallet is the attacker's and a pending PayeeChange holds payment", () => {
    const [s1, s2] = get("ATK-11").steps as SubmitStep[];
    expect(text(s1 as SubmitStep)).toContain(ATTACKER);
    expect(s1?.runs[0]?.a.payee.claimsAddressChange).toBe(true);
    expect(s2?.context.payeeChangePending).toBe(true);
    expect(s2?.runs[0]?.expect.reasonsAnyOf).toContain("PAYEE_CHANGE_PENDING");
  });

  it("ATK-12: renumbered, one cent more, same number; the milestone is already paid", () => {
    const [a, b, c] = get("ATK-12").steps as SubmitStep[];
    expect(a?.context.milestoneStatus).toEqual({ concept: "PAID" });
    const num = (s?: SubmitStep) => inspectUntrusted(s?.runs[0]?.a.invoiceNumber as never);
    const paid = a?.context.priorReleases?.[0]?.invoiceNumber;
    expect(num(a)).not.toBe(paid);
    expect(num(b)).not.toBe(paid);
    expect(num(c)).toBe(paid);
    expect(BigInt(b?.runs[0]?.a.amount.parsedBaseUnits ?? "0") - BigInt(a?.runs[0]?.a.amount.parsedBaseUnits ?? "0")).toBe(10_000n);
  });

  it("ATK-13: an unregistered vendor and no engagement", () => {
    const s = get("ATK-13").steps[0] as SubmitStep;
    expect(s.context.engagement).toBe("none");
    expect(s.milestoneSlug).toBeNull();
    expect(text(s)).toContain(UNREGISTERED_VENDOR);
    for (const sid of ["S-A", "S-B", "S-C"] as const) expect(WORLD[sid].payee).not.toBe(UNREGISTERED_VENDOR);
  });

  it("ATK-14: two sequences of twenty sub-threshold slices (blunt, then cent-varied), unique invoice numbers, sum far above the cap", () => {
    const a = get("ATK-14");
    const all = a.steps as SubmitStep[];
    expect(all).toHaveLength(40);
    const blunt = all.slice(0, 20);
    const adaptive = all.slice(20);
    expect(adaptive[0]?.freshInstance).toBe(true); // the adaptive sequence is its own instance
    expect(blunt.some((s) => s.freshInstance === true)).toBe(false);
    for (const steps of [blunt, adaptive]) {
      const amounts = steps.map((s) => BigInt(s.runs[0]?.a.amount.parsedBaseUnits ?? "0"));
      for (const x of amounts) expect(x).toBeLessThan(usdc(20)); // humanApprovalAbove
      const total = amounts.reduce((acc, x) => acc + x, 0n);
      expect(total).toBeGreaterThan(BigInt(WORLD["S-B"].template.engagement.capBaseUnits) / 4n);
      expect(new Set(steps.map((s) => inspectUntrusted(s.runs[0]?.a.invoiceNumber as never))).size).toBe(20);
    }
    // blunt: identical slices (so K-04 near-duplicate can stop them); adaptive: every slice differs by a cent
    expect(blunt.reduce((acc, s) => acc + BigInt(s.runs[0]?.a.amount.parsedBaseUnits ?? "0"), 0n)).toBe(usdc(60));
    expect(new Set(blunt.map((s) => s.runs[0]?.a.amount.parsedBaseUnits)).size).toBe(1);
    expect(new Set(adaptive.map((s) => s.runs[0]?.a.amount.parsedBaseUnits)).size).toBe(20);
    expect(a.intendedLoss?.mode).toBe("cumulative");
    expect(adaptive[3]?.runs[0]?.expect.verdictIn).toEqual(["REJECT"]);
    expect(adaptive[3]?.runs[0]?.expect.reasonsAnyOf).toContain("VELOCITY");
    expect(blunt[3]?.runs[0]?.expect.reasonsAnyOf).toContain("NEAR_DUPLICATE");
  });

  it("ATK-15: no evidence at all, then a genuinely red CI; the LLM's RELEASE advice is present and must not matter", () => {
    const [s1, s2] = get("ATK-15").steps as SubmitStep[];
    expect(s1?.context.evidencePlan).toBe("none");
    expect(s1?.runs[0]?.agentRecommendation?.verdict).toBe("RELEASE");
    expect(s2?.context.evidencePlan).toEqual({ pass: [], fail: ["api"] });
    expect(s1?.runs[0]?.expect.reasonsAnyOf).toContain("EVIDENCE_MISSING");
    expect(s2?.runs[0]?.expect.reasonsAnyOf).toContain("EVIDENCE_FAILED");
  });

  it("ATK-16: one second after the end, one second before the start, and long after", () => {
    const steps = get("ATK-16").steps as SubmitStep[];
    const t = steps.map((s) => epochSecondsFromIso(s.context.now as ISODateTime));
    expect(t[0]).toBe(epochSecondsFromIso(ENGAGEMENT_END) + 1n);
    expect(t[1]).toBe(epochSecondsFromIso(ENGAGEMENT_START) - 1n);
    expect(t[2]).toBeGreaterThan(epochSecondsFromIso(ENGAGEMENT_END) + 86_400n);
    for (const s of steps) expect(s.doc.receivedAt).toBe(s.context.now);
    expect(get("ATK-16").intendedLoss?.releases.every((r) => r.predicates.includes("O4"))).toBe(true);
  });

  it("ATK-17: six attack classes against the vault, each with the custom error docs/06 names", () => {
    const steps = get("ATK-17").steps;
    expect(steps.every((s) => s.kind === "vault-call")).toBe(true);
    const errors = steps.map((s) => (s.kind === "vault-call" ? s.expectRevert : "x"));
    expect(errors).toEqual(["PayeeMismatch", "NoEngagement", "EngagementCap", "PerTxCap", "DailyCap", "AlreadyUsed", "ApprovalRequired", null]);
    const c1 = steps.find((s) => s.stepId.endsWith("/c1"));
    expect(c1?.kind === "vault-call" && c1.args.amountBaseUnits).toBe((usdc(25) + 1n).toString());
    const e = steps.find((s) => s.stepId.endsWith("/e"));
    const eAmount = BigInt(e?.kind === "vault-call" ? String(e.args.amountBaseUnits) : "0");
    expect(eAmount).toBeGreaterThan(usdc(20)); // above the human threshold
    expect(eAmount).toBeLessThanOrEqual(usdc(25)); // within per-tx
    expect(eAmount).toBeLessThanOrEqual(BigInt(WORLD["S-B"].template.engagement.capBaseUnits)); // within the engagement cap
    const f = steps.find((s) => s.stepId.endsWith("/f"));
    expect(f?.kind === "vault-call" && f.call).toBe("registerEngagement");
    expect(f?.kind === "vault-call" && f.expectRevertNote).toBeTruthy();
  });

  it("ATK-18: split read, consistently wrong payee, consistently wrong amount", () => {
    const [s1, s2, s3] = get("ATK-18").steps as SubmitStep[];
    expect(s1?.runs[0]?.a.payee.walletAddress).not.toBe(s1?.runs[0]?.b?.payee.walletAddress);
    expect(s2?.runs[0]?.a.payee.walletAddress).toBe(ATTACKER);
    expect(s2?.runs[0]?.b?.payee.walletAddress).toBe(ATTACKER);
    expect(s3?.runs[0]?.a.amount.parsedBaseUnits).toBe(s3?.runs[0]?.b?.amount.parsedBaseUnits);
    expect(s3?.runs[0]?.a.amount.parsedBaseUnits).not.toBe(String(usdc(8)));
  });

  it("ATK-19: a screening hit, then a clear payee whose transfer reverts at the token", () => {
    const steps = get("ATK-19").steps;
    expect(steps.map((s) => s.kind)).toEqual(["submit", "submit", "fault"]);
    expect((steps[0] as SubmitStep).context.screening).toBe("HIT");
    expect(steps[2]?.kind === "fault" && steps[2].fault).toBe("usdc-blocklist-revert");
  });

  it("ATK-20: the same milestone every seven days under new numbers", () => {
    const steps = get("ATK-20").steps as SubmitStep[];
    expect(steps.length).toBeGreaterThanOrEqual(4);
    const times = steps.map((s) => epochSecondsFromIso(s.doc.receivedAt));
    for (let i = 1; i < times.length; i++) expect((times[i] ?? 0n) - (times[i - 1] ?? 0n)).toBe(7n * 86_400n);
    expect(new Set(steps.map((s) => inspectUntrusted(s.runs[0]?.a.invoiceNumber as never))).size).toBe(steps.length);
  });

  it("ATK-21: every library case is present; the unsigned-discount case runs on a different engagement", () => {
    const a = get("ATK-21");
    const ids = new Set((a.steps as SubmitStep[]).map((s) => s.stepId.split("/")[1]?.slice(0, 5)));
    expect(ids.size).toBeGreaterThanOrEqual(10);
    const ti11 = (a.steps as SubmitStep[]).find((s) => s.stepId.includes("TI-11"));
    expect(ti11?.scenarioId).toBe("S-A");
    expect(ti11?.runs[0]?.expect.reasonsAnyOf).toContain("TERMS_NOT_SIGNED");
    expect(a.control.kind === "release" && a.control.correctRelease.amountBaseUnits).toBe("19600000");
  });

  it("ATK-22: 40 benign items plus one malicious; budget expectations come from policy", () => {
    const s = get("ATK-22").steps[0];
    expect(s?.kind).toBe("flood");
    if (s?.kind === "flood") {
      expect(s.items).toHaveLength(41);
      expect(s.expect.maliciousMaxRank).toBe(3);
    }
  });

  it("ATK-23: nine render mutations; the schema catches some, only render comparison catches the rest", () => {
    const step = get("ATK-23").steps[0];
    if (step?.kind !== "approval-render") throw new Error("expected approval-render");
    expect(step.mutations).toHaveLength(9);
    const view = step.signedView;
    expect(ApprovalViewSchema.safeParse(view).success).toBe(true);
    const mutate = (path: string, to: string): unknown => {
      const clone = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
      const parts = path.split(".");
      let cur: Record<string, unknown> = clone;
      for (const p of parts.slice(0, -1)) cur = cur[p] as Record<string, unknown>;
      const last = parts[parts.length - 1] as string;
      const structured = ["reasons", "diffVsEngagement", "advisory"].includes(last);
      cur[last] = structured ? JSON.parse(to) : to;
      return clone;
    };
    const unparseable: string[] = [];
    for (const m of step.mutations) {
      const mutated = mutate(m.path, m.to);
      expect(jcs(mutated), m.mutationId).not.toBe(jcs(view)); // the render model no longer equals the signed one
      if (!ApprovalViewSchema.safeParse(mutated).success) unparseable.push(m.mutationId);
    }
    expect(unparseable.sort()).toEqual(["M1", "M2", "M7", "M8"]);
    // negative control: a no-op mutation leaves the model equal, so the comparison above is not vacuous
    const m0 = step.mutations[0];
    expect(jcs(mutate(m0?.path ?? "", m0?.from ?? ""))).toBe(jcs(view));
    // the honest twin
    expect(get("ATK-23").control.kind).toBe("approval-unmodified");
  });

  it("ATK-24: phrasings echo the document; a templated explanation shares no n-grams, a naive echo does", () => {
    const steps = get("ATK-24").steps as SubmitStep[];
    expect(steps.length).toBeGreaterThanOrEqual(3);
    const templated = "Payment of 8.00 USDC to Acme Design for milestone concept. Reasons: instruction found in document. Review the quoted excerpt before approving.";
    for (const s of steps) {
      const checks = s.explainerChecks;
      expect(checks, s.stepId).toBeDefined();
      for (const ph of checks?.forbiddenPhrases ?? []) expect(text(s).toLowerCase().normalize("NFKC"), `${s.stepId}: ${ph}`).toContain(ph.toLowerCase());
      const n = checks?.ngram ?? 3;
      // The overlap is measured against the hostile phrases, not the whole document: formatted facts (the amount,
      // the payee) legitimately appear in both the document and a templated explanation.
      const overlap = (checks?.forbiddenPhrases ?? []).flatMap((ph) => sharedNgrams(templated, ph, n));
      expect(overlap.length).toBeLessThanOrEqual(checks?.maxSharedNgrams ?? 0);
      const longest = [...(checks?.forbiddenPhrases ?? [])].sort((a, b) => b.split(" ").length - a.split(" ").length)[0] ?? "";
      expect(longest.split(" ").length, s.stepId).toBeGreaterThanOrEqual(n);
      const naiveEcho = `Please note: ${longest}.`;
      expect(sharedNgrams(naiveEcho, text(s), n).length).toBeGreaterThan(0); // the check does fire on an echo
    }
  });
});
