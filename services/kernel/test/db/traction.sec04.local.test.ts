// WP-09: SEC-04 (a) view test, (b) trigger test; RT-09 / INV-17 (attack traffic is never traction); INV-16 profile guard.
// "local": a Supabase-like bootstrap on a local Postgres (harness.ts, VERIFY(V-15)); Supabase / CI is authoritative.
import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { applyFile, applyMigrations, createDb, dbSuiteEnabled, dropDb, execFails, rows, run, scalar, snapshot, SUPABASE_DIR } from "./harness";
import { attemptSql, insertDecisionChain, insertScenario, insertTenant, insertTraction, setProfile, uuid } from "./fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const enabled = dbSuiteEnabled("traction.sec04.local");
const dbs: string[] = [];
const fresh = (profile?: "production" | "sandbox"): string => {
  const db = createDb();
  dbs.push(db);
  applyMigrations(db);
  if (profile !== undefined) setProfile(db, profile);
  return db;
};
afterAll(() => dbs.forEach(dropDb));

const TRACTION_VIEWS = ["public_pilot_stats", "public_traction_summary"];
const snap = (db: string): string => TRACTION_VIEWS.map((v) => snapshot(db, `select * from ${v}`)).join("\n");

const P1 = uuid(0x201);
const P2 = uuid(0x202);
const C1 = uuid(0x211);
const D1 = uuid(0x221);
const D2 = uuid(0x222);

