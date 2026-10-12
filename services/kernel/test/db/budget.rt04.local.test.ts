// WP-09: RT-04 / INV-21, the LLM budget ledger in Postgres: atomic reserve, cache hits are free, exhaustion refuses and writes nothing.
// "local": local Postgres with a Supabase-like bootstrap (harness.ts, VERIFY(V-15)); Supabase / CI is authoritative.
import { afterAll, describe, expect, it, vi } from "vitest";
import { applyMigrations, createDb, dbSuiteEnabled, dropDb, execFails, run, runSqlAsync, scalar } from "./harness";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const enabled = dbSuiteEnabled("budget.rt04.local");
const dbs: string[] = [];
const fresh = (): string => {
  const db = createDb();
  dbs.push(db);
  applyMigrations(db);
  return db;
};
afterAll(() => dbs.forEach(dropDb));

const SVC = { role: "service_role" } as const;
const USD = 1_000_000n; // micro-USD per USD
const reserve = (db: string, principal: string, cost: bigint, globalCap: bigint, principalCap: bigint): string =>
  scalar(db, `select llm_budget_reserve('${principal}', 'extractor-a', 100, 50, ${cost}, ${globalCap}, ${principalCap});`, SVC);
const total = (db: string): string => scalar(db, `select coalesce(sum(est_usd), 0)::text from llm_budget_ledger;`);
const rowCount = (db: string): number => Number(scalar(db, `select count(*) from llm_budget_ledger;`));

