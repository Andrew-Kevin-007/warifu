// Test harness for the WP-09 database tests. It drives a LOCAL, portable PostgreSQL with `psql` (no new dependency).
//
// IMPORTANT (VERIFY(V-15)): a local Postgres is not Supabase. It has no `auth` schema, no PostgREST and none of
// Supabase's default grants. `bootstrapSupabaseLike` below recreates just enough of that (a stub `auth.uid()` / `auth.jwt()`
// reading `request.jwt.claims`, the `public` schema grants, and Supabase's default privileges that GRANT ALL on new
// tables to anon / authenticated / service_role) so that the migrations are exercised against the hostile default.
// This bootstrap lives ONLY here, never in a migration. Tests that depend on it say "local" in their names:
// a local pass is a smoke test, and `supabase db reset` in CI/Supabase is authoritative. It was NOT run for this WP.
//
// Safety: every database is created by this harness with a unique `symbolon_test_<pid>_<rand>` name and only those names are
// ever dropped. It connects to the maintenance database `postgres`, never to `symbolon_local`, and refuses port 5432
// (a different, pre-existing Postgres service).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../../../..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");
export const SUPABASE_DIR = join(REPO_ROOT, "supabase");

const WINDOWS_PSQL = "D:\\tools\\postgres\\pgsql\\bin\\psql.exe";

export interface PgConfig {
  readonly psql: string;
  readonly host: string;
  readonly port: string;
  readonly user: string;
}

function configFromEnv(): PgConfig {
  const psql = process.env["SYMBOLON_PSQL"] ?? (existsSync(WINDOWS_PSQL) ? WINDOWS_PSQL : "psql");
  return {
    psql,
    host: process.env["SYMBOLON_PG_HOST"] ?? "localhost",
    port: process.env["SYMBOLON_PG_PORT"] ?? "54329",
    user: process.env["SYMBOLON_PG_USER"] ?? "postgres",
  };
}

export const pgConfig: PgConfig = configFromEnv();

/** Postgres must be reachable in CI or when REQUIRE_PG=1; otherwise the DB suites skip with a warning. */
export const pgRequired = process.env["REQUIRE_PG"] === "1" || process.env["CI"] === "true";

function baseArgs(db: string): string[] {
  return ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", pgConfig.host, "-p", pgConfig.port, "-U", pgConfig.user, "-d", db];
}

const psqlEnv = { ...process.env, PGOPTIONS: "-c client_min_messages=warning", PGCONNECT_TIMEOUT: "5" };

export interface RunResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

function runSync(db: string, input: string, extra: string[] = []): RunResult {
  const r = spawnSync(pgConfig.psql, [...baseArgs(db), ...extra], { input, encoding: "utf8", env: psqlEnv });
  if (r.error) return { ok: false, stdout: "", stderr: String(r.error.message) };
  return { ok: r.status === 0, stdout: r.stdout, stderr: r.stderr };
}

