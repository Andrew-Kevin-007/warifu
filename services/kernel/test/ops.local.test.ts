// Operator commands (src/ops.ts) against a real local Postgres: migrate is idempotent, refuses an edited migration and a
// profile flip; tenant creation validates the policy against the deployed vault and the owner. Throwaway databases only.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { getAddress } from "viem";
import { afterAll, describe, expect, it } from "vitest";
import { createTenant, migrate, runOps, OpsError } from "../src/ops";
import type { SqlClient } from "../src/ops";
import { MIGRATIONS_DIR, REPO_ROOT, createDb, dropDb, migrationFiles } from "./db/harness";
import { dbSuiteEnabled, urlFor } from "./helpers/pgdb";

const enabled = dbSuiteEnabled("ops.local");
const POLICY = readFileSync(join(REPO_ROOT, "packages", "policy", "test", "fixtures", "spec-04-section7.yaml"), "utf8");
const addr = (b: string) => getAddress(`0x${b.repeat(20)}`);
const OWNER = addr("a2");

function deploymentsFile(dir: string, caps = { perTxCap: "100000000", dailyCap: "200000000", hourlyCap: "25000000", humanThreshold: "50000000" }): string {
  const group = (seed: string, owner: string) => ({
    vault: addr(`${seed}1`), token: addr("aa"), tokenDecimals: 6, owner, kernelSigner: addr(`${seed}3`), guardian: addr(`${seed}4`),
    caps, payeeChangeDelay: 172800, signerChangeDelay: 86400, deployer: addr(`${seed}5`), chainId: 5042002,
    configHash: `0x${"11".repeat(32)}`, runtimeCodeHash: `0x${"22".repeat(32)}`, artifactPath: "contracts/out/SymbolonVault.sol/SymbolonVault.json", gitSha: "abc1234",
  });
  const p = join(dir, "testnet.json");
  writeFileSync(p, JSON.stringify({ schema: "symbolon-deployments/1", network: "testnet", chainId: 5042002, production: group("b", OWNER), sandbox: group("c", addr("c2")) }));
  return p;
}

describe.skipIf(!enabled)("local: ops migrate + tenant (operator setup)", () => {
  const cleanup: Array<() => void> = [];
  afterAll(() => cleanup.forEach((f) => f()), 120_000); // dropping throwaway databases is slow under load

  async function fresh(): Promise<{ c: pg.Client; name: string }> {
    const name = createDb({ bootstrap: true });
    const c = new pg.Client({ connectionString: urlFor(name) });
    await c.connect();
    cleanup.push(() => dropDb(name));
    return { c, name };
  }
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), "warifu-ops-"));
    cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    return d;
  };

  it("migrate applies everything once, stamps the profile, and is a no-op the second time", async () => {
    const { c } = await fresh();
    const first = await migrate(c as unknown as SqlClient, MIGRATIONS_DIR, "production");
    expect(first.applied).toEqual(migrationFiles());
    const second = await migrate(c as unknown as SqlClient, MIGRATIONS_DIR, "production");
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied.length).toBe(migrationFiles().length);
    expect((await c.query("select profile from deployment_profile")).rows).toEqual([{ profile: "production" }]);
    await expect(migrate(c as unknown as SqlClient, MIGRATIONS_DIR, "sandbox")).rejects.toThrow(/stamped production/);
    await c.end();
  });

  it("migrate refuses an applied migration whose file changed, and rolls back a failing one", async () => {
    const { c } = await fresh();
    const dir = tmp();
    mkdirSync(join(dir, "m"));
    for (const f of migrationFiles()) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, "m", f));
    await migrate(c as unknown as SqlClient, join(dir, "m"), "sandbox");
    const first = migrationFiles()[0] as string;
    writeFileSync(join(dir, "m", first), readFileSync(join(dir, "m", first), "utf8") + "\n-- edited\n");
    await expect(migrate(c as unknown as SqlClient, join(dir, "m"), "sandbox")).rejects.toThrow(/changed after it was applied/);
    writeFileSync(join(dir, "m", first), readFileSync(join(MIGRATIONS_DIR, first), "utf8"));
    writeFileSync(join(dir, "m", "9999_broken.sql"), "create table ok_before_error (id int); select * from no_such_table;");
    await expect(migrate(c as unknown as SqlClient, join(dir, "m"), "sandbox")).rejects.toThrow(/9999_broken.sql failed/);
    expect((await c.query("select to_regclass('ok_before_error') as t")).rows[0]).toEqual({ t: null });
    await c.end();
  });

  it("tenant: inserts a pilot whose policy fits the vault; refuses a looser policy, a wrong owner and kind/profile mixes", async () => {
    const { c } = await fresh();
    await migrate(c as unknown as SqlClient, MIGRATIONS_DIR, "production");
    const dir = tmp();
    const deploymentsPath = deploymentsFile(dir);
    const base = { name: "Edith Studio", owner: OWNER, deploymentsPath, policyYaml: POLICY, profile: "production" as const, kind: "pilot" as const };
    const r = await createTenant(c as unknown as SqlClient, base);
    expect(r).toMatchObject({ network: "testnet", chainId: 5042002, vault: addr("b1") });
    const row = (await c.query("select kind, network, vault_address, policy_hash from tenants where id = $1", [r.tenantId])).rows[0];
    expect(row).toEqual({ kind: "pilot", network: "testnet", vault_address: addr("b1").toLowerCase(), policy_hash: r.policyHash });

    const tight = deploymentsFile(tmp(), { perTxCap: "10000000", dailyCap: "200000000", hourlyCap: "25000000", humanThreshold: "50000000" });
    await expect(createTenant(c as unknown as SqlClient, { ...base, deploymentsPath: tight })).rejects.toThrow(OpsError);
    await expect(createTenant(c as unknown as SqlClient, { ...base, owner: addr("99") })).rejects.toThrow(/vault owner/);
    await expect(createTenant(c as unknown as SqlClient, { ...base, kind: "challenge" })).rejects.toThrow(/sandbox/);
    await expect(createTenant(c as unknown as SqlClient, { ...base, profile: "sandbox", owner: addr("c2") })).rejects.toThrow(/never pilot/);
    await expect(createTenant(c as unknown as SqlClient, { ...base, name: "<b>x</b>" })).rejects.toThrow(/--name/);
    expect((await c.query("select count(*)::int as n from tenants")).rows[0]).toEqual({ n: 1 });
    await c.end();
  });

  it("CLI: needs DATABASE_URL from the environment and prints only the tenant id line", async () => {
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), migrationsDir: MIGRATIONS_DIR, connect: async () => { throw new Error("not reached"); } };
    expect(await runOps(["migrate", "--profile", "production"], {}, io)).toBe(2);
    expect(await runOps(["nope"], { DATABASE_URL: "postgres://x" }, io)).toBe(2);
    expect(out.join("\n")).toMatch(/DATABASE_URL must be set/);
  });
});