describe.skipIf(!enabled)("local SEC-04a: challenge / demo rows leave the traction views unchanged (RT-09, INV-17)", () => {
  it("local: inserting challenge and demo tenants, releases, traction events and attempts changes neither public_pilot_stats nor public_traction_summary", () => {
    const db = fresh("production");
    insertTenant(db, { id: P1, kind: "pilot", network: "mainnet" });
    insertDecisionChain(db, { tenantId: P1, amount: 1_000_000n, releaseAmount: 900_000n, releaseStatus: "CONFIRMED" });
    insertDecisionChain(db, { tenantId: P1, amount: 777n, releaseStatus: "SUBMITTED" }); // not confirmed: never counted
    insertTraction(db, { tenantId: P1, network: "mainnet", amount: 1_000_000n });
    insertTraction(db, { tenantId: P1, network: "testnet", amount: 500_000n });
    insertTraction(db, { tenantId: P1, network: "mainnet", amount: 9_999n, internal: true }); // self-dealing: excluded
    run(db, `insert into blast_reports (tenant_id, threat_model, policy_hash, vault_config, bound_24h, bound_7d, trials, violations, report) values (null, 'T3c', '0x0', '{}', 1, 1, 1, 0, '{}');`);

    const before = snap(db);
    // exact expectations, so "unchanged" is not "unchanged and empty"
    expect(rows(db, `select * from public_pilot_stats`)).toEqual([{ network: "mainnet", businesses: 1, releases: 1, value_base_units: 900000 }]);
    expect(rows(db, `select * from public_traction_summary`)).toEqual([
      { businesses_onboarded: 1, businesses_mainnet: 1, real_payments: 2, mainnet_value_base_units: 1000000, testnet_value_base_units: 500000, audits_run: 1 },
    ]);

    // SEC-04a: the profile trigger is disabled for THIS test only, to let challenge rows exist in a production-profile scratch DB.
    run(
      db,
      `alter table tenants disable trigger tenants_kind_guard;
       alter table challenge_scenarios disable trigger challenge_scenarios_sandbox_only;
       alter table challenge_attempts disable trigger challenge_attempts_sandbox_only;`,
    );
    insertTenant(db, { id: C1, kind: "challenge", network: "mainnet" });
    insertTenant(db, { id: D1, kind: "demo", network: "mainnet" });
    insertTenant(db, { id: D2, kind: "demo", network: "testnet" });
    for (const t of [C1, D1, D2]) {
      insertDecisionChain(db, { tenantId: t, amount: 5_000_000_000n, releaseStatus: "CONFIRMED" });
      insertTraction(db, { tenantId: t, network: "mainnet", amount: 5_000_000_000n });
      insertTraction(db, { tenantId: t, network: "testnet", amount: 5_000_000_000n });
    }
    insertScenario(db);
    for (let i = 0; i < 5; i++) run(db, attemptSql({ source: i % 2 === 0 ? "'human'" : "'house'" }));
    expect(Number(scalar(db, `select count(*) from tenants where kind <> 'pilot';`))).toBe(3);

    expect(snap(db)).toBe(before);

    // CONTROL: a real pilot release does change the views, so the equality above is a meaningful check.
    insertTenant(db, { id: P2, kind: "pilot", network: "testnet" });
    insertDecisionChain(db, { tenantId: P2, amount: 42n, releaseStatus: "CONFIRMED" });
    insertTraction(db, { tenantId: P2, network: "testnet", amount: 42n });
    expect(snap(db)).not.toBe(before);
  });

  it("local: negative control: a traction view WITHOUT the kind filter does change when demo rows arrive (the test can fail)", () => {
    const db = fresh("production");
    insertTenant(db, { id: P1, kind: "pilot", network: "mainnet" });
    insertDecisionChain(db, { tenantId: P1, amount: 10n, releaseStatus: "CONFIRMED" });
    run(
      db,
      `create view mutant_pilot_stats as
         select t.network, count(distinct t.id) as businesses, count(r.*) as releases, coalesce(sum(r.amount_base_units),0) as value_base_units
         from tenants t left join releases_public r on r.tenant_id = t.id group by t.network;`,
    );
    const mutant = () => snapshot(db, `select * from mutant_pilot_stats`);
    const real = () => snapshot(db, `select * from public_pilot_stats`);
    const [m0, r0] = [mutant(), real()];
    insertTenant(db, { id: D1, kind: "demo", network: "mainnet" });
    insertDecisionChain(db, { tenantId: D1, amount: 1_000_000n, releaseStatus: "CONFIRMED" });
    expect(mutant()).not.toBe(m0);
    expect(real()).toBe(r0);
  });

  it("local: setting is_internal directly cannot make a demo/challenge tenant count as a pilot (insert, update, trigger bypass)", () => {
    const db = fresh("production");
    insertTenant(db, { id: P1, kind: "pilot" });
    const base = snap(db);
    // insert a demo tenant claiming is_internal = false
    run(db, `insert into tenants (id, name, owner_address, chain_id, network, kind, is_internal, policy, policy_hash) values ('${D1}', 'd', '0x1', 1, 'testnet', 'demo', false, '{}', '0x0');`);
    expect(scalar(db, `select is_internal from tenants where id = '${D1}';`)).toBe("t");
    // update the flag, and the flag together with an unrelated column
    run(db, `update tenants set is_internal = false where id = '${D1}';`);
    expect(scalar(db, `select is_internal from tenants where id = '${D1}';`)).toBe("t");
    run(db, `update tenants set is_internal = false, name = 'renamed' where id = '${D1}';`);
    expect(scalar(db, `select is_internal from tenants where id = '${D1}';`)).toBe("t");
    // and the reverse: a pilot cannot be hidden as internal
    run(db, `update tenants set is_internal = true where id = '${P1}';`);
    expect(scalar(db, `select is_internal from tenants where id = '${P1}';`)).toBe("f");
    insertDecisionChain(db, { tenantId: D1, amount: 1_000_000n, releaseStatus: "CONFIRMED" });
    insertTraction(db, { tenantId: D1, network: "mainnet", amount: 1_000_000n });
    expect(snap(db)).toBe(base);
    // even with every user trigger disabled, the CHECK constraint refuses a flag that disagrees with kind
    run(db, `alter table tenants disable trigger user;`);
    expect(execFails(db, `update tenants set is_internal = false where id = '${D1}';`)).toMatch(/tenants_internal_matches_kind/);
    expect(execFails(db, `insert into tenants (name, owner_address, chain_id, network, kind, is_internal, policy, policy_hash) values ('x', '0x1', 1, 'testnet', 'challenge', false, '{}', '0x0');`)).toMatch(/tenants_internal_matches_kind/);
  });

  it("local: no public view reads is_internal (kind is the single source for traction)", () => {
    const db = fresh("production");
    const v = rows<{ viewname: string; definition: string }>(db, `select viewname, definition from pg_views where schemaname = 'public'`);
    expect(v.length).toBeGreaterThanOrEqual(6);
    for (const x of v) expect(x.definition, x.viewname).not.toMatch(/is_internal/);
  });

  it("local: the seed is demo data, idempotent, and never counted as traction", () => {
    const db = fresh();
    for (let i = 0; i < 2; i++) {
      const r = applyFile(db, join(SUPABASE_DIR, "seed.sql"));
      expect(r.ok, r.stderr).toBe(true);
    }
    expect(rows(db, `select kind, is_internal, network from tenants`)).toEqual([{ kind: "demo", is_internal: true, network: "local" }]);
    expect(rows(db, `select * from public_pilot_stats`)).toEqual([]);
    expect(rows(db, `select * from public_traction_summary`)).toEqual([
      { businesses_onboarded: 0, businesses_mainnet: 0, real_payments: 0, mainnet_value_base_units: 0, testnet_value_base_units: 0, audits_run: 0 },
    ]);
  });
});

