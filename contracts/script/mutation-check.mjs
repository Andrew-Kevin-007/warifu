/* global console, setTimeout, clearTimeout */
// Mutation run for SymbolonVault (WP-08; the Solidity twin of packages/policy/scripts/mutation-check.mjs).
// Every mutant in script/mutants.mjs is applied to a scratch copy of the contracts project, the forge suite runs
// with --fail-fast, and the mutant must make a test FAIL. A mutant that does not compile is INVALID, never "killed".
// The real src/SymbolonVault.sol is never touched: mutants run in <repo>/.mutants/ws<j>/contracts (git-ignored),
// so a Ctrl-C cannot leave a mutated vault behind.
//
// Usage (from contracts/ or the repo root):
//   node contracts/script/mutation-check.mjs                      # all mutants, 4 workers
//   node contracts/script/mutation-check.mjs rel-,pc- --jobs 8   # only ids starting with "rel-" or "pc-"
//   node contracts/script/mutation-check.mjs --dry                # check that every `find` matches exactly once
//   node contracts/script/mutation-check.mjs --fuzz-runs 256 --invariant-runs 32   # quicker, weaker
// Exit 0 iff every selected mutant was killed (a full, unfiltered run also writes reports/mutation.json).
import process from "node:process";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTANTS } from "./mutants.mjs";

const contractsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(contractsDir, "..");
const scratchRoot = join(repoRoot, ".mutants");
const VAULT = "src/SymbolonVault.sol";
const forgeBin = process.env.FORGE_BIN || "forge";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const has = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const dry = has("--dry");
const noBaseline = has("--no-baseline");
const jobs = Math.max(1, Number(flag("--jobs") ?? Math.min(4, Math.max(1, Math.floor(cpus().length / 4)))));
const fuzzRuns = flag("--fuzz-runs");
const invariantRuns = flag("--invariant-runs");
const invariantDepth = flag("--invariant-depth");
const timeoutMs = Number(flag("--timeout-min") ?? 25) * 60_000;
// --state <file>: results are saved after every mutant and reloaded when the vault source, the test suite and the
// run settings are byte-identical, so an interrupted run resumes instead of starting over. Only KILLED is reused.
const statePath = flag("--state");
const filter = argv[0] ?? "";

const original = readFileSync(join(contractsDir, VAULT), "utf8").replace(/\r\n/g, "\n");
const vaultSha256 = createHash("sha256").update(original).digest("hex");
const prefixes = filter.split(",").filter((x) => x !== "");
const selected = MUTANTS.filter(([id]) => prefixes.length === 0 || prefixes.some((pf) => id.startsWith(pf)));
if (selected.length === 0) {
  console.error(`no mutant id starts with "${filter}"`);
  process.exit(2);
}

// ---- applicability ----------------------------------------------------------------------------------------------
const ids = new Set();
const results = new Map(); // id -> { status, killedBy? }
const applicable = [];
for (const [id, find, replace] of selected) {
  if (ids.has(id)) throw new Error(`duplicate mutant id ${id}`);
  ids.add(id);
  const count = original.split(find).length - 1;
  if (count !== 1) {
    results.set(id, { status: "NOT_APPLIED", detail: `find text occurs ${count}x (must be exactly once)` });
    continue;
  }
  if (original.replace(find, () => replace) === original) {
    results.set(id, { status: "NOT_APPLIED", detail: "replacement equals the original" });
    continue;
  }
  applicable.push([id, find, replace]);
}
console.log(`${selected.length} mutants selected, ${applicable.length} applicable`);
if (dry) {
  for (const [id, r] of results) console.log(`${id.padEnd(40)} ${r.status} ${r.detail}`);
  process.exit(results.size === 0 ? 0 : 1);
}

