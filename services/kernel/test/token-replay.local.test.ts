// SEC-14 / RT-31 replay protection with the database as the source of truth (migration 0004), against a real local
// Postgres (V-15: a local pass is a smoke test). Two independent NonceCaches stand in for two kernel instances.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NonceCache } from "../src/auth/nonce-cache";
import { pgNonceStore } from "../src/auth/nonce-store";
import { mintServiceToken, verifyServiceTokenDurable } from "../src/auth/token";
import type { VerifyContext } from "../src/auth/token";
import { createPgDb } from "../src/db/pool";
import { dbSuiteEnabled, openTestDb, run } from "./helpers/pgdb";
import type { TestDb } from "./helpers/pgdb";

const enabled = dbSuiteEnabled("token-replay.local");
const SECRET = randomBytes(32).toString("hex");
const T1 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const T2 = "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8";
const now = (): number => Math.floor(Date.now() / 1000);
const instance = (): VerifyContext => ({ secret: SECRET, profile: "production", nowSec: now(), nonces: new NonceCache() });
const mint = (tenantId = T1, ttlSec = 30) => mintServiceToken({ secret: SECRET, profile: "production", tenantId, nowSec: now(), ttlSec });

describe.skipIf(!enabled)("local: durable nonce store", () => {
  let t: TestDb;
  beforeAll(() => {
    t = openTestDb();
  });
  afterAll(async () => {
    await t.close();
  });

  it("a token is accepted once and refused on a SECOND instance sharing the database", async () => {
    const store = pgNonceStore(t.db);
    const token = mint();
    expect((await verifyServiceTokenDurable(token, instance(), store)).ok).toBe(true);
    // Fresh in-memory cache = another process. Only the database knows the nonce.
    expect(await verifyServiceTokenDurable(token, instance(), store)).toEqual({ ok: false, reason: "REPLAYED" });
    expect((await verifyServiceTokenDurable(mint(), instance(), store)).ok).toBe(true); // negative control: a new nonce passes
  });

  it("stores the tenant with the nonce, and a nonce is single-use across tenants", async () => {
    const store = pgNonceStore(t.db);
    const nonce = randomBytes(18).toString("base64url");
    const exp = now() + 30;
    expect(await store.claim(nonce, T1, exp)).toBe(true);
    expect(await store.claim(nonce, T2, exp)).toBe(false);
    const rows = await t.db.query<{ tenant_id: string }>("select tenant_id from service_token_nonces where nonce = $1", [nonce]);
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([T1]);
  });

  it("concurrent claims of one nonce: exactly one wins", async () => {
    const store = pgNonceStore(t.db);
    const nonce = randomBytes(18).toString("base64url");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(nonce, T1, now() + 30)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("any database error rejects (fail closed): STORE_ERROR, never ok", async () => {
    const dead = createPgDb({ connectionString: "postgres://postgres@127.0.0.1:1/none", max: 1 });
    const r = await verifyServiceTokenDurable(mint(), instance(), pgNonceStore(dead));
    expect(r).toEqual({ ok: false, reason: "STORE_ERROR" });
    await dead.close();
  });

  it("expired nonces are purged on later claims, and the API roles cannot touch the table or function", async () => {
    run(t.name, `insert into service_token_nonces (nonce, tenant_id, expires_at) values ('${"e".repeat(20)}', '${T1}', now() - interval '1 hour');`);
    expect(await pgNonceStore(t.db).claim(randomBytes(18).toString("base64url"), T1, now() + 30)).toBe(true);
    const left = await t.db.query("select 1 from service_token_nonces where nonce = $1", ["e".repeat(20)]);
    expect(left.rowCount).toBe(0);
    for (const role of ["anon", "authenticated"]) {
      expect(() => run(t.name, "select * from service_token_nonces;", { role: role as "anon" })).toThrow(/permission denied/);
      expect(() => run(t.name, `select claim_service_token_nonce('${"z".repeat(20)}', '${T1}', now());`, { role: role as "anon" })).toThrow(/permission denied/);
    }
  });
});
