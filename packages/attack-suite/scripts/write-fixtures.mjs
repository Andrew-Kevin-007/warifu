// Regenerates packages/attack-suite/fixtures/** from the generators by running the drift test in write mode.
// Usage: pnpm --filter @symbolon/attack-suite fixtures:write   (then review `git diff packages/attack-suite/fixtures`).
// Never edit a fixture file by hand and never regenerate to make a failing run pass: a diff here means the
// generator or the spec changed, and the diff is what a reviewer reads (AGENTS.md: fixtures are not edited to turn green).
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const vitest = resolve(root, "node_modules", "vitest", "vitest.mjs");
const r = spawnSync(process.execPath, [vitest, "run", "packages/attack-suite/test/fixture-files.test.ts"], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, ATTACK_FIXTURES_WRITE: "1" },
});
process.exit(r.status ?? 1);
