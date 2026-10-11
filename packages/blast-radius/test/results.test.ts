// results/blast-closed-form.json: the committed record of the closed-form-vs-enumeration campaign (WP-25).
//   regenerate: BLAST_WRITE_RESULTS=1 pnpm exec vitest run packages/blast-radius/test/results.test.ts
// Without the flag this test recomputes the campaign and requires it to equal the committed file, so the file
// cannot go stale or be hand-edited (INV-18: public numbers come from committed results, never from typing).
// What it is NOT: it does not execute the vault. The T3 simulator on the real contract is WP-26; until it runs,
// vaultRuntimeCodeHash is null and the file says "not validated for this deployment".
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseProvenance } from "../src/provenance";
import type { ResultProvenance } from "../src/provenance";
import { SEED } from "./helpers/arb";
import { enumerated, realWindowed, tiny, toInputs, valid } from "./helpers/tiny";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const OUT = fileURLToPath(new URL("../../../results/blast-closed-form.json", import.meta.url));
const RUNS = 5000;

interface Campaign {
  readonly name: "closed-form-vs-exhaustive-enumeration";
  readonly seed: number;
  readonly runs: number;
  readonly executedCases: number;
  readonly skippedCases: number;
  /** bound < enumerated: the bound would be wrong. Must be 0. */
  readonly violations: number;
  /** cases with the hourly cap off: the bound must EQUAL the enumeration (tightness 1). */
  readonly tightnessCases: number;
  readonly tightnessMismatches: number;
  /** cases with an hourly cap on: bound >= enumeration is required; equality is reported, not required. */
  readonly hourlyCases: number;
  readonly hourlyEqual: number;
  readonly hourlyAbove: number;
  readonly hourlyBelow: number;
}

function runCampaign(seed: number): Campaign {
  const c = { executed: 0, skipped: 0, violations: 0, tightCases: 0, tightMismatch: 0, hourlyCases: 0, hourlyEqual: 0, hourlyAbove: 0, hourlyBelow: 0 };
  const d = fc.check(
    fc.property(tiny, (x) => {
      if (!valid(x)) {
        c.skipped++;
        return true;
      }
      c.executed++;
      const e = BigInt(enumerated(x));
      const b = realWindowed(toInputs(x), BigInt(x.t), BigInt(x.dayLen), BigInt(x.hourLen));
      if (b < e) c.violations++;
      if (x.hc === 0) {
        c.tightCases++;
        if (b !== e) c.tightMismatch++;
      } else {
        c.hourlyCases++;
        if (b === e) c.hourlyEqual++;
        else if (b > e) c.hourlyAbove++;
        else c.hourlyBelow++;
      }
      return true;
    }),
    { numRuns: RUNS, seed },
  );
  if (d.failed) throw new Error("campaign property threw");
  return {
    name: "closed-form-vs-exhaustive-enumeration",
    seed,
    runs: RUNS,
    executedCases: c.executed,
    skippedCases: c.skipped,
    violations: c.violations,
    tightnessCases: c.tightCases,
    tightnessMismatches: c.tightMismatch,
    hourlyCases: c.hourlyCases,
    hourlyEqual: c.hourlyEqual,
    hourlyAbove: c.hourlyAbove,
    hourlyBelow: c.hourlyBelow,
  };
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}
function version(pkg: string): string {
  const p = fileURLToPath(new URL(`../../../node_modules/${pkg}/package.json`, import.meta.url));
  return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
}

function provenance(seeds: number[]): ResultProvenance {
  return parseProvenance({
    gitSha: git(["rev-parse", "HEAD"]),
    gitDirty: git(["status", "--porcelain", "--untracked-files=no"]).length > 0,
    seeds,
    modelIds: [],
    promptHashes: [],
    vaultRuntimeCodeHash: null,
    tools: { node: process.version, "fast-check": version("fast-check"), vitest: version("vitest") },
  });
}

describe("results/blast-closed-form.json", () => {
  const campaign = runCampaign(SEED + 100);

  it("the campaign itself: zero violations; the bound equals the enumeration whenever the hourly cap is off", () => {
    expect(campaign.violations).toBe(0);
    expect(campaign.tightnessMismatches).toBe(0);
    expect(campaign.hourlyBelow).toBe(0);
    expect(campaign.tightnessCases).toBeGreaterThan(500);
    expect(campaign.hourlyCases).toBeGreaterThan(500);
    expect(campaign.executedCases + campaign.skippedCases).toBe(RUNS);
  });

  it("committed file matches a fresh recomputation (or is rewritten with BLAST_WRITE_RESULTS=1)", () => {
    const file = {
      schema: "symbolon-blast-results/1",
      kind: "closed-form-vs-enumeration",
      algorithm: { id: "symbolon-bounds", version: "1.0.0" },
      wording:
        "Calculated from the closed form and compared with an independent exhaustive enumeration of the modelled vault rules on tiny parameters. This does not execute the contract: validation against the real vault is the T3 simulator (WP-26).",
      limits: [
        "enumeration model: pooled engagement capacity; tiny windows and amounts; one interval start",
        "no vault bytecode executed: vaultRuntimeCodeHash is null, so this is not validated for any deployment",
        "no LLM involved: modelIds and promptHashes are empty",
      ],
      provenance: provenance([campaign.seed]),
      campaign,
    };
    if (process.env["BLAST_WRITE_RESULTS"] === "1") {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, `${JSON.stringify(file, null, 2)}\n`);
    }
    expect(existsSync(OUT), "results/blast-closed-form.json is missing: run with BLAST_WRITE_RESULTS=1").toBe(true);
    const committed = JSON.parse(readFileSync(OUT, "utf8")) as typeof file;
    expect(committed.campaign).toEqual(file.campaign);
    expect(committed.schema).toBe(file.schema);
    expect(committed.algorithm).toEqual(file.algorithm);
    const p = parseProvenance(committed.provenance);
    expect(p.seeds).toEqual([campaign.seed]);
    expect(p.modelIds).toEqual([]);
    expect(p.promptHashes).toEqual([]);
    expect(p.vaultRuntimeCodeHash).toBeNull();
  });
});
