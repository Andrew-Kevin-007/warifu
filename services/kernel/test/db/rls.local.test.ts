// WP-09: anon / authenticated cannot read base tables; the public views return sanitized rows only.
// "local": a Supabase-like bootstrap on a local Postgres (harness.ts, VERIFY(V-15)). The bootstrap applies Supabase's default
// privileges (GRANT ALL on new relations, views and functions to anon/authenticated/service_role) BEFORE the migrations,
// so these tests would catch an owner-run view or function that leaked. Supabase / CI is authoritative; `supabase db reset` was not run.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, createDb, dbSuiteEnabled, dropDb, errorsOf, execFails, rows, run, scalar } from "./harness";
import { hex32, insertDecisionChain, insertTenant, setProfile, T_DEMO, T_OPTIN, T_PILOT, uuid } from "./fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const enabled = dbSuiteEnabled("rls.local");
const dbs: string[] = [];
afterAll(() => dbs.forEach(dropDb));

const ALLOW = ["public_attack_latest", "public_blast_latest", "public_pilot_stats", "public_receipts", "public_traction_summary"];
const ROLES = ["anon", "authenticated"] as const;
const HOSTILE = [
  "<script>alert(1)</script>",
  "<img onerror=x>",
  "http://evil.example",
  "SECRET-INVOICE-BODY",
  "SECRET-EXPLANATION",
  "SECRET-RECEIPT-BODY",
  "0xPAYEE-SECRET-ADDRESS",
  "ENGAGEMENT-SECRET-ID",
];

let db = "";
let hostileReceipt = "";
let optinReceipt = "";
let demoReceipt = "";
let pendingReceipt = "";

beforeAll(() => {
  if (!enabled) return;
  db = createDb();
  dbs.push(db);
  applyMigrations(db);
  setProfile(db, "production");
  insertTenant(db, { id: T_PILOT, name: "Secret Pilot Co <b>", kind: "pilot", network: "mainnet" });
  insertTenant(db, { id: T_OPTIN, name: "Opt-in Pilot", kind: "pilot", network: "testnet", publicAmounts: true });
  insertTenant(db, { id: T_DEMO, name: "Demo Tenant", kind: "demo" });
  hostileReceipt = insertDecisionChain(db, {
    tenantId: T_PILOT,
    amount: 123_456_789n,
    releaseStatus: "CONFIRMED",
    reasons: ["AMOUNT_MISMATCH", "<script>alert(1)</script>", "lowercase"],
    checks: JSON.stringify([
      { id: "K-07", name: "<script>alert(1)</script>", status: "FAIL", code: "AMOUNT_MISMATCH", detail: "<img onerror=x>", refs: ["http://evil.example"] },
      { id: "<b>K-1</b>", status: "<i>", code: "lowercase code", detail: "x" },
      "not-an-object",
    ]),
  }).receiptHash;
  optinReceipt = insertDecisionChain(db, { tenantId: T_OPTIN, amount: 5_000_000n, releaseStatus: "CONFIRMED" }).receiptHash;
  demoReceipt = insertDecisionChain(db, { tenantId: T_DEMO, amount: 1n, releaseStatus: "CONFIRMED" }).receiptHash;
  pendingReceipt = insertDecisionChain(db, { tenantId: T_OPTIN, amount: 7_000_000n, releaseStatus: "SUBMITTED", txHash: hex32(0xdead) }).receiptHash;
  run(
    db,
    `insert into attack_runs (run_id, mode, finished_at, git_sha, suite) values
       ('${uuid(0xa1)}', 'core', now() - interval '2 hours', 'abc1234', 'core'),
       ('${uuid(0xa2)}', 'holdout', now() - interval '1 hour', 'abc1234', 'holdout');
     insert into attack_results (run_id, attack_id, target, outcome, loss_base_units, checks_fired, detail) values
       ('${uuid(0xa1)}', 'ATK-01', 'b2', 'BLOCKED', 0, '{K-07}', '{"note":"<script>alert(1)</script> DETAIL-SECRET"}'),
       ('${uuid(0xa2)}', 'HOLD-77', 'b2', 'LOSS', 99, '{K-99}', '{"note":"HOLDOUT-SECRET"}');
     insert into blast_reports (tenant_id, threat_model, policy_hash, vault_config, bound_24h, bound_7d, trials, violations, report) values
       (null, 'T3c', '${hex32(1)}', '{"vault":"0xVAULT-PUBLIC"}', 100, 700, 1000, 0, '{"body":"REPORT-BODY-SECRET"}'),
       ('${T_PILOT}', 'T3c', '${hex32(2)}', '{"vault":"0xTENANT-VAULT-SECRET"}', 5, 35, 10, 0, '{}');`,
  );
});