// ---- resumable state ---------------------------------------------------------------------------------------------
function listFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else out.push(p);
  }
  return out.sort();
}
const suiteSha256 = (() => {
  const h = createHash("sha256");
  for (const d of ["test", "script"]) {
    for (const f of listFiles(join(contractsDir, d))) {
      if (f.endsWith("mutation-check.mjs") || f.endsWith("mutants.mjs")) continue;
      h.update(f.slice(contractsDir.length));
      h.update(readFileSync(f).toString("utf8").replace(/\r\n/g, "\n"));
    }
  }
  h.update(readFileSync(join(contractsDir, "foundry.toml")).toString("utf8").replace(/\r\n/g, "\n"));
  return h.digest("hex");
})();
const settingsKey = JSON.stringify({ fuzzRuns: fuzzRuns ?? null, invariantRuns: invariantRuns ?? null, invariantDepth: invariantDepth ?? null });
const saved = {};
if (statePath && existsSync(statePath)) {
  const st = JSON.parse(readFileSync(statePath, "utf8"));
  if (st.vaultSha256 === vaultSha256 && st.suiteSha256 === suiteSha256 && st.settingsKey === settingsKey) {
    for (const [id, r] of Object.entries(st.results ?? {})) if (r.status === "KILLED") saved[id] = r;
  } else {
    console.log("state file does not match this vault/suite/settings: starting from scratch");
  }
}
for (let i = applicable.length - 1; i >= 0; --i) {
  const prev = saved[applicable[i][0]];
  if (prev) {
    results.set(applicable[i][0], { ...prev, resumed: true });
    applicable.splice(i, 1);
  }
}
if (Object.keys(saved).length) console.log(`resumed ${[...results.values()].filter((r) => r.resumed).length} killed mutants from ${statePath}`);
function saveState() {
  if (!statePath) return;
  const obj = {};
  for (const [id, r] of results) if (r.status === "KILLED") obj[id] = { status: r.status, killedBy: r.killedBy };
  writeFileSync(statePath, JSON.stringify({ vaultSha256, suiteSha256, settingsKey, results: obj }, null, 1));
}

// ---- scratch workspaces ------------------------------------------------------------------------------------------
function junction(target, path) {
  if (!existsSync(path)) symlinkSync(target, path, "junction");
}
function prepareWorkspace(j) {
  const ws = join(scratchRoot, `ws${j}`);
  const proj = join(ws, "contracts");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(ws, "deployments"), { recursive: true });
  junction(join(repoRoot, "packages"), join(ws, "packages"));
  junction(join(contractsDir, "lib"), join(proj, "lib"));
  cpSync(join(contractsDir, "foundry.toml"), join(proj, "foundry.toml"));
  for (const d of ["src", "test", "script"]) {
    rmSync(join(proj, d), { recursive: true, force: true });
    cpSync(join(contractsDir, d), join(proj, d), { recursive: true });
  }
  return proj;
}

function runForge(proj) {
  return new Promise((resolveRun) => {
    const env = { ...process.env, FOUNDRY_OFFLINE: "true", NO_COLOR: "1" };
    if (fuzzRuns) env.FOUNDRY_FUZZ_RUNS = fuzzRuns;
    if (invariantRuns) env.FOUNDRY_INVARIANT_RUNS = invariantRuns;
    if (invariantDepth) env.FOUNDRY_INVARIANT_DEPTH = invariantDepth;
    const child = spawn(forgeBin, ["test", "--fail-fast"], { cwd: proj, env, windowsHide: true });
    let out = "";
    const take = (b) => {
      if (out.length < 4_000_000) out += b.toString("utf8");
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({ code, signal, out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ code: -1, signal: null, out: String(e) });
    });
  });
}

