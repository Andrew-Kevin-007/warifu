// Regenerates results/attack-matrix.{json,md} by running the harness in unit mode (docs/07 §2, `pnpm attack:unit`).
// It runs the results test in write mode, the same pattern as write-fixtures.mjs. No network, no model, no key.
// The git SHA of HEAD is recorded as provenance; a dirty tree is recorded as "not recorded" because the SHA would
// not describe the code that ran.
// Usage: pnpm --filter @symbolon/attack-suite attack:unit   (then review `git diff results`).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const dirty = (git(["status", "--porcelain", "--", "packages", "pnpm-lock.yaml"]).stdout ?? "").trim().length > 0;
const head = (git(["rev-parse", "HEAD"]).stdout ?? "").trim();
const sha = !dirty && /^[0-9a-f]{40}$/.test(head) ? head : "";
const vitest = resolve(root, "node_modules", "vitest", "vitest.mjs");
const r = spawnSync(process.execPath, [vitest, "run", "packages/attack-suite/test/results-files.test.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ATTACK_RESULTS_WRITE: "1", ATTACK_GIT_SHA: sha },
});
process.exit(r.status ?? 1);