describe.skipIf(!enabled)("local RLS: base tables are closed to anon and authenticated", () => {
  const tables = () => rows<{ relname: string }>(db, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`).map((r) => r.relname);

  it("local: every base table denies SELECT and writes to anon and authenticated, with and without JWT claims", () => {
    const names = tables();
    expect(names.length).toBe(27); // 26 + service_token_nonces (0004)
    const stmts = names.flatMap((t) => [`select count(*) from ${t};`, `delete from ${t};`, `insert into ${t} default values;`]);
    for (const role of ROLES) {
      for (const claims of [undefined, { role: "service_role", sub: uuid(1), tenant_id: T_PILOT }]) {
        const errs = errorsOf(db, stmts, claims === undefined ? { role } : { role, claims });
        expect(errs.length, `${role}${claims === undefined ? "" : " + forged claims"}: every statement must fail`).toBe(stmts.length);
        for (const e of errs) expect(e).toMatch(/^permission denied for (table|relation) /);
      }
    }
    // negative control for errorsOf: a statement that is allowed yields no error entry
    expect(errorsOf(db, ["select 1;", "select count(*) from nonexistent_table_zz;"], { role: "anon" }).length).toBe(1);
  });

  it("local: control: service_role (BYPASSRLS) reads the same tables, so the denials above are real denials", () => {
    expect(scalar(db, `select count(*) from tenants;`, { role: "service_role" })).toBe("3");
    expect(Number(scalar(db, `select count(*) from decisions;`, { role: "service_role" }))).toBe(4);
  });

  it("local: enumerate every relation in public: anon and authenticated can SELECT exactly the five public views and have no other privilege anywhere", () => {
    for (const role of ROLES) {
      const readable = rows<{ relname: string }>(
        db,
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind in ('r','v','m','p','f') and has_table_privilege('${role}', c.oid, 'SELECT') order by 1`,
      ).map((r) => r.relname);
      expect(readable, role).toEqual(ALLOW);
      const otherPrivs = rows(
        db,
        `select c.relname, p.priv from pg_class c join pg_namespace n on n.oid = c.relnamespace
         cross join (values ('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) as p(priv)
         where n.nspname = 'public' and c.relkind in ('r','v','m','p','f') and has_table_privilege('${role}', c.oid, p.priv)`,
      );
      expect(otherPrivs, `${role} write-ish privileges`).toEqual([]);
      expect(rows(db, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'S' and (case when c.relkind = 'S' and n.nspname = 'public' then has_sequence_privilege('${role}', c.oid, 'USAGE') end)`), `${role} sequences`).toEqual([]);
      expect(rows(db, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('${role}', p.oid, 'EXECUTE')`), `${role} functions`).toEqual([]);
    }
    // the helper view and the profile table specifically
    for (const role of ROLES) {
      expect(execFails(db, `select * from releases_public;`, { role })).toMatch(/permission denied/);
      expect(execFails(db, `select * from deployment_profile;`, { role })).toMatch(/permission denied/);
    }
  });

  it("local: negative control: the enumeration test sees a leak (an extra grant, a function left executable)", () => {
    const scratch = createDb();
    dbs.push(scratch);
    applyMigrations(scratch);
    const readable = (role: string) => rows<{ relname: string }>(scratch, `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','v') and has_table_privilege('${role}', c.oid, 'SELECT') order by 1`).map((r) => r.relname);
    expect(readable("anon")).toEqual(ALLOW);
    run(scratch, `grant select on releases_public to anon;`);
    expect(readable("anon")).toEqual([...ALLOW, "releases_public"].sort());
    run(scratch, `grant execute on function llm_budget_reserve(text, text, int, int, bigint, bigint, bigint) to anon;`);
    expect(rows(scratch, `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')`)).toEqual([{ proname: "llm_budget_reserve" }]);
  });

  it("local: negative control: the Supabase default-privilege hazard is real in this harness, and the migrations are what closes it", () => {
    const bare = createDb(); // bootstrap only, no migration
    dbs.push(bare);
    run(bare, `create table t_default (x int); create view v_default as select 1 as x; create function f_default() returns int language sql as 'select 1';`);
    expect(scalar(bare, `select has_table_privilege('anon', 't_default', 'SELECT');`)).toBe("t");
    expect(scalar(bare, `select has_table_privilege('anon', 'v_default', 'SELECT');`)).toBe("t");
    expect(scalar(bare, `select has_function_privilege('anon', 'f_default()', 'EXECUTE');`)).toBe("t");
    // after the migrations, anything created later by the owner is closed by default (0001 default-privilege revokes)
    run(db, `create table t_later (x int); create view v_later as select 1 as x;`);
    expect(scalar(db, `select has_table_privilege('anon', 't_later', 'SELECT') or has_table_privilege('anon', 'v_later', 'SELECT');`)).toBe("f");
    run(db, `drop view v_later; drop table t_later;`);
  });

  it("local: RLS is a wall on its own: with a table grant restored, anon still sees zero rows; a policy is what would open it", () => {
    const scratch = createDb();
    dbs.push(scratch);
    applyMigrations(scratch);
    setProfile(scratch, "production");
    insertTenant(scratch, { id: T_PILOT, kind: "pilot" });
    run(scratch, `grant select on tenants to anon;`);
    expect(scalar(scratch, `select count(*) from tenants;`, { role: "anon" })).toBe("0");
    expect(scalar(scratch, `select count(*) from tenants;`, { role: "service_role" })).toBe("1");
    run(scratch, `create policy open_probe on tenants for select to anon using (true);`);
    expect(scalar(scratch, `select count(*) from tenants;`, { role: "anon" })).toBe("1");
  });

  it("local: the budget and purge functions are not callable by anon or authenticated; service_role can", () => {
    for (const role of ROLES) {
      expect(execFails(db, `select llm_budget_reserve('p', 'r', 1, 1, 1, 10, 10);`, { role })).toMatch(/permission denied for function/);
      expect(execFails(db, `select llm_budget_record_cache_hit('p', 'r');`, { role })).toMatch(/permission denied for function/);
      expect(execFails(db, `select * from challenge_purge_expired();`, { role })).toMatch(/permission denied for function/);
    }
    expect(Number(scalar(db, `select llm_budget_reserve('p', 'r', 1, 1, 1, 10, 10);`, { role: "service_role" }))).toBeGreaterThan(0);
  });
});

