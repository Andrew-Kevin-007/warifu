import { describe, expect, it } from "vitest";
import { ATTACK_IDS, WORLD, buildAttack, buildHonest } from "@symbolon/attack-suite";
import { benignCatalog, oneClickCatalog, runBenign, runFreeForm, runOneClick, scenarioMilestones } from "../../src/challenge/engine";

describe("challenge engine: the real kernel, one fresh instance per attempt, judged by the independent oracle", () => {
  it("lists all 24 one-click attacks with a caption, and says which cannot run in unit mode and why", () => {
    const cat = oneClickCatalog();
    expect(cat.map((c) => c.attackId)).toEqual([...ATTACK_IDS]);
    for (const c of cat) {
      expect(c.caption.length).toBeGreaterThan(10);
      if (!c.runnable) expect(c.note.length).toBeGreaterThan(0);
    }
    expect(cat.filter((c) => c.runnable).length).toBeGreaterThanOrEqual(15);
  });

  it("every one-click attack runs and none is judged a LOSS on the real kernel", () => {
    const losses: string[] = [];
    for (const c of oneClickCatalog()) {
      const r = runOneClick(c.attackId);
      expect(r.mode).toBe("UNIT");
      expect(r.attackId).toBe(c.attackId);
      if (r.oracleResult === "LOSS") losses.push(`${c.attackId}:${r.predicates.join("+")}`);
    }
    expect(losses).toEqual([]);
  });

  it("a one-click result carries codes, counts and amounts only: no document text", () => {
    const r = runOneClick("ATK-02");
    const text = JSON.stringify(r);
    const doc = buildAttack("ATK-02").steps.find((s) => s.kind === "submit");
    expect(doc?.kind).toBe("submit");
    if (doc?.kind === "submit") expect(text).not.toContain(String(doc.doc.text).slice(0, 40));
    expect(r.action).toBe("REJECT"); // the primary reading (a look-alike wallet) is refused
    expect(r.outcome).toBe("BLOCKED");
    expect(r.runs.some((x) => x.release !== null && x.release.oracle.result === "NO_LOSS")).toBe(true); // the legitimate look-alike run pays the registered payee
  });

  it("the six benign controls are offered and the correct ones PAY at the right amount (not over-blocked)", () => {
    const cat = benignCatalog();
    expect(cat).toHaveLength(6);
    const results = cat.map((c) => runBenign(c.id));
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(r?.oracleResult).toBe("NO_LOSS");
    }
    const paid = results.filter((r) => r?.benign?.released === true);
    expect(paid.length).toBeGreaterThanOrEqual(5);
    for (const r of paid) expect(r?.benign?.amountMatches).toBe(true);
    expect(runBenign("BC-999")).toBeNull();
  });

  it("a free-form attempt is read from the visitor's own extraction and still cannot redirect money: the payee binds by signature", () => {
    const h = buildHonest().find((x) => x.id === "BC-1");
    expect(h).toBeDefined();
    const base = h!.step.runs[0]!.a;
    const attackerWallet = "0x00000000000000000000000000000000000dEaD1" as const;
    const hostile = { ...base, payee: { ...base.payee, walletAddress: attackerWallet, claimsAddressChange: true } };
    const r = runFreeForm({ scenarioId: "S-A", milestoneSlug: scenarioMilestones("S-A")[0]!.slug, text: "pay 0xdead", a: hostile, b: hostile });
    expect(r).not.toBeNull();
    expect(r?.action).not.toBe("RELEASE");
    expect(r?.oracleResult).toBe("NO_LOSS");
    expect(r?.checksFired.length).toBeGreaterThan(0);
  });

  it("a free-form attempt names a milestone only from the scenario's own list", () => {
    const h = buildHonest().find((x) => x.id === "BC-1")!;
    const a = h.step.runs[0]!.a;
    expect(runFreeForm({ scenarioId: "S-A", milestoneSlug: "not-a-milestone", text: "x", a, b: a })).toBeNull();
    for (const id of ["S-A", "S-B", "S-C"] as const) expect(scenarioMilestones(id).length).toBe(WORLD[id].milestones.length);
  });

  it("an honest document read honestly in a fresh instance pays the exact milestone amount", () => {
    const h = buildHonest().find((x) => x.id === "BC-1")!;
    const a = h.step.runs[0]!.a;
    const r = runFreeForm({ scenarioId: h.scenarioId, milestoneSlug: h.step.milestoneSlug as string, text: String(h.step.doc.text), a, b: structuredClone(a) });
    expect(r?.oracleResult).toBe("NO_LOSS");
    expect(r?.action).toBe("RELEASE");
    expect(r?.runs[0]?.release?.amountBaseUnits).toBe(h.correctRelease.amountBaseUnits);
  });
});
