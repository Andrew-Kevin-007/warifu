// Hold-out CLI (docs/07 §3.3; owner ATTACK). The fixtures live OUTSIDE the repository; this file only reads a directory
// the caller names. Layout of a round directory:   SEED (the seed string, secret until freeze)   fixtures/*.json   manifest.json
//   seal   <dir> <H1|H2>   validate every fixture, write <dir>/manifest.json, print the ROOT to commit in holdout/ROOT
//   verify <dir> <H1|H2>   recompute the ROOT from the files and compare it with the committed holdout/ROOT
//   run    <dir> <H1|H2>   verify, then run every target and write results/holdout-<round>.json and .md
// Run with:  pnpm holdout <command> <dir> <round>
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { asciiJson } from "../packages/attack-suite/src/files";
import {
  ROUNDS,
  buildManifest,
  checkLabels,
  defaultTargets,
  parseFixture,
  renderHoldoutMarkdown,
  rootOf,
  runFixtures,
  summarize,
} from "../packages/attack-suite/src/harness/holdout";
import type { Round } from "../packages/attack-suite/src/harness/holdout";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

function die(msg: string): never {
  process.stderr.write(`${msg}\n`);
  process.exit(2);
}

function readFixtures(dir: string): Map<string, string> {
  const fx = join(dir, "fixtures");
  if (!existsSync(fx)) die(`no fixtures/ directory in ${dir}`);
  const files = new Map<string, string>();
  for (const name of readdirSync(fx).filter((n) => n.endsWith(".json")).sort()) files.set(name, readFileSync(join(fx, name), "utf8"));
  return files;
}

function committedRoot(round: Round): string | null {
  const p = join(HERE, "ROOT");
  if (!existsSync(p)) return null;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^(H[12])\s+(0x[0-9a-f]{64})\s*$/.exec(line.trim());
    if (m !== null && m[1] === round) return m[2] as string;
  }
  return null;
}

function gitSha(): string | null {
  const dirty = (spawnSync("git", ["status", "--porcelain", "--", "packages", "holdout", "pnpm-lock.yaml"], { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim().length > 0;
  const head = (spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout ?? "").trim();
  return !dirty && /^[0-9a-f]{40}$/.test(head) ? head : null;
}

async function main(): Promise<void> {
  const [cmd, dirArg, roundArg] = process.argv.slice(2);
  if (cmd === undefined || dirArg === undefined || roundArg === undefined) die("usage: holdout <seal|verify|run> <dir> <H1|H2>");
  if (!(ROUNDS as readonly string[]).includes(roundArg)) die(`round must be one of ${ROUNDS.join(", ")}`);
  const round = roundArg as Round;
  const dir = resolve(dirArg);
  if (dir.startsWith(REPO)) die("refusing: the hold-out fixtures must live outside the repository (docs/07 §3.3)");
  const seedPath = join(dir, "SEED");
  if (!existsSync(seedPath)) die(`no SEED file in ${dir}`);
  const seed = readFileSync(seedPath, "utf8").trim();
  const files = readFixtures(dir);
  const manifest = buildManifest(round, seed, files);
  const root = rootOf(manifest);

  if (cmd === "seal") {
    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${round} ${root}\n${manifest.count} fixtures sealed. Put the line above into holdout/ROOT and commit it before any defender run.\n`);
    return;
  }
  const expected = committedRoot(round);
  if (expected === null) die(`holdout/ROOT has no ${round} line: commit the root before running anything against the fixtures`);
  if (expected !== root) die(`ROOT mismatch for ${round}: committed ${expected}, recomputed ${root}. The fixture set changed after it was committed; refusing to run.`);
  if (cmd === "verify") {
    process.stdout.write(`${round} ROOT verified (${manifest.count} fixtures): ${root}\n`);
    return;
  }
  if (cmd !== "run") die(`unknown command ${cmd}`);
  const fixtures = [...files.values()].map(parseFixture);
  const outcomes = await runFixtures(fixtures, defaultTargets());
  const labels = fixtures.filter((f) => f.kind === "attack").flatMap(checkLabels);
  const results = summarize(round, root as `0x${string}`, manifest.seedHash as `0x${string}`, fixtures, outcomes, labels, gitSha());
  writeFileSync(join(REPO, "results", `holdout-${round}.json`), asciiJson(results));
  writeFileSync(join(REPO, "results", `holdout-${round}.md`), renderHoldoutMarkdown(results));
  process.stdout.write(`${round}: wrote results/holdout-${round}.json and .md\n`);
}

await main();
