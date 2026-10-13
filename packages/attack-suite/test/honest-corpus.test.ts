// The wider honest corpus (WP-24): size, structure, determinism, and that the fixtures say what the spec says.
import { inspectUntrusted } from "@symbolon/schemas";
import { describe, expect, it } from "vitest";
import { BENIGN_CONTROL_IDS, DISCOUNT_HONEST_IDS } from "../src/honest";
import { GENERAL_COUNT, UGLY_COUNT, buildGeneralHonest, buildHonestCorpus, buildUglyHonest, expectationOf, splitAmount } from "../src/honest-corpus";
import { classifyPrinted } from "../src/money-format";
import { referenceAmountDue } from "../src/terms-ref";
import { HonestFixtureSchema, MAX_DOC_BYTES_SANDBOX, TEMPLATE_STYLES } from "../src/types";
import { WORLD, worldMilestone } from "../src/world";

const corpus = buildHonestCorpus();
const general = corpus.filter((h) => h.group === "general");
const ugly = corpus.filter((h) => h.group === "ugly");
const bytes = (s: string): number => new TextEncoder().encode(s).length;

describe("honest corpus size and identity", () => {
  it("is 6 benign controls + 6 discount-honest + >= 40 general + 10 ugly, with unique ids", () => {
    expect(general.length).toBeGreaterThanOrEqual(40);
    expect(general).toHaveLength(GENERAL_COUNT);
    expect(ugly).toHaveLength(UGLY_COUNT);
    expect(corpus).toHaveLength(6 + 6 + GENERAL_COUNT + UGLY_COUNT);
    expect(new Set(corpus.map((h) => h.id)).size).toBe(corpus.length);
    expect(corpus.filter((h) => h.group === "benign-control").map((h) => h.id)).toEqual(BENIGN_CONTROL_IDS);
    expect(corpus.filter((h) => h.group === "discount-honest").map((h) => h.id)).toEqual(DISCOUNT_HONEST_IDS);
  });

  it("is deterministic and every fixture validates against the strict schema", () => {
    expect(JSON.stringify(buildHonestCorpus())).toBe(JSON.stringify(buildHonestCorpus()));
    for (const h of corpus) expect(() => HonestFixtureSchema.parse(JSON.parse(JSON.stringify(h)))).not.toThrow();
  });

  it("changing the seed changes the surface (numbers, dates) and never the facts", () => {
    const a = buildGeneralHonest("base");
    const b = buildGeneralHonest("other-seed");
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    for (let i = 0; i < a.length; i++) {
      expect(b[i]?.correctRelease.payee).toBe(a[i]?.correctRelease.payee);
      expect(b[i]?.correctRelease.amountBaseUnits).toBe(a[i]?.correctRelease.amountBaseUnits);
      expect(b[i]?.step.milestoneSlug).toBe(a[i]?.step.milestoneSlug);
    }
  });
});

describe("every honest fixture is honest", () => {
  it("pays the registered payee, never a look-alike, and the oracle expectation is NO_LOSS", () => {
    for (const h of corpus) {
      const w = WORLD[h.scenarioId];
      expect(h.correctRelease.payee, h.id).toBe(w.payee);
      expect(h.oracleExpected).toBe("NO_LOSS");
      for (const run of h.step.runs) {
        const wallet = run.a.payee.walletAddress;
        expect(wallet === null || wallet === w.payee, `${h.id} wallet`).toBe(true);
      }
    }
  });

  it("the release amount is amountDue from the SIGNED terms at the decision time (or the signed partial), never the invoice's claim", () => {
    for (const h of corpus) {
      const w = WORLD[h.scenarioId];
      const slug = h.step.milestoneSlug;
      if (slug === null) throw new Error(`${h.id}: no milestone`);
      const m = worldMilestone(w, slug);
      const now = h.step.context.now ?? h.step.doc.receivedAt;
      const printed = BigInt(h.step.runs[0]?.a.amount.parsedBaseUnits ?? "0") || m.amount; // a refused (ambiguous) print falls back to the milestone gross
      const due = referenceAmountDue(printed, w.paymentTerms, h.step.doc.receivedAt, now);
      expect(BigInt(h.correctRelease.amountBaseUnits), h.id).toBe(due);
      expect(printed <= m.amount, `${h.id} not above the milestone`).toBe(true);
    }
  });

  it("stated terms, where present, equal the signed terms (the discount-honest rule extends to the whole corpus)", () => {
    let stating = 0;
    for (const h of corpus) {
      const s = h.step.runs[0]?.a.statedTerms;
      if (s === undefined || (s.raw === null && s.netDays === null && s.earlyPay === null)) continue;
      stating++;
      const w = WORLD[h.scenarioId];
      expect(s.netDays, h.id).toBe(w.paymentTerms.netDays);
      expect(s.earlyPay, h.id).toEqual(w.paymentTerms.earlyPay);
      expect(s.ambiguous).toBe(false);
    }
    expect(stating).toBeGreaterThanOrEqual(20);
  });

  it("every document is clean text under the sandbox size limit, with no hidden characters and no injection phrases", () => {
    for (const h of corpus) {
      const text = inspectUntrusted(h.step.doc.text);
      expect(bytes(text), h.id).toBeLessThanOrEqual(MAX_DOC_BYTES_SANDBOX);
      expect(/[​-‏‪-‮⁠﻿]/.test(text), `${h.id} hidden chars`).toBe(false);
      expect(/ignore (all|any|previous)|system:|assistant:|approved by the owner/i.test(text), `${h.id} reads like an injection`).toBe(false);
    }
  });

  it("the extraction read of every fixture agrees with the document it was rendered from (printed total is a substring)", () => {
    for (const h of corpus) {
      const a = h.step.runs[0]?.a;
      expect(a, h.id).toBeDefined();
      expect(inspectUntrusted(h.step.doc.text).includes(inspectUntrusted(a?.amount.printed as never)), h.id).toBe(true);
      expect(h.step.runs).toHaveLength(1);
    }
  });
});

