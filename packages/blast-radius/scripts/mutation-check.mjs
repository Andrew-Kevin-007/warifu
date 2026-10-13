/* global process, console */
// Verifier mutation test (docs/16 §10 test 6, SEC-owned gate; implemented by BLAST because it needs the bounds sources).
// Programmatically mutates every comparison operator (flipped, and shifted by one at the boundary) and every `min` in
// bounds.ts and the certificate modules, runs the fast test suites against each mutant and requires the suite to FAIL.
// A surviving mutant is either a test gap (add a test) or an equivalent mutant (listed in ACCEPTED with a reason).
// The original file is restored in `finally`, also on Ctrl-C. Usage, from the repo root:
//   node packages/blast-radius/scripts/mutation-check.mjs                 # all mutants
//   node packages/blast-radius/scripts/mutation-check.mjs verify.ts       # only files whose name starts with the argument
// Prints the kill rate. Exit 0 iff every non-accepted mutant was killed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkg, "..", "..");

const TARGETS = ["src/bounds.ts", "src/lbc/verify.ts", "src/lbc/digest.ts", "src/lbc/body.ts", "src/lbc/code-match.ts", "src/lbc/validation.ts", "src/lbc/terms.ts"];
// Fast suites only (no anvil, no python): the closed form, the certificate body/verify matrix, surfaces, properties.
const SUITES = [
  "packages/blast-radius/test/golden.test.ts",
  "packages/blast-radius/test/bounds.property.test.ts",
  "packages/blast-radius/test/bounds.edges.test.ts",
  "packages/blast-radius/test/lbc/body.test.ts",
  "packages/blast-radius/test/lbc/verify.test.ts",
  "packages/blast-radius/test/lbc/verify.edges.test.ts",
  "packages/blast-radius/test/lbc/edges.test.ts",
  "packages/blast-radius/test/lbc/surfaces.test.ts",
  "packages/blast-radius/test/lbc/properties.test.ts",
];

/** key = `${file}:${line}:${original}->${mutated}`; value = why the mutant is equivalent (cannot change behaviour). */
const ACCEPTED = new Map([
  ["src/bounds.ts:99:11:<-><=", "min2 on a tie returns the other operand, which has the same value"],
  ["src/bounds.ts:138:35:<-><=", "choosing the first or the last of equal minima gives the same value; binding is computed separately from all ties"],
  ["src/bounds.ts:191:15:>->>=", "byDay and byHour equal: either branch returns the same value"],
  ["src/bounds.ts:70:15:===->!==", "only changes the text of an error message"],
  ["src/lbc/validation.ts:51:33:>->>=", "trials = 3 with 0 violations: 3/3 = 1, the same string either way"],
  ["src/lbc/terms.ts:119:25:<-><=", "sum equal to the cap: either branch is the same number"],
  ["src/lbc/digest.ts:75:50:>-><", "second comparator branch only separates equal ids, which are rejected as duplicates immediately after"],
  ["src/lbc/digest.ts:75:50:>->>=", "second comparator branch only separates equal ids, which are rejected as duplicates immediately after"],
  ["src/lbc/verify.ts:110:26:>->>=", "re-raising an outcome of equal severity changes nothing"],
  ["src/lbc/verify.ts:388:27:>->>=", "nowSeconds equal to the latest block timestamp: either branch is the same number"],
  ["src/bounds.ts:128:92:<=-><", "daySeconds = 0 is still refused: ceilDiv throws the same BoundsError when the day window is used (always)"],
]);

/** Replace comments, strings, template literals and regex-looking text with spaces, keeping offsets. */
function mask(src) {
  const out = src.split("");
  let i = 0;
  const blank = (a, b) => {
    for (let k = a; k < b; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      const e = src.indexOf("\n", i);
      const end = e === -1 ? src.length : e;
      blank(i, end);
      i = end;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      const end = e === -1 ? src.length : e + 2;
      blank(i, end);
      i = end;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      blank(i, j + 1);
      i = j + 1;
    } else i++;
  }
  return out.join("");
}

const OPS = [
  { re: / (<=) /g, to: [" >= ", " < "] },
  { re: / (>=) /g, to: [" <= ", " > "] },
  { re: / (<) /g, to: [" > ", " <= "] },
  { re: / (>) /g, to: [" < ", " >= "] },
  { re: / (===) /g, to: [" !== "] },
  { re: / (!==) /g, to: [" === "] },
];

function sites(file) {
  const src = readFileSync(join(pkg, file), "utf8");
  const m = mask(src);
  const found = [];
  for (const { re, to } of OPS) {
    for (const x of m.matchAll(re)) {
      const start = x.index;
      const line = src.slice(0, start).split("\n").length;
      for (const t of to) found.push({ file, line, start, len: x[0].length, from: x[0].trim(), to: t.trim(), text: t });
    }
  }
  for (const x of m.matchAll(/\bmin2\(/g)) {
    const line = src.slice(0, x.index).split("\n").length;
    found.push({ file, line, start: x.index, len: 5, from: "min2(", to: "max2(", text: "max2(", addMax: true });
  }
  return found;
}

const filter = process.argv[2] ?? "";
let restore = null;
process.on("SIGINT", () => {
  if (restore) restore();
  process.exit(130);
});

const results = [];
for (const file of TARGETS.filter((f) => f.split("/").pop().startsWith(filter) || f.startsWith(filter))) {
  const path = join(pkg, file);
  const original = readFileSync(path, "utf8");
  restore = () => writeFileSync(path, original);
  try {
    for (const s of sites(file)) {
      let mutated = original.slice(0, s.start) + s.text + original.slice(s.start + s.len);
      if (s.addMax) mutated += "\nfunction max2(a: bigint, b: bigint): bigint {\n  return a > b ? a : b;\n}\n";
      writeFileSync(path, mutated);
      const run = spawnSync(process.execPath, [join(root, "node_modules", "vitest", "vitest.mjs"), "run", ...SUITES, "--reporter=dot", "--bail=1"], { cwd: root, encoding: "utf8", timeout: 240_000 });
      const col = s.start - original.lastIndexOf("\n", s.start);
      const key = `${relative(pkg, path).replace(/\\/g, "/")}:${s.line}:${col}:${s.from}->${s.to}`;
      const killed = run.status !== 0;
      const accepted = ACCEPTED.get(key);
      results.push({ key, killed, accepted });
      console.log(`${killed ? "killed  " : accepted ? "accepted" : "SURVIVED"} ${key}`);
    }
  } finally {
    restore();
    restore = null;
  }
}

const total = results.length;
const killed = results.filter((r) => r.killed).length;
const accepted = results.filter((r) => !r.killed && r.accepted).length;
const survivors = results.filter((r) => !r.killed && !r.accepted);
console.log(`\nmutants: ${total}  killed: ${killed}  accepted-equivalent: ${accepted}  survived: ${survivors.length}  kill rate: ${total === 0 ? "n/a" : ((100 * killed) / total).toFixed(1)}%`);
for (const s of survivors) console.log(`  SURVIVOR ${s.key}`);
process.exit(total > 0 && survivors.length === 0 ? 0 : 1);