function classify({ code, signal, out }) {
  if (signal) return { status: "TIMEOUT" };
  if (/Compiler run failed/i.test(out)) {
    const m = /Error \((\d+)\):[^\n]*/.exec(out);
    return { status: "INVALID", detail: m ? m[0] : "does not compile" };
  }
  if (code === 0) return { status: "SURVIVED" };
  const fail = /\[FAIL[^\]]*\]\s+([A-Za-z0-9_]+)\(/.exec(out) ?? /Failing tests?:[\s\S]*?\[FAIL[^\n]*?\]\s+(\S+)/.exec(out);
  if (fail) return { status: "KILLED", killedBy: fail[1] };
  return { status: "ERROR", detail: out.slice(-400) };
}

const queue = [...applicable];
const started = Date.now();
// One unmodified run (in workspace 0) proves the scratch copy and the suite are green before any mutant counts as
// killed; the other workers wait for it instead of repeating a full run each.
let baselinePromise = null;
function baseline(proj) {
  if (!baselinePromise) {
    baselinePromise = (async () => {
      if (noBaseline) return;
      const base = classify(await runForge(proj));
      if (base.status !== "SURVIVED") {
        console.error(`unmodified suite does not pass in the scratch copy (${base.status} ${base.detail ?? base.killedBy ?? ""})`);
        process.exit(3);
      }
      console.log("baseline: unmodified suite passes in the scratch copy");
    })();
  }
  return baselinePromise;
}

async function worker(j) {
  const proj = prepareWorkspace(j);
  const vaultPath = join(proj, VAULT);
  await baseline(proj);
  for (;;) {
    const next = queue.shift();
    if (!next) return;
    const [id, find, replace] = next;
    writeFileSync(vaultPath, original.replace(find, () => replace));
    let r;
    try {
      r = classify(await runForge(proj));
    } finally {
      writeFileSync(vaultPath, original);
    }
    results.set(id, r);
    saveState();
    const done =[...results.values()].filter((x) => x.status !== "NOT_APPLIED").length;
    console.log(`[${done}/${applicable.length}] ${id.padEnd(40)} ${r.status}${r.killedBy ? ` by ${r.killedBy}` : ""}${r.detail ? ` (${r.detail})` : ""}`);
  }
}

process.on("SIGINT", () => process.exit(130));
await Promise.all(Array.from({ length: jobs }, (_, j) => worker(j)));

// ---- report --------------------------------------------------------------------------------------------------------
const rows = selected.map(([id]) => ({ id, ...(results.get(id) ?? { status: "NOT_RUN" }) }));
const count = (s) => rows.filter((r) => r.status === s).length;
const summary = {
  total: rows.length,
  killed: count("KILLED"),
  survived: count("SURVIVED"),
  invalid: count("INVALID"),
  notApplied: count("NOT_APPLIED"),
  other: rows.length - count("KILLED") - count("SURVIVED") - count("INVALID") - count("NOT_APPLIED"),
};
const ok = summary.killed === rows.length;
for (const r of rows.filter((x) => x.status !== "KILLED")) console.log(`${r.id.padEnd(40)} ${r.status} ${r.detail ?? ""}`);
console.log(ok ? `all ${rows.length} mutants killed` : `NOT ALL KILLED: ${JSON.stringify(summary)}`);

if (prefixes.length === 0) {
  const fv = spawnSync(forgeBin, ["--version"], { encoding: "utf8" });
  const report = {
    schema: "symbolon-vault-mutation/1",
    vaultSource: VAULT,
    vaultSourceSha256: vaultSha256,
    forge: (fv.stdout || "").split("\n")[0],
    profile: `fuzz runs ${fuzzRuns ?? "foundry.toml default (1000)"}, invariant runs ${invariantRuns ?? "foundry.toml default (256)"}, invariant depth ${invariantDepth ?? "foundry.toml default (64)"}, forge --fail-fast`,
    durationSeconds: Math.round((Date.now() - started) / 1000),
    summary,
    mutants: rows,
  };
  mkdirSync(join(contractsDir, "reports"), { recursive: true });
  writeFileSync(join(contractsDir, "reports", "mutation.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log("wrote contracts/reports/mutation.json");
}
process.exit(ok ? 0 : 1);