function runAsync(db: string, input: string, extra: string[] = []): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn(pgConfig.psql, [...baseArgs(db), ...extra], { env: psqlEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", (e) => resolveP({ ok: false, stdout, stderr: stderr + String(e.message) }));
    child.on("close", (code) => resolveP({ ok: code === 0, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** Is a usable Postgres reachable? (Connects to the maintenance DB `postgres` only.) */
export function pgReachable(): { ok: boolean; why: string } {
  if (pgConfig.port === "5432") return { ok: false, why: "port 5432 is a different, pre-existing Postgres service: refusing" };
  const r = runSync("postgres", "select 1;\n", ["-At"]);
  return r.ok && r.stdout.trim() === "1" ? { ok: true, why: "" } : { ok: false, why: r.stderr.trim().split("\n")[0] ?? "unreachable" };
}

/**
 * Decide whether DB suites run. Returns true to run. Skips with a warning when Postgres is missing, unless REQUIRE_PG=1 or
 * CI=true, in which case it throws so the suite fails loudly instead of passing by omission.
 */
export function dbSuiteEnabled(suite: string): boolean {
  const reach = pgReachable();
  if (reach.ok) return true;
  if (pgRequired) throw new Error(`[${suite}] Postgres required (REQUIRE_PG=1 or CI=true) but not reachable: ${reach.why}`);
  console.warn(`[${suite}] Postgres not reachable (${reach.why}): skipping DB tests. Set REQUIRE_PG=1 to make this fatal.`);
  return false;
}

const created = new Set<string>();

export function uniqueDbName(): string {
  return `symbolon_test_${process.pid}_${randomBytes(4).toString("hex")}`;
}

function assertOurs(name: string): void {
  if (!/^symbolon_test_\d+_[0-9a-f]{8}$/.test(name) || !created.has(name)) throw new Error(`refusing to touch database ${name}: not created by this harness`);
}

/** Supabase-like surroundings. Test-only; see the file header. */
export const SUPABASE_LIKE_BOOTSTRAP = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as
  $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create function auth.role() returns text language sql stable as
  $$ select auth.jwt() ->> 'role' $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's platform default: every new table, sequence and function in public is open to the API roles.
alter default privileges for role ${pgConfig.user} in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role ${pgConfig.user} in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges for role ${pgConfig.user} in schema public grant all on functions to anon, authenticated, service_role;
`;

export function createDb(opts: { bootstrap?: boolean } = {}): string {
  const name = uniqueDbName();
  created.add(name);
  const r = runSync("postgres", `create database "${name}";\n`);
  if (!r.ok) throw new Error(`create database failed: ${r.stderr}`);
  if (opts.bootstrap !== false) {
    const b = runSync(name, SUPABASE_LIKE_BOOTSTRAP);
    if (!b.ok) throw new Error(`bootstrap failed: ${b.stderr}`);
  }
  return name;
}

export function dropDb(name: string): void {
  assertOurs(name);
  const r = runSync("postgres", `drop database if exists "${name}" with (force);\n`);
  if (!r.ok) console.warn(`could not drop ${name}: ${r.stderr}`);
  created.delete(name);
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
}

/** Apply one SQL file in a single transaction with ON_ERROR_STOP, as `supabase db reset` applies a migration. */
export function applyFile(db: string, path: string): RunResult {
  assertOurs(db);
  return runSync(db, readFileSync(path, "utf8"), ["-1"]);
}

export function applyMigrations(db: string, upTo?: string): void {
  for (const f of migrationFiles()) {
    if (upTo !== undefined && f > upTo) break;
    const r = applyFile(db, join(MIGRATIONS_DIR, f));
    if (!r.ok) throw new Error(`migration ${f} failed: ${r.stderr}`);
  }
}

export interface SessionOpts {
  /** SET ROLE before the SQL. */
  readonly role?: "anon" | "authenticated" | "service_role";
  /** request.jwt.claims for the session (what PostgREST sets). */
  readonly claims?: Record<string, unknown>;
}

function wrap(sql: string, opts: SessionOpts): string {
  const pre: string[] = [];
  if (opts.claims !== undefined) pre.push(`select set_config('request.jwt.claims', '${JSON.stringify(opts.claims).replace(/'/g, "''")}', false);`);
  if (opts.role !== undefined) pre.push(`set role ${opts.role};`);
  return `${pre.join("\n")}\n${sql}\n`;
}

/** Run statements; throws with psql's stderr on any error. Returns stdout. */
export function run(db: string, sql: string, opts: SessionOpts = {}): string {
  assertOurs(db);
  const r = runSync(db, wrap(sql, opts), ["-At"]);
  if (!r.ok) throw new Error(`SQL failed: ${r.stderr.trim()}\n--- sql ---\n${sql}`);
  return r.stdout;
}

/** Run statements that are expected to fail; returns psql's error text (and fails the test if nothing failed). */
export function runFails(db: string, sql: string, opts: SessionOpts = {}): string {
  assertOurs(db);
  const r = runSync(db, wrap(sql, opts), ["-At"]);
  if (r.ok) throw new Error(`expected an error but the statements succeeded:\n${sql}`);
  return r.stderr;
}

export async function runSqlAsync(db: string, sql: string, opts: SessionOpts = {}): Promise<RunResult> {
  assertOurs(db);
  return runAsync(db, wrap(sql, opts), ["-At"]);
}

/** One scalar value as text (the first column of the first row). */
export function scalar(db: string, sql: string, opts: SessionOpts = {}): string {
  const lines = run(db, sql, opts).split("\n").filter((l) => l !== "");
  return lines.at(-1) ?? "";
}

/** Rows as parsed JSON objects: the query is wrapped in json_agg(row_to_json(...)). */
export function rows<T = Record<string, unknown>>(db: string, query: string, opts: SessionOpts = {}): T[] {
  const out = scalar(db, `select coalesce(json_agg(row_to_json(q)), '[]'::json) from (${query.replace(/;\s*$/, "")}) q;`, opts);
  return JSON.parse(out) as T[];
}

/** Canonical text of a query result, for before/after comparison. */
export function snapshot(db: string, query: string): string {
  return JSON.stringify(rows(db, query));
}