describe.skipIf(!enabled)("local SEC-04b: the deployment_profile trigger refuses cross-profile rows (INV-16)", () => {
  const tenantSql = (id: string, kind: string) => `insert into tenants (id, name, owner_address, chain_id, network, kind, policy, policy_hash) values ('${id}', 'n', '0x1', 1, 'testnet', '${kind}', '{}', '0x0');`;

  it("local: production DB refuses challenge tenants, kind flips to challenge, challenge scenarios and attempts; accepts pilot and demo", () => {
    const db = fresh("production");
    expect(execFails(db, tenantSql(C1, "challenge"))).toMatch(/challenge tenants only in sandbox DB/);
    run(db, tenantSql(P1, "pilot") + tenantSql(D1, "demo"));
    expect(execFails(db, `update tenants set kind = 'challenge' where id = '${P1}';`)).toMatch(/challenge tenants only in sandbox DB/);
    expect(execFails(db, `insert into challenge_scenarios (scenario_id, spec, oracle_version) values ('S-A', '{}', 'oracle-v1');`)).toMatch(/challenge data only in sandbox DB/);
    // the attempt guard on its own: let the scenario in (guard off for that one statement), then try the attempt with the guard on
    run(db, `alter table challenge_scenarios disable trigger challenge_scenarios_sandbox_only;`);
    insertScenario(db);
    expect(execFails(db, attemptSql())).toMatch(/challenge data only in sandbox DB/);
    expect(scalar(db, `select count(*) from challenge_attempts;`)).toBe("0");
  });

  it("local: sandbox DB refuses pilot tenants (insert and kind flip); accepts challenge and demo, scenarios and attempts", () => {
    const db = fresh("sandbox");
    expect(execFails(db, tenantSql(P1, "pilot"))).toMatch(/pilot tenants never in sandbox DB/);
    run(db, tenantSql(C1, "challenge") + tenantSql(D1, "demo"));
    expect(execFails(db, `update tenants set kind = 'pilot' where id = '${C1}';`)).toMatch(/pilot tenants never in sandbox DB/);
    insertScenario(db);
    run(db, attemptSql());
    expect(scalar(db, `select count(*) from challenge_attempts;`)).toBe("1");
    expect(scalar(db, `select is_internal from tenants where id = '${C1}';`)).toBe("t");
  });

  it("local: with no profile written, tenants and challenge rows are refused (fail closed)", () => {
    const db = fresh();
    expect(execFails(db, tenantSql(P1, "pilot"))).toMatch(/deployment_profile not set/);
    expect(execFails(db, tenantSql(D1, "demo"))).toMatch(/deployment_profile not set/);
    expect(execFails(db, `insert into challenge_scenarios (scenario_id, spec, oracle_version) values ('S-A', '{}', 'oracle-v1');`)).toMatch(/deployment_profile not set/);
  });

  it("local: the profile is write-once: no update, delete, truncate, second row or unknown value", () => {
    const db = fresh("production");
    expect(execFails(db, `update deployment_profile set profile = 'sandbox';`)).toMatch(/write-once/);
    expect(execFails(db, `delete from deployment_profile;`)).toMatch(/write-once/);
    expect(execFails(db, `truncate deployment_profile;`)).toMatch(/write-once/);
    expect(execFails(db, `insert into deployment_profile (id, profile) values (2, 'sandbox');`)).toMatch(/deployment_profile_id_check|violates check/);
    expect(execFails(db, `insert into deployment_profile (id, profile) values (1, 'sandbox');`)).toMatch(/duplicate key/);
    expect(execFails(fresh(), `insert into deployment_profile (id, profile) values (1, 'staging');`)).toMatch(/violates check constraint/);
    expect(scalar(db, `select profile from deployment_profile;`)).toBe("production");
  });
});