describe.skipIf(!enabled)("local RLS: public views return sanitized rows only", () => {
  const cols = (v: string) => rows<{ column_name: string }>(db, `select column_name from information_schema.columns where table_schema = 'public' and table_name = '${v}' order by ordinal_position`).map((r) => r.column_name);

  it("local: each view exposes exactly its allow-listed columns", () => {
    expect(cols("public_receipts")).toEqual(["receipt_hash", "verdict", "checks", "reasons", "policy_hash", "tx_hash", "amount_base_units", "issued_at", "network", "demo"]);
    expect(cols("public_pilot_stats")).toEqual(["network", "businesses", "releases", "value_base_units"]);
    expect(cols("public_traction_summary")).toEqual(["businesses_onboarded", "businesses_mainnet", "real_payments", "mainnet_value_base_units", "testnet_value_base_units", "audits_run"]);
    expect(cols("public_attack_latest")).toEqual(["mode", "finished_at", "git_sha", "attack_id", "target", "outcome", "loss_base_units", "checks_fired"]);
    expect(cols("public_blast_latest")).toEqual(["threat_model", "policy_hash", "bound_24h", "bound_7d", "trials", "violations", "created_at"]);
  });

  it("local: no public view reads the derived is_internal flag any more (kind is the source of truth)", () => {
    for (const v of ALLOW) expect(scalar(db, `select pg_get_viewdef('${v}'::regclass);`), v).not.toMatch(/is_internal/);
  });

  it("local: public_receipts: hostile jsonb/text never reaches the output; identifiers are re-validated; no tenant, payee, engagement or invoice data", () => {
    for (const role of ROLES) {
      const all = rows<Record<string, unknown>>(db, `select * from public_receipts order by receipt_hash`, { role });
      expect(all.length).toBe(4);
      const text = JSON.stringify(all);
      for (const bad of [...HOSTILE, "Secret Pilot Co", "Opt-in Pilot", "Demo Tenant", "<", ">", "lowercase"]) expect(text, `${role}: ${bad}`).not.toContain(bad);
      const r = all.find((x) => x["receipt_hash"] === hostileReceipt);
      expect(r?.["verdict"]).toBe("RELEASE");
      expect(r?.["reasons"]).toEqual(["AMOUNT_MISMATCH"]);
      expect(r?.["checks"]).toEqual([
        { id: "K-07", status: "FAIL", code: "AMOUNT_MISMATCH" },
        { id: null, status: null, code: null },
        { id: null, status: null, code: null },
      ]);
    }
  });

  it("local: public_receipts: amounts only for opted-in tenants; tx hash only for confirmed releases; demo flag from kind", () => {
    const all = rows<Record<string, unknown>>(db, `select * from public_receipts`, { role: "anon" });
    const by = (h: string) => all.find((x) => x["receipt_hash"] === h);
    expect(by(hostileReceipt)?.["amount_base_units"]).toBeNull(); // tenant did not opt in
    expect(String(by(optinReceipt)?.["amount_base_units"])).toBe("5000000"); // opted in
    expect(by(optinReceipt)?.["tx_hash"]).not.toBeNull();
    expect(by(pendingReceipt)?.["tx_hash"]).toBeNull(); // SUBMITTED, not confirmed
    expect(JSON.stringify(all)).not.toContain(hex32(0xdead));
    expect(by(demoReceipt)?.["demo"]).toBe(true);
    expect(by(hostileReceipt)?.["demo"]).toBe(false);
    expect(JSON.stringify(all)).not.toContain("123456789"); // the non-opted-in amount
  });

  it("local: public_attack_latest: core suite only, no detail text, no run id", () => {
    const out = rows<Record<string, unknown>>(db, `select * from public_attack_latest`, { role: "anon" });
    expect(out).toEqual([{ mode: "core", finished_at: expect.any(String), git_sha: "abc1234", attack_id: "ATK-01", target: "b2", outcome: "BLOCKED", loss_base_units: 0, checks_fired: ["K-07"] }]);
    const text = JSON.stringify(out);
    for (const bad of ["DETAIL-SECRET", "HOLDOUT-SECRET", "HOLD-77", "<script>", uuid(0xa1)]) expect(text).not.toContain(bad);
  });

  it("local: public_blast_latest: tenant-less reports only; no vault config, no report body, no tenant report", () => {
    const out = rows<Record<string, unknown>>(db, `select * from public_blast_latest`, { role: "authenticated" });
    expect(out.length).toBe(1);
    const text = JSON.stringify(out);
    for (const bad of ["0xVAULT-PUBLIC", "REPORT-BODY-SECRET", "0xTENANT-VAULT-SECRET", hex32(2)]) expect(text).not.toContain(bad);
    expect(out[0]?.["policy_hash"]).toBe(hex32(1));
  });

  it("local: the aggregate views never show a tenant name, address or id", () => {
    for (const v of ["public_pilot_stats", "public_traction_summary"]) {
      const text = JSON.stringify(rows(db, `select * from ${v}`, { role: "anon" }));
      for (const bad of ["Secret Pilot Co", "Opt-in", T_PILOT, T_OPTIN, "0x00000000000000000000000000000000000d3a01"]) expect(text).not.toContain(bad);
    }
  });

  it("local: views are read-only for the API roles", () => {
    for (const v of ALLOW) expect(execFails(db, `delete from ${v};`, { role: "anon" })).toMatch(/permission denied|cannot delete|not automatically updatable/);
  });
});
