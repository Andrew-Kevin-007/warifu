#!/usr/bin/env node
// DEC-012 / INV-18 wording lint (docs/16 §4.3). Fails on overclaiming words in README, SECURITY.md,
// docs/VIDEO_SCRIPT.md and apps/web/src/**. Design docs quote the rule and are exempt.
//   node scripts/claims-lint.mjs [--root <dir>] [files...]
// Opt-out (reviewed by VERIFIER): `claims-lint-allow: <reason>` on the same or the previous line.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NEG = String.raw`(?<!\bno\s)(?<!\bnot\s)(?<!\bnever\s)(?<!\bnor\s)(?<!\bwithout\s)(?<!\bcannot\s)(?<!n't\s)`;
export const RULES = [
  { id: "provable", re: new RegExp(String.raw`\bprovabl[ey]\b`, "i"), hint: 'say "calculated from on-chain state and empirically tested"' },
  { id: "proven", re: new RegExp(String.raw`\bproven\b`, "i"), hint: "state what was tested and how many trials" },
  { id: "proof-of-safety", re: new RegExp(String.raw`\bproof of safety\b`, "i"), hint: "the certificate is a recomputation, not a proof" },
  { id: "guaranteed", re: new RegExp(NEG + String.raw`\bguarantee(?:s|d)?\b`, "i"), hint: 'say "bounded, assuming A-..."' },
  { id: "unhackable", re: new RegExp(String.raw`\bunhackable\b`, "i"), hint: "invite attack instead" },
  { id: "unbreakable", re: new RegExp(String.raw`\bunbreakable\b`, "i"), hint: 'say "0 losses in n attempts (upper bound ~3/n)"' },
  { id: "fully-secure", re: new RegExp(String.raw`\b100\s?%\s*secure\b`, "i"), hint: "list assumptions and exclusions" },
  { id: "risk-free", re: new RegExp(String.raw`\b(?:risk[- ]free|zero[- ]risk)\b`, "i"), hint: "show the bound and its exclusions" },
  { id: "audited", re: new RegExp(NEG + String.raw`\baudited\b`, "i"), hint: 'say "unaudited" unless an external audit is linked' },
];
const ALLOW = /claims-lint-allow:\s*\S+/;

export function lintText(text) {
  const lines = text.split("\n");
  const findings = [];
  lines.forEach((line, i) => {
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return;
    for (const r of RULES) {
      const m = r.re.exec(line);
      if (m) findings.push({ line: i + 1, rule: r.id, match: m[0], hint: r.hint });
    }
  });
  return findings;
}

const TEXT_EXT = /\.(md|mdx|ts|tsx|js|jsx|json|html|txt)$/i;
const SKIP = new Set(["node_modules", ".next", "dist", "coverage", "test"]);

function walk(dir, out) {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (TEXT_EXT.test(e)) out.push(p);
  }
}

export function defaultFiles(root) {
  const out = [];
  for (const f of ["README.md", "SECURITY.md", "docs/VIDEO_SCRIPT.md"]) if (existsSync(join(root, f))) out.push(join(root, f));
  const web = join(root, "apps/web/src");
  if (existsSync(web)) walk(web, out);
  return out;
}

export function lintFiles(files, root) {
  const all = [];
  for (const f of files) for (const x of lintText(readFileSync(f, "utf8"))) all.push({ file: relative(root, f), ...x });
  return all;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ri = args.indexOf("--root");
  const root = resolve(ri >= 0 ? args[ri + 1] : ".");
  const files = args.filter((a, i) => !a.startsWith("--") && !(ri >= 0 && i === ri + 1)).map((a) => resolve(root, a));
  const findings = lintFiles(files.length ? files : defaultFiles(root), root);
  if (findings.length) {
    console.error(`claims-lint: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  "${f.match}" (${f.rule}) -> ${f.hint}`);
    process.exit(1);
  }
  console.log("claims-lint: OK");
}
