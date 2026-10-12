// INV-16 defence in depth at process start: the database must be stamped with the profile the process runs as.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StartupError, runStartupChecks } from "../src/startup";
import { dbSuiteEnabled, openTestDb, run } from "./helpers/pgdb";
import type { TestDb } from "./helpers/pgdb";
import { fakeChain } from "./helpers/world";

const enabled = dbSuiteEnabled("startup.local");

describe.skipIf(!enabled)("local: startup checks", () => {
  let prod: TestDb;
  let sand: TestDb;
  beforeAll(() => {
    prod = openTestDb("production");
    sand = openTestDb("sandbox");
  }, 120_000);
  afterAll(async () => {
    await prod.close();
    await sand.close();
  }, 120_000);
  const go = (t: TestDb, profile: "production" | "sandbox", over: { expectedChainId?: number; clockOffsetMs?: number } = {}) =>
    runStartupChecks({ db: t.db, chain: fakeChain(), profile, expectedChainId: over.expectedChainId ?? 31337, clock: () => Date.now() + (over.clockOffsetMs ?? 0) });

  it("passes when the stamp, tenants, chain id and clock all agree (positive controls)", async () => {
    await expect(go(prod, "production")).resolves.toBeUndefined();
    await expect(go(sand, "sandbox")).resolves.toBeUndefined();
  });

  it("S1: a production process on a sandbox-stamped database, or the reverse, refuses to start", async () => {
    await expect(go(sand, "production")).rejects.toMatchObject({ rule: "S1" });
    await expect(go(prod, "sandbox")).rejects.toMatchObject({ rule: "S1" });
  });

  it("S1: an unstamped database refuses to start", async () => {
    run(prod.name, "alter table deployment_profile disable trigger all; delete from deployment_profile; alter table deployment_profile enable trigger all;");
    await expect(go(prod, "production")).rejects.toBeInstanceOf(StartupError);
    run(prod.name, "insert into deployment_profile (id, profile) values (1, 'production');");
  });

  it("S2: a foreign tenant kind in the database refuses to start (challenge tenant in production)", async () => {
    run(prod.name, "alter table tenants disable trigger all; insert into tenants (id, name, owner_address, chain_id, network, kind, policy, policy_hash, is_internal) values ('00000000-0000-4000-8000-0000000000aa', 'x', '0x0', 1, 'local', 'challenge', '{}', '0x00', true); alter table tenants enable trigger all;");
    await expect(go(prod, "production")).rejects.toMatchObject({ rule: "S2" });
    run(prod.name, "delete from tenants where id = '00000000-0000-4000-8000-0000000000aa';");
    await expect(go(prod, "production")).resolves.toBeUndefined();
  });

  it("S3 and S4: a chain-id mismatch and an app/database clock skew refuse to start", async () => {
    await expect(go(prod, "production", { expectedChainId: 5042002 })).rejects.toMatchObject({ rule: "S3" });
    await expect(go(prod, "production", { clockOffsetMs: 600_000 })).rejects.toMatchObject({ rule: "S4" });
  });
});
