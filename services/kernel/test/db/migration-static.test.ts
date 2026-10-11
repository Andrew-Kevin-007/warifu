// WP-09 static checks on the SQL files. No database needed: these always run.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, REPO_ROOT, SUPABASE_DIR } from "./harness";

/** Split SQL into statements, honouring '...' strings, $tag$...$tag$ bodies and comments. Comments are dropped. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i] ?? "";
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim() !== "") out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim() !== "") out.push(cur);
  return out.map(normalize);
}

function normalize(stmt: string): string {
  return stmt
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

function docSqlBlocks(): string[] {
  const text = readFileSync(join(REPO_ROOT, "docs", "05_DATA_MODELS_AND_API.md"), "utf8");
  return [...text.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

function isSubsequence(needles: string[], haystack: string[]): { ok: boolean; missing?: string } {
  let at = 0;
  for (const n of needles) {
    const found = haystack.indexOf(n, at);
    if (found === -1) return { ok: false, missing: n };
    at = found + 1;
  }
  return { ok: true };
}

const read = (f: string): string => readFileSync(join(MIGRATIONS_DIR, f), "utf8");
const stripComments = (sql: string): string => splitStatements(sql).join(";\n");

describe("migration files (static)", () => {
  it("are numbered 0001.. with no gaps and no duplicates", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThanOrEqual(3);
    files.forEach((f, i) => expect(f.startsWith(String(i + 1).padStart(4, "0") + "_")).toBe(true));
    expect(files.slice(0, 2)).toEqual(["0001_init.sql", "0002_v2.sql"]);
  });

  it("0001 contains every docs/05 section 3 statement, verbatim, in order", () => {
    const doc = splitStatements(docSqlBlocks()[0] ?? "");
    expect(doc.length).toBeGreaterThan(20);
    const r = isSubsequence(doc, splitStatements(read("0001_init.sql")));
    expect(r.missing).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it("0002 contains every docs/05 section 3b statement verbatim and in order, and nothing else inside the markers but releases_public", () => {
    const doc = splitStatements(docSqlBlocks()[1] ?? "");
    expect(doc.length).toBeGreaterThan(20);
    const file = read("0002_v2.sql");
    const begin = file.indexOf("-- BEGIN docs/05 3b");
    const end = file.indexOf("-- END docs/05 3b");
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    const inside = splitStatements(file.slice(begin, end));
    const r = isSubsequence(doc, inside);
    expect(r.missing).toBeUndefined();
    const extras = inside.filter((s) => !doc.includes(s));
    expect(extras.length).toBe(1);
    expect(extras[0]).toMatch(/^create view releases_public as/);
  });

  it("0002 does not edit 0001 objects other than as docs/05 3b lists (every alter/drop/update targets a 3b item)", () => {
    // The set of mutating statements in 0002 outside the markers is limited to RLS enables and grants/revokes.
    const file = read("0002_v2.sql");
    const after = splitStatements(file.slice(file.indexOf("-- END docs/05 3b")));
    for (const s of after) expect(s).toMatch(/^(alter table \w+ enable row level security|revoke all on all (tables|sequences) in schema public from anon,authenticated|grant select on [\w,]+ to anon,authenticated)$/);
  });

  it("define no RLS policy, no SECURITY DEFINER function, no dynamic SQL and no float/money type", () => {
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql"))) {
      const sql = stripComments(read(f)).toLowerCase();
      expect(sql, `${f}: create policy`).not.toMatch(/create\s+policy/);
      expect(sql, `${f}: security definer`).not.toMatch(/security\s+definer/);
      expect(sql, `${f}: dynamic SQL`).not.toMatch(/\bexecute\s+(format|'|\$)/);
      expect(sql, `${f}: float`).not.toMatch(/\b(float4|float8|float|double precision|money)\b/);
      expect(sql, `${f}: real-typed column`).not.toMatch(/\s\w+\s+real\b(?!\s+boolean)/);
      expect(sql, `${f}: force rls`).not.toMatch(/force\s+row\s+level\s+security/);
    }
  });

  it("0003 revokes and re-grants EXECUTE on every function it adds for the service role", () => {
    const sql = stripComments(read("0003_hardening.sql")).toLowerCase();
    for (const fn of ["llm_budget_reserve", "llm_budget_commit", "llm_budget_record_cache_hit", "challenge_purge_expired"]) {
      expect(sql).toMatch(new RegExp(`revoke all on function ${fn}\\([^)]*\\)\\s*from public,anon,authenticated`));
      expect(sql).toMatch(new RegExp(`grant execute on function ${fn}\\([^)]*\\)\\s*to service_role`));
    }
  });

  it("contain no secret-looking material (private keys, JWTs, service keys)", () => {
    const files = [...readdirSync(MIGRATIONS_DIR).map((f) => join(MIGRATIONS_DIR, f)), join(SUPABASE_DIR, "seed.sql"), join(SUPABASE_DIR, "sandbox", "public_challenge_stats.sql")];
    for (const p of files) {
      const text = readFileSync(p, "utf8");
      expect(text, p).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(text, p).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, p).not.toMatch(/\b0x[0-9a-fA-F]{64}\b(?<!0x0{64})/); // only the all-zero placeholder hash is allowed
      expect(text, p).not.toMatch(/sk-[A-Za-z0-9]{20,}|service_role_key|SUPABASE_SERVICE_ROLE_KEY\s*=/);
    }
  });

  it("the seed is demo data only: every tenant it inserts is kind 'demo'", () => {
    const raw = readFileSync(join(SUPABASE_DIR, "seed.sql"), "utf8");
    expect(raw).toMatch(/demo:true/);
    const seed = splitStatements(raw).join(";\n"); // comments dropped
    expect(seed).not.toMatch(/'pilot'|'challenge'/);
    expect(seed).not.toMatch(/traction_events|releases|decisions/);
    expect(seed).toMatch(/,'demo',/);
  });

  it("the splitter itself handles dollar quotes, strings and comments (negative control for the tests above)", () => {
    const got = splitStatements("-- c\nselect 'a;b' ; create function f() returns int as $$ select 1; select 2; $$ language sql; /* x; */ select 3");
    expect(got).toEqual(["select 'a;b'", "create function f()returns int as $$ select 1; select 2; $$ language sql", "select 3"]);
    // and a changed statement is detected: the subsequence check must fail when a doc statement is altered
    expect(isSubsequence(["select 1"], ["select 2"]).ok).toBe(false);
  });
});
