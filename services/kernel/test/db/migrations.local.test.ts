// WP-09: migrations apply cleanly, from empty, into fresh databases; catalog-level invariants.
// "local": runs against the portable local Postgres with a Supabase-like bootstrap (see harness.ts, VERIFY(V-15)).
// `supabase db reset` itself was NOT run; Supabase / CI is authoritative.
import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { applyFile, applyMigrations, createDb, dbSuiteEnabled, dropDb, execFails, migrationFiles, MIGRATIONS_DIR, rows, run, scalar } from "./harness";
import { setProfile } from "./fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const enabled = dbSuiteEnabled("migrations.local");
const dbs: string[] = [];
const fresh = (opts?: { bootstrap?: boolean }): string => {
  const db = createDb(opts);
  dbs.push(db);
  return db;
};
afterAll(() => dbs.forEach(dropDb));

describe.skipIf(!enabled)("local migrations", () => {
  it("local: every migration applies cleanly from an empty database, in order", () => {
    const db = fresh();
    applyMigrations(db);
    expect(migrationFiles()).toEqual(["0001_init.sql", "0002_v2.sql", "0003_hardening.sql", "0004_service_token_nonces.sql", "0005_engagement_service.sql", "0006_circle_webhooks.sql", "0007_release_path.sql", "0008_reconciler.sql"]);
    expect(Number(scalar(db, `select count(*) from pg_tables where schemaname = 'public';`))).toBe(33); // + reconciler_ledger (0008)
  });

  it("local: the same migrations re-apply into a second fresh database (no hidden state in the first)", () => {
    const a = fresh();
    const b = fresh();
    applyMigrations(a);
    applyMigrations(b);
    const shape = (db: string) => scalar(db, `select md5(string_agg(table_name || '.' || column_name || ':' || data_type, ',' order by table_name, column_name)) from information_schema.columns where table_schema = 'public';`);
    expect(shape(a)).toBe(shape(b));
  });

  it("local: migrations are not idempotent, a second run of 0001 fails (so an edited-in-place file would be noticed)", () => {
    const db = fresh();
    applyMigrations(db);
    const r = applyFile(db, join(MIGRATIONS_DIR, "0001_init.sql"));
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/already exists/);
  });

  it("local: RLS is enabled on every public table and there is no policy at all (deny by default)", () => {
    const db = fresh();
    applyMigrations(db);
    const q = `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by 1`;
    expect(rows(db, q)).toEqual([]);
    expect(Number(scalar(db, `select count(*) from pg_policies;`))).toBe(0);
    expect(Number(scalar(db, `select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relforcerowsecurity;`))).toBe(0);
    // negative control: the detector sees a table without RLS
    run(db, `create table leak_probe (x int);`);
    expect(rows<{ relname: string }>(db, q).map((r) => r.relname)).toEqual(["leak_probe"]);
  });

  it("local: no float, real or money column anywhere; every *_base_units / bound column is numeric with scale 0", () => {
    const db = fresh();
    applyMigrations(db);
    expect(rows(db, `select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type in ('real', 'double precision', 'money')`)).toEqual([]);
    const money = rows<{ table_name: string; column_name: string; data_type: string; numeric_scale: number }>(
      db,
      `select c.table_name, c.column_name, c.data_type, c.numeric_scale
       from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
       where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and (c.column_name like '%base_units%' or c.column_name in ('bound_24h', 'bound_7d'))`,
    );
    expect(money.map((m) => `${m.table_name}.${m.column_name}`).sort()).toEqual([
      "approvals.amount_base_units", "attack_results.loss_base_units", "blast_reports.bound_24h", "blast_reports.bound_7d", "decisions.amount_base_units",
      "decisions.release_amount_base_units", "engagements.cap_base_units", "milestones.amount_base_units", "reconciler_ledger.deposits_base_units", "traction_events.amount_base_units",
    ]);
    for (const m of money) {
      expect(m.data_type, `${m.table_name}.${m.column_name}`).toBe("numeric");
      expect(m.numeric_scale, `${m.table_name}.${m.column_name}`).toBe(0);
    }
  });

  it("local: 0002 covers every docs/05 3b item (columns, tables, views, trigger)", () => {
    const db = fresh();
    applyMigrations(db);
    const cols = (t: string) => rows<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = '${t}'`).map((r) => r.column_name);
    expect(cols("tenants")).toContain("kind");
    for (const c of ["normalized_hash", "blob_sha256", "received_at"]) expect(cols("documents")).toContain(c);
    for (const c of ["release_amount_base_units", "plan_id", "planner_fallback", "invoice_received_at"]) expect(cols("decisions")).toContain(c);
    for (const c of ["suite", "holdout_seed_hash", "trials"]) expect(cols("attack_runs")).toContain(c);
    for (const t of ["deployment_profile", "llm_budget_ledger", "challenge_scenarios", "challenge_attempts", "certificates", "replay_bundles"]) expect(cols(t).length, t).toBeGreaterThan(0);
    for (const v of ["releases_public", "public_pilot_stats", "public_traction_summary"]) expect(cols(v).length, v).toBeGreaterThan(0);
    expect(scalar(db, `select count(*) from pg_trigger where tgname = 'tenants_kind_guard' and not tgisinternal;`)).toBe("1");
    // public_challenge_stats is created only by the sandbox provisioning step, never by a migration
    expect(cols("public_challenge_stats")).toEqual([]);
    // attack target constraint now b0/b1/b2/symbolon
    const def = scalar(db, `select pg_get_constraintdef(oid) from pg_constraint where conname = 'attack_results_target_check';`);
    for (const t of ["b0", "b1", "b2", "symbolon"]) expect(def).toContain(`'${t}'`);
    expect(def).not.toContain("naive");
  });

  it("local: upgrade path: data written under 0001 is migrated by 0002 and 0003 (kind backfill, attack target rename, derived flag)", () => {
    const db = fresh();
    applyFile(db, join(MIGRATIONS_DIR, "0001_init.sql"));
    const tenant = (id: string, internal: boolean) =>
      `insert into tenants (id, name, owner_address, chain_id, network, is_internal, policy, policy_hash)
       values ('${id}', 't-${id.slice(-2)}', '0x1', 1, 'testnet', ${internal}, '{}'::jsonb, '0x0');`;
    run(
      db,
      `${tenant("00000000-0000-4000-8000-000000000001", false)}
       ${tenant("00000000-0000-4000-8000-000000000002", true)}
       insert into attack_runs (run_id, mode) values ('00000000-0000-4000-8000-0000000000a1', 'core');
       insert into attack_results (run_id, attack_id, target, outcome) values
         ('00000000-0000-4000-8000-0000000000a1', 'ATK-01', 'naive', 'LOSS'),
         ('00000000-0000-4000-8000-0000000000a1', 'ATK-01', 'arc-escrow', 'LOSS'),
         ('00000000-0000-4000-8000-0000000000a1', 'ATK-01', 'symbolon', 'BLOCKED');`,
    );
    for (const f of migrationFiles().slice(1)) {
      const r = applyFile(db, join(MIGRATIONS_DIR, f));
      expect(r.ok, r.stderr).toBe(true);
    }
    expect(rows(db, `select kind, is_internal from tenants order by id`)).toEqual([
      { kind: "pilot", is_internal: false },
      { kind: "demo", is_internal: true },
    ]);
    expect(rows<{ target: string }>(db, `select target from attack_results order by id`).map((r) => r.target)).toEqual(["b1", "b0", "symbolon"]);
    expect(execFails(db, `insert into attack_results (run_id, attack_id, target, outcome) values ('00000000-0000-4000-8000-0000000000a1', 'ATK-02', 'naive', 'LOSS');`)).toMatch(/attack_results_target_check/);
    // the profile is still unset after the upgrade, so new tenants are refused until provisioning writes it
    expect(execFails(db, `insert into tenants (name, owner_address, chain_id, network, policy, policy_hash) values ('x', '0x1', 1, 'testnet', '{}', '0x0');`)).toMatch(/deployment_profile not set/);
    setProfile(db, "production");
  });
});
