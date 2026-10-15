import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM script without types
import { lintNumbers, lintText, loadAllowed } from "../scripts/claims-lint.mjs";
import { computeClaims, renderFragment, renderTemplate, replaceBlock } from "../scripts/claims";

const ROOT = resolve(import.meta.dirname, "..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");
const doc = computeClaims(ROOT, "test");

describe("claims generator (INV-18)", () => {
  it("every claim carries a source, a label, and the assumptions/exclusions arrays", () => {
    for (const c of Object.values(doc.claims)) {
      expect(c.source.length).toBeGreaterThan(0);
      expect(["SIMULATED", "RECORDED", "LIVE", "NOT_COMPUTED"]).toContain(c.label);
      expect(Array.isArray(c.assumptions) && Array.isArray(c.exclusions)).toBe(true);
    }
  });

  it("numbers equal the committed result files (independent read)", () => {
    const m = JSON.parse(read("results/attack-matrix.json"));
    const s = m.totals.find((t: { target: string }) => t.target === "symbolon");
    expect(doc.claims["atk.symbolon.loss_trials"]!.k).toBe(s.lossTrials);
    expect(doc.claims["atk.symbolon.loss_trials"]!.n).toBe(s.trials);
    expect(doc.claims["atk.symbolon.loss_trials"]!.rule).toBe("oracle-v1");
  });

  it("figures that do not exist are NOT_COMPUTED, never estimated", () => {
    for (const id of ["holdout", "certificate", "challenge"]) {
      expect(doc.claims[id]!.label).toBe("NOT_COMPUTED");
      expect(doc.claims[id]!.numbers).toEqual([]);
    }
  });

  it("planner/attack-suite figures are SIMULATED and no claim is labelled RECORDED without a recording", () => {
    expect(doc.claims["atk.b1.loss_trials"]!.label).toBe("SIMULATED");
    expect(Object.values(doc.claims).some((c) => c.label === "RECORDED")).toBe(false);
  });

  it("committed results/claims.json is fresh (ignoring the git sha)", () => {
    const committed = JSON.parse(read("results/claims.json"));
    expect({ ...committed, provenance: { ...committed.provenance, gitSha: "" } }).toEqual({
      ...JSON.parse(JSON.stringify(doc)),
      provenance: { ...doc.provenance, gitSha: "" },
    });
  });

  it("README block and generated copy files are fresh", () => {
    expect(read("README.md")).toBe(replaceBlock(read("README.md"), renderFragment(doc)));
    for (const [t, out] of [
      ["video-script", "docs/VIDEO_SCRIPT.md"],
      ["judge-copy", "docs/JUDGE_COPY.md"],
      ["submission-form", "docs/SUBMISSION_FORM_DRAFT.md"],
    ] as const) {
      const body = renderTemplate(read(`docs/claims-templates/${t}.tmpl.md`), doc);
      expect(read(out).endsWith(body)).toBe(true);
    }
  });

  it("a template naming an unknown claim fails closed", () => {
    expect(() => renderTemplate("{{nope.nothing}}", doc)).toThrow(/unknown claim/);
  });
});

describe("claims-lint number rule (negative controls)", () => {
  const allowed = loadAllowed(ROOT) as Set<string>;
  it("flags a hand-typed percentage, N of M and dollar amount", () => {
    expect(lintNumbers("Reaches 99.9% accuracy", allowed).map((f: { rule: string }) => f.rule)).toEqual(["unsourced-number"]);
    expect(lintNumbers("blocked 777 of 778", allowed).length).toBeGreaterThan(0);
    expect(lintNumbers("saves $12345", allowed).length).toBe(1);
    expect(lintNumbers("tested on 4242 invoices", allowed).length).toBe(1);
  });
  it("passes a number that claims.json produced, and ids/dates/times", () => {
    const n = doc.claims["atk.symbolon.loss_trials"]!.n;
    expect(lintNumbers(`${n} trials`, allowed)).toEqual([]);
    expect(lintNumbers("K-04, INV-18, ATK-24, 2026-10-17, 0:20-0:50", allowed)).toEqual([]);
  });
  it("skips fenced code and honours the allow comment", () => {
    expect(lintNumbers("```\n99.9% fake\n```", allowed)).toEqual([]);
    expect(lintNumbers("<!-- claims-lint-allow: quoting a spec -->\n99.9% fake", allowed)).toEqual([]);
  });
  it("word rules still fire on public copy", () => {
    expect(lintText("fully unhackable and risk-free").length).toBe(2);
  });
  it("committed public copy has no banned words", () => {
    for (const f of ["README.md", "docs/VIDEO_SCRIPT.md", "docs/JUDGE_COPY.md", "docs/SUBMISSION_FORM_DRAFT.md"]) {
      expect(lintText(read(f))).toEqual([]);
    }
  });
});
