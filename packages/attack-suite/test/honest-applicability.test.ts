import { epochSecondsFromIso, inspectUntrusted, normalizeUntrusted } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { ApplicabilityFileSchema, buildApplicability } from "../src/applicability";
import { BENIGN_CONTROL_IDS, DISCOUNT_HONEST_IDS, buildHonest } from "../src/honest";
import { referenceAmountDue } from "../src/terms-ref";
import { ATTACK_IDS, TARGET_IDS, TEMPLATE_STYLES, type AttackId, type TargetId } from "../src/types";
import { WORLD, worldMilestone } from "../src/world";
import { k11Reading } from "./helpers";

const honest = buildHonest();

describe("honest fixtures named by the v2 spec", () => {
  it("are 6 benign controls and 6 discount-honest invoices, uniquely identified", () => {
    expect(BENIGN_CONTROL_IDS).toHaveLength(6);
    expect(DISCOUNT_HONEST_IDS).toHaveLength(6);
    expect(honest).toHaveLength(12);
    expect(new Set(honest.map((h) => h.id)).size).toBe(12);
    expect(honest.filter((h) => h.group === "benign-control")).toHaveLength(6);
    expect(honest.filter((h) => h.group === "discount-honest")).toHaveLength(6);
  });

  it("every one must pay: RELEASE expected, correct payee, amount equals the reference amountDue at the release time", () => {
    for (const h of honest) {
      const w = WORLD[h.scenarioId];
      expect(h.oracleExpected).toBe("NO_LOSS");
      expect(h.correctRelease.payee).toBe(w.payee);
      for (const run of h.step.runs) expect(run.expect.verdictIn).toEqual(["RELEASE"]);
      const slug = h.step.milestoneSlug as string;
      const due = referenceAmountDue(worldMilestone(w, slug).amount, w.paymentTerms, h.step.doc.receivedAt, h.correctRelease.time);
      expect(h.correctRelease.amountBaseUnits).toBe(due.toString());
      expect(h.step.runs[0]?.expect.amountDueBaseUnits).toBe(due.toString());
    }
  });

  it("discount-honest: stated terms EQUAL the signed terms and the payment falls inside the window at the discounted amount", () => {
    for (const h of honest.filter((x) => x.group === "discount-honest")) {
      const w = WORLD["S-C"];
      const stated = h.step.runs[0]?.a.statedTerms;
      expect(stated?.netDays).toBe(w.paymentTerms.netDays);
      expect(stated?.earlyPay).toEqual(w.paymentTerms.earlyPay);
      expect(stated?.ambiguous).toBe(false);
      const waited = epochSecondsFromIso(h.correctRelease.time) - epochSecondsFromIso(h.step.doc.receivedAt);
      expect(waited).toBeLessThanOrEqual(10n * 86_400n);
      expect(h.correctRelease.amountBaseUnits).toBe("19600000");
    }
  });

  it("the late benign control pays the full amount because the window has closed", () => {
    const late = honest.find((h) => h.id === "BC-6");
    expect(late?.correctRelease.amountBaseUnits).toBe("20000000");
  });

  it("the deploy control comes after the API milestone was paid (sequential engagement)", () => {
    const d = honest.find((h) => h.id === "BC-4");
    expect(d?.step.context.milestoneStatus).toEqual({ api: "PAID" });
  });

  it("documents are clean: no hidden characters, nothing a K-11 reading would flag, many template styles", () => {
    const styles = new Set<string>();
    for (const h of honest) {
      const text = inspectUntrusted(h.step.doc.text as never);
      expect(normalizeUntrusted(text).removedCount, h.id).toBe(0);
      const k = k11Reading(text, WORLD[h.scenarioId].payee);
      expect(k.patternHit || k.structureHit || k.foreignAddressHit, h.id).toBe(false);
      styles.add(h.step.doc.origin);
    }
    expect(styles.size).toBeGreaterThanOrEqual(6);
    for (const s of styles) expect(TEMPLATE_STYLES as readonly string[]).toContain(s);
  });
});

describe("applicability.json (started by WP-22)", () => {
  const file = buildApplicability();
  const row = (a: AttackId, t: TargetId) => file.rows.find((r) => r.attackId === a && r.target === t);

  it("has one row per attack x target, each with a reason, and validates", () => {
    expect(ApplicabilityFileSchema.safeParse(file).success).toBe(true);
    expect(file.rows).toHaveLength(ATTACK_IDS.length * TARGET_IDS.length);
    expect(new Set(file.rows.map((r) => `${r.attackId}/${r.target}`)).size).toBe(file.rows.length);
    for (const r of file.rows) expect(r.reason.length, `${r.attackId}/${r.target}`).toBeGreaterThan(10);
  });

  it("Symbolon is applicable to every attack", () => {
    for (const a of ATTACK_IDS) expect(row(a, "symbolon")?.applicable, a).toBe(true);
  });

  it("the N/A rows fixed by docs/07 §3.1 are N/A for b0, b1 and b2, each with its reason", () => {
    for (const a of ["ATK-17", "ATK-22", "ATK-23", "ATK-24"] as const) {
      for (const t of ["b0", "b1", "b2"] as const) {
        expect(row(a, t)?.applicable, `${a}/${t}`).toBe(false);
      }
    }
    expect(row("ATK-17", "b1")?.reason).toMatch(/signer/);
    expect(row("ATK-23", "b1")?.reason).toMatch(/approval/);
  });

  it("B1 is applicable to at least 12 attacks (the G4 headline needs it to lose on >= 12 applicable)", () => {
    const n = file.rows.filter((r) => r.target === "b1" && r.applicable === true).length;
    expect(n).toBeGreaterThanOrEqual(12);
    expect(n).toBe(20);
  });

  it("WP-36 decided every b0 and b2 row: N/A only where docs/07 §3.1 says so, everything else applicable with a reason", () => {
    const notApplicable = new Set(["ATK-17", "ATK-22", "ATK-23", "ATK-24"]);
    for (const t of ["b0", "b2"] as const) {
      const rows = file.rows.filter((r) => r.target === t);
      expect(rows).toHaveLength(24);
      expect(rows.filter((r) => r.applicable === null)).toHaveLength(0);
      for (const r of rows) {
        expect(r.applicable, `${r.attackId} x ${t}`).toBe(!notApplicable.has(r.attackId));
        expect(r.reason.length).toBeGreaterThan(20);
      }
    }
  });
});