describe.skipIf(!enabled)("local RT-04: atomic LLM budget ledger", () => {
  it("local: grants reservations until the global daily cap and then refuses (NULL), writing nothing for a refusal", () => {
    const db = fresh();
    const granted: string[] = [];
    for (let i = 0; i < 5; i++) granted.push(reserve(db, `p${i}`, USD, 5n * USD, 5n * USD));
    expect(granted.every((g) => Number(g) > 0)).toBe(true);
    expect(total(db)).toBe("5.000000");
    expect(reserve(db, "p9", 1n, 5n * USD, 5n * USD)).toBe(""); // even 1 micro-USD over the cap is refused
    expect(rowCount(db)).toBe(5);
    expect(total(db)).toBe("5.000000");
  });

  it("local: the per-principal cap binds independently of the global cap", () => {
    const db = fresh();
    expect(Number(reserve(db, "alice", USD, 100n * USD, 2n * USD))).toBeGreaterThan(0);
    expect(Number(reserve(db, "alice", USD, 100n * USD, 2n * USD))).toBeGreaterThan(0);
    expect(reserve(db, "alice", USD, 100n * USD, 2n * USD)).toBe("");
    expect(Number(reserve(db, "bob", USD, 100n * USD, 2n * USD))).toBeGreaterThan(0); // another principal is unaffected
  });

  it("local: 50 parallel reservations cannot overspend the global budget (exactly cap / cost are granted)", async () => {
    const db = fresh();
    const calls = Array.from({ length: 50 }, (_, i) =>
      runSqlAsync(db, `select llm_budget_reserve('racer${i}', 'extractor-a', 10, 10, ${USD}, ${10n * USD}, ${10n * USD});`, SVC),
    );
    const results = await Promise.all(calls);
    for (const r of results) expect(r.ok, r.stderr).toBe(true);
    const granted = results.filter((r) => r.stdout.trim() !== "").length;
    expect(granted).toBe(10);
    expect(total(db)).toBe("10.000000");
    expect(rowCount(db)).toBe(10);
  });

  it("local: 50 parallel reservations by ONE principal respect the per-principal cap", async () => {
    const db = fresh();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => runSqlAsync(db, `select llm_budget_reserve('same', 'extractor-a', 10, 10, ${USD}, ${100n * USD}, ${4n * USD});`, SVC)),
    );
    expect(results.filter((r) => r.stdout.trim() !== "").length).toBe(4);
    expect(total(db)).toBe("4.000000");
  });

  it("local: negative control: a check-then-insert reservation (no lock) DOES overspend under the same race, so the race test can fail", async () => {
    const db = fresh();
    run(
      db,
      `create function naive_reserve(p text, cost bigint, cap bigint) returns bigint language plpgsql as $$
       declare s numeric; v bigint;
       begin
         select coalesce(sum(est_usd), 0) * 1000000 into s from llm_budget_ledger where day = (now() at time zone 'utc')::date;
         if s + cost > cap then return null; end if;
         perform pg_sleep(1.5);
         insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd)
           values ((now() at time zone 'utc')::date, p, 'r', 1, 1, cost::numeric / 1000000) returning id into v;
         return v;
       end $$;`,
    );
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => runSqlAsync(db, `select naive_reserve('n${i}', ${USD}, ${3n * USD});`, SVC)));
    for (const r of results) expect(r.ok, r.stderr).toBe(true);
    const granted = results.filter((r) => r.stdout.trim() !== "").length;
    expect(granted).toBeGreaterThan(3); // the cap was 3
  });

  it("local: cache hits are recorded but never billed, and never consume budget", () => {
    const db = fresh();
    expect(Number(reserve(db, "c", USD, USD, USD))).toBeGreaterThan(0);
    expect(reserve(db, "c", USD, USD, USD)).toBe(""); // exhausted
    for (let i = 0; i < 3; i++) expect(Number(scalar(db, `select llm_budget_record_cache_hit('c', 'extractor-a');`, SVC))).toBeGreaterThan(0);
    expect(total(db)).toBe("1.000000");
    expect(scalar(db, `select count(*) from llm_budget_ledger where cache_hit and est_usd = 0;`)).toBe("3");
    // the table itself refuses a billed cache hit, even for a direct insert by the service role
    expect(execFails(db, `insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd, cache_hit) values (current_date, 'c', 'r', 0, 0, 0.5, true);`, SVC)).toMatch(/llm_budget_ledger_cache_hit_free/);
    expect(execFails(db, `insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd) values (current_date, 'c', 'r', 0, 0, -1);`, SVC)).toMatch(/llm_budget_ledger_nonneg/);
  });

  it("local: commit settles a reservation downwards only; it frees headroom; a larger actual, an unknown id and a cache hit are errors", () => {
    const db = fresh();
    const id = reserve(db, "s", 2n * USD, 2n * USD, 2n * USD);
    expect(reserve(db, "s", 1n, 2n * USD, 2n * USD)).toBe(""); // full
    run(db, `select llm_budget_commit(${id}, 40, 20, ${USD / 2n});`, SVC);
    expect(total(db)).toBe("0.500000");
    expect(scalar(db, `select tokens_in || '/' || tokens_out from llm_budget_ledger where id = ${id};`)).toBe("40/20");
    expect(Number(reserve(db, "s", USD, 2n * USD, 2n * USD))).toBeGreaterThan(0); // freed headroom is usable
    expect(execFails(db, `select llm_budget_commit(${id}, 1, 1, ${USD});`, SVC)).toMatch(/exceeds the reservation/);
    expect(execFails(db, `select llm_budget_commit(999999, 1, 1, 1);`, SVC)).toMatch(/unknown reservation/);
    const hit = scalar(db, `select llm_budget_record_cache_hit('s', 'r');`, SVC);
    expect(execFails(db, `select llm_budget_commit(${hit}, 1, 1, 0);`, SVC)).toMatch(/cache hit has no reservation/);
    expect(total(db)).toBe("1.500000");
  });

  it("local: invalid inputs fail closed with an error instead of booking", () => {
    const db = fresh();
    const bad = [
      `select llm_budget_reserve('', 'r', 1, 1, 1, 10, 10);`,
      `select llm_budget_reserve('p', '', 1, 1, 1, 10, 10);`,
      `select llm_budget_reserve(null, 'r', 1, 1, 1, 10, 10);`,
      `select llm_budget_reserve('p', 'r', -1, 1, 1, 10, 10);`,
      `select llm_budget_reserve('p', 'r', 1, 1, -1, 10, 10);`,
      `select llm_budget_reserve('p', 'r', 1, 1, 1, -10, 10);`,
      `select llm_budget_reserve('p', 'r', 1, 1, 1, 10, null);`,
      `select llm_budget_reserve('p', 'r', 1, 1, 10000000000, 99999999999, 99999999999);`, // would overflow numeric(10,6)
    ];
    for (const s of bad) expect(execFails(db, s, SVC), s).toMatch(/llm_budget_reserve/);
    expect(rowCount(db)).toBe(0);
  });

  it("local: the budget day belongs to the database clock: no date parameter exists and rows are stamped with the UTC date", () => {
    const db = fresh();
    expect(scalar(db, `select pg_get_function_arguments('llm_budget_reserve(text,text,int,int,bigint,bigint,bigint)'::regprocedure);`)).not.toMatch(/\bdate\b/);
    const id = reserve(db, "d", USD, USD, USD);
    expect(scalar(db, `select day = (now() at time zone 'utc')::date from llm_budget_ledger where id = ${id};`)).toBe("t");
    // yesterday's spend does not count against today's budget
    run(db, `insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd) values ((now() at time zone 'utc')::date - 1, 'old', 'r', 1, 1, 9);`);
    expect(Number(reserve(db, "e", USD, 2n * USD, 2n * USD))).toBeGreaterThan(0);
  });
});
