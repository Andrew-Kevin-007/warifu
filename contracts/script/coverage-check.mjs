/* global console */
// Coverage gate for SymbolonVault (WP-08, docs/06 A.5: ">= 95 % lines, 100 % of revert paths"; this gate is stricter:
// 100 % of lines, statements, branches and functions of src/SymbolonVault.sol).
// Usage (from contracts/):  node script/coverage-check.mjs [--no-write]
// Runs `forge coverage` (summary + lcov), parses the table row of the vault and the lcov record, writes
// reports/coverage.json and exits 1 below 100 %. Fuzz and invariant runs are reduced for speed (coverage is about
// which lines execute; the unit tests alone reach them); override with FOUNDRY_FUZZ_RUNS / FOUNDRY_INVARIANT_*.
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const forge = process.env.FORGE_BIN || "forge";
const VAULT = "src/SymbolonVault.sol";
const write = !process.argv.includes("--no-write");

const dir = mkdtempSync(join(tmpdir(), "symbolon-cov-"));
const lcovPath = join(dir, "vault.lcov");
const env = {
  ...process.env,
  FOUNDRY_OFFLINE: "true",
  NO_COLOR: "1",
  FOUNDRY_FUZZ_RUNS: process.env.FOUNDRY_FUZZ_RUNS || "200",
  FOUNDRY_INVARIANT_RUNS: process.env.FOUNDRY_INVARIANT_RUNS || "24",
  FOUNDRY_INVARIANT_DEPTH: process.env.FOUNDRY_INVARIANT_DEPTH || "48",
};
const r = spawnSync(
  forge,
  ["coverage", "--report", "summary", "--report", "lcov", "--report-file", lcovPath, "--no-match-coverage", "test|script|lib"],
  { cwd: contractsDir, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
);
const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
if (r.status !== 0) {
  console.error(out.split("\n").slice(-40).join("\n"));
  console.error(`forge coverage failed (exit ${r.status}); a failing test blocks the coverage gate`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(2);
}

// | File | % Lines | % Statements | % Branches | % Funcs |
const row = out.split("\n").find((l) => l.includes(VAULT) && l.trim().startsWith("|"));
if (!row) {
  console.error("no summary row for the vault in forge coverage output");
  process.exit(2);
}
const cells = row.split("|").map((c) => c.trim()).filter((c) => c !== "");
const parse = (cell) => {
  const m = /([\d.]+)%\s*\((\d+)\/(\d+)\)/.exec(cell);
  if (!m) throw new Error(`cannot parse coverage cell: ${cell}`);
  return { percent: Number(m[1]), hit: Number(m[2]), total: Number(m[3]) };
};
const result = {
  lines: parse(cells[1]),
  statements: parse(cells[2]),
  branches: parse(cells[3]),
  functions: parse(cells[4]),
};

// lcov cross-check: uncovered line numbers, if any
const lcov = readFileSync(lcovPath, "utf8");
const rec = lcov.split("end_of_record").find((x) => x.includes(`SF:${VAULT}`));
const uncoveredLines = [];
const uncoveredBranches = [];
if (rec) {
  for (const l of rec.split("\n")) {
    const da = /^DA:(\d+),(\d+)/.exec(l);
    if (da && Number(da[2]) === 0) uncoveredLines.push(Number(da[1]));
    const br = /^BRDA:(\d+),\d+,\d+,(-|0)$/.exec(l);
    if (br) uncoveredBranches.push(Number(br[1]));
  }
}
rmSync(dir, { recursive: true, force: true });

const full = Object.values(result).every((c) => c.total > 0 && c.hit === c.total);
const source = readFileSync(join(contractsDir, VAULT), "utf8").replace(/\r\n/g, "\n");
const report = {
  schema: "symbolon-vault-coverage/1",
  file: VAULT,
  vaultSourceSha256: createHash("sha256").update(source).digest("hex"),
  forge: spawnSync(forge, ["--version"], { encoding: "utf8" }).stdout.split("\n")[0],
  settings: {
    fuzzRuns: env.FOUNDRY_FUZZ_RUNS,
    invariantRuns: env.FOUNDRY_INVARIANT_RUNS,
    invariantDepth: env.FOUNDRY_INVARIANT_DEPTH,
    note: "forge coverage disables the optimizer; Build/Surface tests skip themselves in the Coverage context",
  },
  result,
  uncoveredLines,
  uncoveredBranchLines: [...new Set(uncoveredBranches)],
  complete: full,
};
console.log(JSON.stringify(report, null, 2));
if (write) {
  mkdirSync(join(contractsDir, "reports"), { recursive: true });
  writeFileSync(join(contractsDir, "reports", "coverage.json"), `${JSON.stringify(report, null, 2)}\n`);
}
process.exit(full ? 0 : 1);
