#!/usr/bin/env node
// SEC-11 (static) + WP-39 acceptance: the Claude Code routing/hygiene config must match docs/17.
//   node scripts/check-claude-config.mjs [--root <repo>]
// Checks: routing JSON valid and never "max"; every role has .claude/agents/<role>.md with matching model/effort;
// no stray agent files; settings.json sets CLAUDE_CODE_SUBAGENT_MODEL per routing, denies reading secret files
// (and does NOT deny .env.example), does not set global effort overrides; every kickoff header is a legal
// MODEL/EFFORT pair and every WP override in docs/17 is reflected in its kickoff file.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODELS = new Set(["opus", "sonnet", "haiku"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh"]); // "max" is deliberately absent

export const REQUIRED_DENY = [
  "Read(**/.env)",
  "Read(**/.env.local)",
  "Read(**/.env.production)",
  "Read(**/.env.sandbox)",
  "Read(~/.ssh/**)",
];

export function check(root) {
  const errors = [];
  const err = (m) => errors.push(m);

  // --- routing -----------------------------------------------------------------------------------
  const docPath = join(root, "docs/17_MODEL_AND_EFFORT_ROUTING.md");
  if (!existsSync(docPath)) return [`missing ${docPath}`];
  const m = /```json routing\n([\s\S]*?)\n```/.exec(readFileSync(docPath, "utf8"));
  if (!m) return ["docs/17: no ```json routing block"];
  let routing;
  try { routing = JSON.parse(m[1]); } catch (e) { return [`docs/17: routing JSON invalid: ${e.message}`]; }
  const legal = (where, v) => {
    if (!MODELS.has(v?.model)) err(`${where}: illegal model ${JSON.stringify(v?.model)}`);
    if (!EFFORTS.has(v?.effort)) err(`${where}: illegal effort ${JSON.stringify(v?.effort)} ("max" is not allowed)`);
  };
  for (const [k, v] of Object.entries(routing.roles ?? {})) legal(`role ${k}`, v);
  for (const [k, v] of Object.entries(routing.wpOverrides ?? {})) legal(`WP-${k} override`, v);

  // --- agent files -------------------------------------------------------------------------------
  const agentsDir = join(root, ".claude/agents");
  const expected = new Set();
  for (const [role, cfg] of Object.entries(routing.roles ?? {})) {
    const file = `${role.toLowerCase()}.md`;
    expected.add(file);
    const p = join(agentsDir, file);
    if (!existsSync(p)) { err(`missing .claude/agents/${file}`); continue; }
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(p, "utf8"));
    if (!fm) { err(`.claude/agents/${file}: no frontmatter`); continue; }
    const get = (key) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm[1])?.[1].trim();
    if (get("model") !== cfg.model) err(`.claude/agents/${file}: model ${get("model")} != routing ${cfg.model}`);
    if (get("effort") !== cfg.effort) err(`.claude/agents/${file}: effort ${get("effort")} != routing ${cfg.effort}`);
    if (get("name") !== role.toLowerCase()) err(`.claude/agents/${file}: name must be ${role.toLowerCase()}`);
  }
  if (existsSync(agentsDir)) {
    for (const f of readdirSync(agentsDir)) if (f.endsWith(".md") && !expected.has(f)) err(`stray agent file .claude/agents/${f} (not in docs/17 routing)`);
  } else err("missing .claude/agents/");

  // --- settings ----------------------------------------------------------------------------------
  const sp = join(root, ".claude/settings.json");
  if (!existsSync(sp)) err("missing .claude/settings.json");
  else {
    let s;
    try { s = JSON.parse(readFileSync(sp, "utf8")); } catch (e) { s = null; err(`.claude/settings.json invalid JSON: ${e.message}`); }
    if (s) {
      if (s.env?.CLAUDE_CODE_SUBAGENT_MODEL !== routing.subagentDefault) err(`settings: CLAUDE_CODE_SUBAGENT_MODEL must be ${routing.subagentDefault}`);
      for (const bad of ["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]) if (s.env && bad in s.env) err(`settings: ${bad} must not be set (docs/17 §2)`);
      if (s.effortLevel && !EFFORTS.has(s.effortLevel)) err(`settings: effortLevel ${s.effortLevel} not allowed`);
      const deny = new Set(s.permissions?.deny ?? []);
      for (const r of REQUIRED_DENY) if (!deny.has(r)) err(`settings: permissions.deny missing ${r}`);
      for (const r of deny) if (/\.env(\.\*|\*)\)?$/.test(r) || r === "Read(**/.env.*)") err(`settings: ${r} would also block .env.example; list secret files explicitly`);
      for (const a of s.permissions?.allow ?? []) if (/\.env(?!\.example)/.test(a)) err(`settings: allow rule ${a} re-opens an .env file`);
    }
  }

  // --- kickoff headers ---------------------------------------------------------------------------
  const kd = join(root, "kickoff");
  if (existsSync(kd)) {
    const byWp = new Map();
    for (const f of readdirSync(kd)) {
      const mm = /^WP-(\d\d)_.*\.md$/.exec(f);
      if (!mm) continue;
      const text = readFileSync(join(kd, f), "utf8");
      const h = /^MODEL:\s*(\S+)\s+EFFORT LEVEL:\s*(\S+)/m.exec(text);
      if (!h) { err(`kickoff/${f}: missing MODEL/EFFORT LEVEL header (run scripts/gen-kickoff.py)`); continue; }
      if (!MODELS.has(h[1]) || !EFFORTS.has(h[2])) err(`kickoff/${f}: illegal ${h[1]}/${h[2]}`);
      if (!new RegExp(`^LAUNCH: claude --model ${h[1]} --effort ${h[2]}$`, "m").test(text)) err(`kickoff/${f}: LAUNCH line does not match header`);
      byWp.set(String(Number(mm[1])), { model: h[1], effort: h[2] });
    }
    for (const [wp, ov] of Object.entries(routing.wpOverrides ?? {})) {
      const got = byWp.get(wp);
      if (!got) err(`WP-${wp} override has no kickoff file`);
      else if (got.model !== ov.model || got.effort !== ov.effort) err(`kickoff WP-${wp}: ${got.model}/${got.effort} != override ${ov.model}/${ov.effort}`);
    }
  } else err("missing kickoff/");
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--root");
  const root = resolve(i >= 0 ? process.argv[i + 1] : ".");
  const errors = check(root);
  if (errors.length) {
    console.error(`check-claude-config: ${errors.length} problem(s)`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log("check-claude-config: OK");
}
