// `pnpm build-replay` (WP-38, DEC-016, docs/15 section 7): builds the committed ReplayBundle the web app renders when
// live data is unavailable. Everything comes from committed results/*; nothing is typed by hand (INV-18).
// Honest by construction: attempts, receipts, decisions and extraction outputs are EMPTY because no challenge ran and
// no model was called; the attack matrix is the harness output verbatim (unit mode, SIMULATED engagements).
// Also writes replay-data/attack-meta.json (descriptive hypotheses from docs/07; not results).
//
//   node --experimental-transform-types --import ./packages/blast-radius/scripts/register-ts.mjs scripts/build-replay-bundle.ts [--built-at <iso>]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayBundleSchema, computeBundleHash } from "../packages/schemas/src/index.ts";
import { ATTACK_META } from "../packages/attack-suite/src/attack-meta.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "replay-data");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const matrix = JSON.parse(readFileSync(join(root, "results", "attack-matrix.json"), "utf8")) as Record<string, unknown>;
const honest = JSON.parse(readFileSync(join(root, "results", "honest-corpus.json"), "utf8")) as Record<string, unknown>;
const gitSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim().slice(0, 40);
const builtAt = arg("--built-at") ?? new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const draft = {
  version: 1 as const,
  builtAt,
  gitSha,
  harnessVersions: {
    attackHarness: String(matrix["harness"]),
    oracle: String(matrix["oracleVersion"]),
    honestCorpus: String(honest["evalVersion"]),
  },
  attackMatrix: matrix,
  // The hold-out set is written outside this repository and has not been run (see attackMatrix.holdout): n = 0.
  holdout: { seedHash: `0x${"0".repeat(64)}`, n: 0, losses: 0, upper95: 0 },
  scenarios: [],
  attempts: [],
  receipts: [],
  decisions: [],
  extractionOutputs: [],
  certificate: null,
  txs: [],
  plannerReport: { status: "not-run", reason: "no planner evaluation has been recorded" },
  bundleHash: `0x${"0".repeat(64)}`,
};
const parsed = ReplayBundleSchema.parse(draft);
const bundle = { ...parsed, bundleHash: computeBundleHash(parsed) };

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "bundle.json"), `${JSON.stringify(bundle, null, 2)}\n`);
writeFileSync(join(outDir, "attack-meta.json"), `${JSON.stringify(ATTACK_META, null, 2)}\n`);
console.log(`replay bundle written: replay-data/bundle.json`);
console.log(`bundleHash ${bundle.bundleHash}`);
console.log(`gitSha ${gitSha}`);
