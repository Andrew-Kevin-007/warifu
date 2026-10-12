// results/attack-matrix.{json,md} are generated, never typed (INV-18). This test regenerates them from the
// committed fixtures and the current code and fails on any difference. `pnpm --filter @symbolon/attack-suite
// attack:unit` runs it in write mode (ATTACK_RESULTS_WRITE=1) to refresh the files after a reviewed change.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildMatrix } from "../src/harness/matrix";
import type { AttackMatrix } from "../src/harness/matrix";
import { renderJson, renderMarkdown } from "../src/harness/report";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RESULTS = join(ROOT, "results");
const WRITE = process.env.ATTACK_RESULTS_WRITE === "1";
const SHA = /^[0-9a-f]{7,40}$/.test(process.env.ATTACK_GIT_SHA ?? "") ? (process.env.ATTACK_GIT_SHA as string) : null;

function readCommitted(): { json: string; md: string } {
  return { json: readFileSync(join(RESULTS, "attack-matrix.json"), "utf8"), md: readFileSync(join(RESULTS, "attack-matrix.md"), "utf8") };
}

if (WRITE) {
  const m = buildMatrix({ gitSha: SHA });
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, "attack-matrix.json"), renderJson(m), "utf8");
  writeFileSync(join(RESULTS, "attack-matrix.md"), renderMarkdown(m), "utf8");
}

describe("committed results", () => {
  it("are exactly what the harness computes now (apart from the recorded git SHA)", () => {
    const committed = readCommitted();
    const parsed = JSON.parse(committed.json) as AttackMatrix;
    const fresh = buildMatrix({ gitSha: parsed.provenance.gitSha });
    expect(committed.json).toBe(renderJson(fresh));
    expect(committed.md).toBe(renderMarkdown(fresh));
  });

  it("record the SHA of the code that ran, or say it was not recorded", () => {
    const parsed = JSON.parse(readCommitted().json) as AttackMatrix;
    expect(parsed.provenance.gitSha === null || /^[0-9a-f]{7,40}$/.test(parsed.provenance.gitSha)).toBe(true);
  });
});