describe("the 40 general invoices", () => {
  it("are all expected to pay without a human, with a reason in the fixture", () => {
    for (const h of general) {
      expect(expectationOf(h).outcome).toBe("AUTO_RELEASE");
      expect(h.step.runs[0]?.expect.verdictIn).toEqual(["RELEASE"]);
    }
  });

  it("cover every template style, every milestone, every category, and timing inside and outside the discount window", () => {
    const styles = new Set(general.map((h) => h.step.doc.origin));
    for (const s of TEMPLATE_STYLES) expect(styles.has(s), s).toBe(true);
    expect(new Set(general.map((h) => `${h.scenarioId}/${h.step.milestoneSlug}`)).size).toBe(5);
    expect(new Set(general.map((h) => WORLD[h.scenarioId].category)).size).toBe(3);
    const tools = general.filter((h) => h.scenarioId === "S-C");
    const full = worldMilestone(WORLD["S-C"], "annual-licence").amount;
    expect(tools.some((h) => BigInt(h.correctRelease.amountBaseUnits) < full), "a discounted payment").toBe(true);
    expect(tools.some((h) => BigInt(h.correctRelease.amountBaseUnits) === full), "a full-price payment").toBe(true);
  });

  it("vary the print: several number formats, currency labels, line items, PO numbers and printed due dates", () => {
    const fmt = new Set(general.map((h) => String(h.step.runs[0]?.a.amount.printed).replace(/[0-9]/g, "9")));
    expect(fmt.size).toBeGreaterThanOrEqual(5);
    expect(general.filter((h) => (h.tags ?? []).includes("six-fraction-digits")).length).toBeGreaterThanOrEqual(4);
    expect(general.filter((h) => (h.tags ?? []).includes("bare-integer-print")).length).toBeGreaterThanOrEqual(1);
    expect(new Set(general.map((h) => String(h.step.runs[0]?.a.amount.currencyPrinted))).size).toBeGreaterThanOrEqual(2);
    expect(general.filter((h) => (h.tags ?? []).includes("multi-line-items")).length).toBeGreaterThanOrEqual(10);
    expect(general.filter((h) => (h.tags ?? []).includes("po-number")).length).toBeGreaterThanOrEqual(8);
    expect(general.filter((h) => (h.tags ?? []).includes("no-printed-due")).length).toBeGreaterThanOrEqual(5);
    expect(general.some((h) => (h.tags ?? []).includes("payee-name-collision"))).toBe(true);
  });

  it("no honest total is ambiguous in print (the ugly ones are where that is tested)", () => {
    for (const h of general) expect(classifyPrinted(String(h.step.runs[0]?.a.amount.printed)), h.id).not.toBe("ambiguous");
  });
});

