// WP-09: challenge tables in a sandbox DB: untrusted-text bounds, public_challenge_stats (aggregate only), retention purge.
// "local": local Postgres with a Supabase-like bootstrap (harness.ts, VERIFY(V-15)); Supabase / CI is authoritative.
import { afterAll, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { applyFile, applyMigrations, createDb, dbSuiteEnabled, dropDb, errorsOf, execFails, rows, run, scalar, SUPABASE_DIR } from "./harness";
import { attemptSql, hex32, insertScenario, setProfile } from "./fixtures";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const enabled = dbSuiteEnabled("challenge.local");
const dbs: string[] = [];
const fresh = (profile: "production" | "sandbox"): string => {
  const db = createDb();
  dbs.push(db);
  applyMigrations(db);
  setProfile(db, profile);
  return db;
};
afterAll(() => dbs.forEach(dropDb));

const STATS_SQL = join(SUPABASE_DIR, "sandbox", "public_challenge_stats.sql");
const q = (s: string): string => `'${s}'`;

describe.skipIf(!enabled)("local challenge tables", () => {
  it("local: attacker-controlled columns are bounded and validated in the database (valid row accepted, each bad variant refused)", () => {
    const db = fresh("sandbox");
    insertScenario(db);
    run(db, attemptSql()); // control: a valid row goes in
    const bad: Record<string, Record<string, string>> = {
      "excerpt over 240 chars": { excerpt: q("x".repeat(241)) },
      "text_length over 4096": { text_length: "4097" },
      "negative text_length": { text_length: "-1" },
      "full_text over 4096 bytes": { full_text: q("y".repeat(4097)) },
      "text_hash not lowercase 0x+64 hex": { text_hash: q("0xABC") },
      "ip_hash malformed": { ip_hash: q("1.2.3.4") },
      "receipt_hash malformed": { receipt_hash: q("0x12") },
      "tx_hash malformed": { tx_hash: q("deadbeef") },
      "unknown verdict": { verdict: q("APPROVE") },
      "unknown oracle predicate": { oracle_predicates: `'{O9}'::text[]` },
      "unknown oracle result": { oracle_result: q("MAYBE") },
      "unknown source": { source: q("robot") },
      "unknown scenario": { scenario_id: q("S-Z") },
    };
    for (const [name, over] of Object.entries(bad)) expect(execFails(db, attemptSql(over)), name).toMatch(/violates|check constraint|foreign key/);
    expect(scalar(db, `select count(*) from challenge_attempts;`)).toBe("1");
    // boundary values are accepted: exactly 240 chars, exactly 4096 bytes
    run(db, attemptSql({ excerpt: q("x".repeat(240)), full_text: q("y".repeat(4096)), text_length: "4096" }));
    expect(scalar(db, `select count(*) from challenge_attempts;`)).toBe("2");
  });

  it("local: public_challenge_stats counts correctly, exposes aggregates only, and anon cannot read the base table", () => {
    const db = fresh("sandbox");
    insertScenario(db);
    expect(applyFile(db, STATS_SQL).ok).toBe(true);
    const ipA = hex32(0xa1);
    const ipB = hex32(0xa2);
    const same = hex32(0xbeef);
    run(
      db,
      [
        attemptSql({ source: q("human"), ip_hash: q(ipA), text_hash: q(same), verdict: q("REJECT"), reasons: `'{AMOUNT_MISMATCH,PAYEE_MISMATCH}'::text[]` }),
        attemptSql({ source: q("human"), ip_hash: q(ipA), text_hash: q(same), verdict: q("REJECT"), reasons: `'{AMOUNT_MISMATCH}'::text[]` }), // same text, same scenario: one distinct
        attemptSql({ source: q("human"), ip_hash: q(ipB), verdict: q("RELEASE"), oracle_result: q("LOSS"), oracle_predicates: `'{O1,O3}'::text[]`, reasons: `'{}'::text[]` }),
        attemptSql({ source: q("house"), ip_hash: "null", verdict: q("HOLD"), reasons: `'{AMOUNT_MISMATCH}'::text[]` }),
        attemptSql({ source: q("oneclick"), ip_hash: "null", verdict: q("ESCALATE"), benign_control: "true" }),
        attemptSql({ source: q("oneclick"), ip_hash: "null", verdict: q("REJECT"), benign_control: "true" }),
      ].join("\n"),
    );
    const [s] = rows<Record<string, unknown>>(db, `select * from public_challenge_stats`, { role: "anon" });
    expect(s).toMatchObject({
      attempts_human: 3,
      attempts_distinct_human: 2,
      attempts_house: 1,
      attempts_oneclick: 2,
      outcome_release: 1,
      outcome_hold: 1,
      outcome_escalate: 1,
      outcome_reject: 3,
      outcome_replay: 0,
      loss_events_total: 1,
      loss_o1: 1,
      loss_o2: 0,
      loss_o3: 1,
      benign_n: 2,
      benign_false_rejects: 1,
      unique_attackers: 2,
    });
    expect(s?.["top_reason_codes"]).toEqual([
      { code: "AMOUNT_MISMATCH", count: 5 },
      { code: "PAYEE_MISMATCH", count: 1 },
    ]);
    // aggregates only: no attempt-level column, no text
    expect(Object.keys(s ?? {})).not.toEqual(expect.arrayContaining(["excerpt"]));
    expect(JSON.stringify(s)).not.toMatch(/excerpt|full text|ip_hash|0x/);
    expect(errorsOf(db, ["select count(*) from challenge_attempts;"], { role: "anon" })[0]).toMatch(/permission denied/);
  });

  it("local: the stats view cannot be created in a production or unprovisioned DB", () => {
    const prod = fresh("production");
    const r = applyFile(prod, STATS_SQL);
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/may only be created in a sandbox DB \(deployment_profile = production\)/);
    const bare = createDb();
    dbs.push(bare);
    applyMigrations(bare);
    expect(applyFile(bare, STATS_SQL).stderr).toMatch(/deployment_profile = unset/);
  });

  it("local: challenge_purge_expired nulls full_text after 30 days and ip_hash after 7 days, and nothing else", () => {
    const db = fresh("sandbox");
    insertScenario(db);
    const at = (days: number) => `now() - interval '${days} days'`;
    run(
      db,
      [
        attemptSql({ created_at: at(40), text_hash: q(hex32(1)) }),
        attemptSql({ created_at: at(10), text_hash: q(hex32(2)) }),
        attemptSql({ created_at: at(1), text_hash: q(hex32(3)) }),
      ].join("\n"),
    );
    const state = () => rows<{ n: string; full: boolean; ip: boolean }>(db, `select text_hash as n, full_text is not null as full, ip_hash is not null as ip from challenge_attempts order by text_hash`);
    expect(state().map((r) => [r.full, r.ip])).toEqual([[true, true], [true, true], [true, true]]);
    expect(scalar(db, `select * from challenge_purge_expired();`, { role: "service_role" })).toBe("1|2");
    expect(state().map((r) => [r.full, r.ip])).toEqual([[false, false], [true, false], [true, true]]);
    // the audit columns survive the purge
    expect(scalar(db, `select count(*) from challenge_attempts where text_hash is not null and excerpt is not null and verdict is not null;`)).toBe("3");
    // a second run finds nothing more
    expect(scalar(db, `select * from challenge_purge_expired();`, { role: "service_role" })).toBe("0|0");
    // negative control: an explicit "now" in the past leaves everything alone (the rule is relative to the clock it is given)
    expect(scalar(db, `select * from challenge_purge_expired(now() - interval '365 days');`, { role: "service_role" })).toBe("0|0");
  });
});
