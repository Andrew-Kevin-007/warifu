// docs/16 §10 test 8: for 500 random configs, bounds.ts equals the independent Python/BigInt reference
// (packages/blast-radius/test/reference.py). The reference is a SECOND implementation written by VERIFIER from docs/08 and
// docs/16, not by BLAST; BLAST does not edit it. Until it exists this suite skips with a warning, and fails when
// REQUIRE_REFERENCE=1 (a release gate must not pass on a missing reference).
//
// Contract with the reference (stdin -> stdout, JSON, all integers as decimal strings):
//   in : [ { "B","P","D","H","hc","N","sumRemaining" } ... ]
//   out: [ { "perReleaseUnapproved", "perDay",
//            "horizons": [ { "label","seconds","value","binding":["balance"|"daily"|"engagements"|"hourly", ...] } x6 (1m,1h,6h,24h,48h,7d) ],
//            "timeToEmpty": { "days": "<int>"|null, "limitedBy": "<term>" },
//            "alarmed": { "seconds":300, "value", "binding":[...] } } ... ]
// Run: python -I <reference.py> < cases.json   (override the path with REFERENCE_PY, the interpreter with PYTHON_BIN).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { boundAlarmed, boundsAtHorizons, perDay, perReleaseUnapproved, timeToEmpty } from "../../src/bounds";
import type { BoundInputs } from "../../src/bounds";
import { SEED, boundInputs } from "../helpers/arb";

const REFERENCE = process.env["REFERENCE_PY"] ?? fileURLToPath(new URL("../reference.py", import.meta.url));
const PYTHON = process.env["PYTHON_BIN"] ?? "python";
const required = process.env["REQUIRE_REFERENCE"] === "1";
const present = existsSync(REFERENCE);
if (!present) {
  if (required) throw new Error(`[differential] ${REFERENCE} is required (REQUIRE_REFERENCE=1) but missing: VERIFIER writes it`);
  console.warn(`[differential] ${REFERENCE} not found: skipping the 500-config differential (VERIFIER owns reference.py)`);
}

describe.skipIf(!present)("bounds.ts vs the independent Python reference", () => {
  it("agrees on 500 random configs: per-release, per-day, 6 horizons (value and binding), time to empty, alarmed", () => {
    const configs = fc.sample(boundInputs, { numRuns: 500, seed: SEED + 34 });
    expect(configs).toHaveLength(500);
    const input = JSON.stringify(configs.map((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (v as bigint).toString()]))));
    const r = spawnSync(PYTHON, ["-I", REFERENCE], { input, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout) as {
      perReleaseUnapproved: string;
      perDay: string;
      horizons: { label: string; seconds: number; value: string; binding: string[] }[];
      timeToEmpty: { days: string | null; limitedBy: string };
      alarmed: { seconds: number; value: string; binding: string[] };
    }[];
    expect(out).toHaveLength(500);
    configs.forEach((c: BoundInputs, i) => {
      const ref = out[i]!;
      const where = `config ${String(i)} ${JSON.stringify(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, (v as bigint).toString()])))}`;
      expect(ref.perReleaseUnapproved, where).toBe(perReleaseUnapproved(c).toString());
      expect(ref.perDay, where).toBe(perDay(c).toString());
      const mine = boundsAtHorizons(c);
      expect(ref.horizons.map((h) => [h.label, h.seconds, h.value, h.binding]), where).toEqual(mine.map((h) => [h.label, Number(h.horizonSeconds), h.value.toString(), [...h.binding]]));
      const tte = timeToEmpty(c);
      expect(ref.timeToEmpty, where).toEqual({ days: tte.days === null ? null : tte.days.toString(), limitedBy: tte.limitedBy });
      const al = boundAlarmed(c);
      expect(ref.alarmed, where).toEqual({ seconds: 300, value: al.value.toString(), binding: [...al.binding] });
    });
  });
});