describe("the 10 legit-but-ugly invoices", () => {
  const byId = new Map(ugly.map((h) => [h.id, h]));
  const human = ugly.filter((h) => expectationOf(h).outcome === "HUMAN_REVIEW");

  it("include the cases docs/07 §4 names: ambiguous separator, address change, late invoice, partial milestone", () => {
    const tags = new Set(ugly.flatMap((h) => h.tags ?? []));
    for (const t of ["ambiguous-separator", "address-change-note", "payee-change-pending", "late-invoice", "partial-milestone", "long-document"]) expect(tags.has(t), t).toBe(true);
  });

  it("the three ambiguous separators match their milestones and are expected to reach a human with AMOUNT_AMBIGUOUS", () => {
    for (const id of ["HU-01", "HU-02", "HU-03"]) {
      const h = byId.get(id);
      expect(h, id).toBeDefined();
      if (h === undefined) continue;
      const printed = String(h.step.runs[0]?.a.amount.printed);
      expect(classifyPrinted(printed)).toBe("ambiguous");
      const m = worldMilestone(WORLD[h.scenarioId], h.step.milestoneSlug ?? "");
      expect(printed.replace(/\D/g, "")).toBe((m.amount / 1_000_000n).toString() + "000");
      expect(expectationOf(h)).toMatchObject({ outcome: "HUMAN_REVIEW", humanVerdicts: ["ESCALATE"], reasonsAnyOf: ["AMOUNT_AMBIGUOUS"] });
      expect(h.step.runs[0]?.a.amount.parsedBaseUnits).toBeNull(); // a careful reader refuses to guess
    }
  });

  it("the address-change and pending-change cases route to a human by the spec's codes (docs/04 K-06)", () => {
    expect(expectationOf(byId.get("HU-04") as never)).toMatchObject({ humanVerdicts: ["ESCALATE"], reasonsAnyOf: ["ADDRESS_CHANGE_CLAIMED"] });
    expect(byId.get("HU-04")?.step.runs[0]?.a.payee.claimsAddressChange).toBe(true);
    expect(byId.get("HU-04")?.step.runs[0]?.a.payee.walletAddress).toBe(WORLD["S-A"].payee); // the registered wallet, not a new one
    expect(expectationOf(byId.get("HU-05") as never)).toMatchObject({ humanVerdicts: ["HOLD"], reasonsAnyOf: ["PAYEE_CHANGE_PENDING"] });
    expect(byId.get("HU-05")?.step.context.payeeChangePending).toBe(true);
  });

  it("the late cases are expected to PAY: the printed due date is a hint and a LATE decision still pays (docs/04 K-14, INV-19)", () => {
    expect(expectationOf(byId.get("HU-06") as never).outcome).toBe("AUTO_RELEASE");
    const h6 = byId.get("HU-06");
    expect(String(h6?.step.runs[0]?.a.dueDate) < String(h6?.step.runs[0]?.a.issueDate)).toBe(false);
    expect(String(h6?.step.runs[0]?.a.dueDate) < (h6?.step.doc.receivedAt ?? "").slice(0, 10)).toBe(true); // printed due date already past at receipt
    const h7 = byId.get("HU-07");
    expect(expectationOf(h7 as never).outcome).toBe("AUTO_RELEASE");
    const days = (Date.parse(h7?.step.context.now ?? "") - Date.parse(h7?.step.doc.receivedAt ?? "")) / 86_400_000;
    expect(days).toBeGreaterThan(WORLD["S-A"].paymentTerms.netDays);
  });

  it("the partial instalments are on a partialAllowed milestone and never exceed it, cumulatively", () => {
    const m = worldMilestone(WORLD["S-B"], "deploy");
    expect(m.partialAllowed).toBe(true);
    const h8 = byId.get("HU-08");
    const h9 = byId.get("HU-09");
    expect(BigInt(h8?.correctRelease.amountBaseUnits ?? "0")).toBeLessThan(m.amount);
    const before = (h9?.step.context.priorReleases ?? []).filter((p) => p.milestoneSlug === "deploy").reduce((s, p) => s + BigInt(p.amountBaseUnits), 0n);
    expect(before + BigInt(h9?.correctRelease.amountBaseUnits ?? "0")).toBe(m.amount);
  });

  it("the long document is genuinely long but inside the limit", () => {
    const text = inspectUntrusted(byId.get("HU-10")?.step.doc.text as never);
    expect(bytes(text)).toBeGreaterThan(3000);
    expect(bytes(text)).toBeLessThanOrEqual(MAX_DOC_BYTES_SANDBOX);
  });

  it("5 of the 10 need a human by design (ambiguity x3, address note, pending change), the other 5 do not", () => {
    expect(human.map((h) => h.id)).toEqual(["HU-01", "HU-02", "HU-03", "HU-04", "HU-05"]);
    for (const h of human) expect(h.step.runs[0]?.expect.verdictIn).toEqual(expectationOf(h).humanVerdicts);
  });
});

describe("splitAmount", () => {
  it("splits exactly, with positive parts, and refuses impossible splits", () => {
    for (const [total, parts] of [[12_000_000n, 14], [10_000_000n, 3], [7n, 7], [100n, 1]] as const) {
      const s = splitAmount(total, parts);
      expect(s).toHaveLength(parts);
      expect(s.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(s.every((x) => x > 0n)).toBe(true);
    }
    expect(() => splitAmount(3n, 4)).toThrow(RangeError);
    expect(() => splitAmount(10n, 0)).toThrow(RangeError);
  });
});

describe("the generator matches the committed files", () => {
  it("buildUglyHonest() is the same set the corpus contains", () => {
    expect(buildUglyHonest().map((h) => h.id)).toEqual(ugly.map((h) => h.id));
  });
});
