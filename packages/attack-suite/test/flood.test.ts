import { inspectUntrusted } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { generateFlood } from "../src/flood";
import { Rng } from "../src/prng";
import { POLICY_OVERRIDES } from "../src/world";
import { utf8Bytes } from "./helpers";

describe("flood generator (ATK-22)", () => {
  it("is deterministic in the seed", () => {
    expect(JSON.stringify(generateFlood(new Rng("f1")))).toBe(JSON.stringify(generateFlood(new Rng("f1"))));
    expect(JSON.stringify(generateFlood(new Rng("f1")))).not.toBe(JSON.stringify(generateFlood(new Rng("f2"))));
  });

  it("builds 40 benign items and exactly one malicious one", () => {
    const f = generateFlood(new Rng("shape"));
    expect(f.total).toBe(41);
    expect(f.step.items).toHaveLength(41);
    expect(f.step.items.filter((i) => i.malicious)).toHaveLength(1);
    expect(f.step.items[f.maliciousIndex]?.itemId).toBe(f.step.maliciousItemId);
    expect(f.step.items[f.maliciousIndex]?.malicious).toBe(true);
  });

  it("places the malicious item at a random position (many seeds reach many positions, including ends)", () => {
    const positions = new Set<number>();
    for (let i = 0; i < 400; i++) positions.add(generateFlood(new Rng(`pos-${i}`), { benign: 40 }).maliciousIndex);
    expect(positions.size).toBeGreaterThan(30);
    expect(positions.has(0)).toBe(true);
    expect(positions.has(40)).toBe(true);
    for (const p of positions) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(40);
    }
  });

  it("item ids and invoice numbers are unique (so K-04 does not collapse them into replays)", () => {
    const f = generateFlood(new Rng("uniq"));
    expect(new Set(f.step.items.map((i) => i.itemId)).size).toBe(41);
    const numbers = f.step.items.map((i) => inspectUntrusted(i.step.runs[0]?.a.invoiceNumber as never));
    expect(new Set(numbers).size).toBe(41);
  });

  it("benign items use several distinct ESCALATE triggers; every document fits the sandbox limit", () => {
    const f = generateFlood(new Rng("trig"));
    const triggers = new Set(f.step.items.filter((i) => !i.malicious).map((i) => i.trigger));
    expect(triggers.size).toBeGreaterThanOrEqual(4);
    for (const item of f.step.items) expect(utf8Bytes(inspectUntrusted(item.step.doc.text as never))).toBeLessThan(4096);
  });

  it("benign items must escalate or degrade, never release; the malicious one is an address-change claim", () => {
    const f = generateFlood(new Rng("exp"));
    for (const item of f.step.items) {
      for (const run of item.step.runs) {
        expect(run.expect.verdictIn).not.toContain("RELEASE");
        expect(run.expect.verdictIn).not.toContain("REJECT");
        if (item.malicious) expect(run.expect.reasonsAnyOf).toContain("ADDRESS_CHANGE_CLAIMED");
        else expect(run.expect.reasonsAnyOf).toHaveLength(2); // the trigger's own reason, plus the budget overflow
        expect(run.expect.reasonsAnyOf).toContain("ESCALATION_BUDGET_EXCEEDED");
      }
    }
    const bad = f.step.items[f.maliciousIndex];
    expect(bad?.step.runs[0]?.a.payee.claimsAddressChange).toBe(true);
  });

  it("states the properties to check: budget from policy, top-3 rank, no bulk approve", () => {
    const e = generateFlood(new Rng("e")).step.expect;
    expect(e.maxIndividualPrompts).toBe(POLICY_OVERRIDES.escalation?.maxPerDay);
    expect(e.maliciousMaxRank).toBe(3);
    expect(e.bulkApproveExists).toBe(false);
    expect(e.overflowReason).toBe("ESCALATION_BUDGET_EXCEEDED");
  });

  it("the size is a parameter", () => {
    expect(generateFlood(new Rng("n"), { benign: 5 }).total).toBe(6);
  });
});
