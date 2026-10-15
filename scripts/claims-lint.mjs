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

export const PUBLIC_COPY = ["README.md", "docs/VIDEO_SCRIPT.md", "docs/JUDGE_COPY.md", "docs/SUBMISSION_FORM_DRAFT.md"];

export function defaultFiles(root) {
  const out = [];
  for (const f of ["README.md", "SECURITY.md", "docs/VIDEO_SCRIPT.md", "docs/JUDGE_COPY.md", "docs/SUBMISSION_FORM_DRAFT.md"]) {
    if (existsSync(join(root, f))) out.push(join(root, f));
  }
  const web = join(root, "apps/web/src");
  if (existsSync(web)) walk(web, out);
  return out;
}

// INV-18: a claim-shaped number on a public surface must be one scripts/claims.ts produced (results/claims.json).
// Claim-shaped = percentages, dollar amounts, "N of M", "N USDC", and "N <trials|attacks|invoices|losses|...>".
// Ids (K-04, INV-18, ATK-24), versions, dates and times are not claim-shaped. Fenced code blocks are skipped.
const CLAIM_SHAPES = [
  /(\d[\d,]*(?:\.\d+)?)\s?%/g,
  /\$\s?(\d[\d,]*(?:\.\d+)?)/g,
  /\b(\d[\d,]*)\s+of\s+(\d[\d,]*)\b/gi,
  /\b(\d[\d,]*(?:\.\d+)?)\s*(?:USDC|USD)\b/g,
  /(?<![-\w.])(\d[\d,]*)\s+(?:trials?|attacks?|invoices?|losses|attempts|payments|businesses|tests?|scenarios|documents|model calls|users|pilots?)\b/gi,
];

export function lintNumbers(text, allowed) {
  const lines = text.split("\n");
  const findings = [];
  let fenced = false;
  lines.forEach((line, i) => {
    if (line.trim().startsWith("```")) { fenced = !fenced; return; }
    if (fenced) return;
    if (ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]))) return;
    for (const re of CLAIM_SHAPES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        for (const g of m.slice(1)) {
          if (g === undefined) continue;
          const tok = g.replace(/,/g, "");
          if (!allowed.has(tok) && !allowed.has(g)) findings.push({ line: i + 1, rule: "unsourced-number", match: m[0], hint: "numbers come from scripts/claims.ts (results/claims.json)" });
        }
      }
    }
  });
  return findings;
}

export function loadAllowed(root) {
  const p = join(root, "results/claims.json");
  if (!existsSync(p)) return null;
  return new Set(JSON.parse(readFileSync(p, "utf8")).allowedNumbers);
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
  const targets = files.length ? files : defaultFiles(root);
  const findings = lintFiles(targets, root);
  const allowed = loadAllowed(root);
  if (!allowed) {
    findings.push({ file: "results/claims.json", line: 0, rule: "claims-missing", match: "", hint: "run pnpm claims first (INV-18)" });
  } else {
    for (const f of targets) {
      const rel = relative(root, f).replace(/\\/g, "/");
      const isCopy = PUBLIC_COPY.includes(rel) || (rel.startsWith("apps/web/") && /\.(md|mdx)$/i.test(rel));
      if (!isCopy) continue;
      for (const x of lintNumbers(readFileSync(f, "utf8"), allowed)) findings.push({ file: rel, ...x });
    }
  }
  if (findings.length) {
    console.error(`claims-lint: ${findings.length} finding(s)`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  "${f.match}" (${f.rule}) -> ${f.hint}`);
    process.exit(1);
  }
  console.log("claims-lint: OK");
}
