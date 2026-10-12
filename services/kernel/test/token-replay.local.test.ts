// SEC-14 / RT-31 replay protection with the database as the source of truth (migration 0004), against a real local
// Postgres (V-15: a local pass is a smoke test). Two independent NonceCaches stand in for two kernel instances.
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NonceCache } from "../src/auth/nonce-cache";
import { pgNonceStore } from "../src/auth/nonce-store";
import { createClockGuard, measureClockSkewSeconds } from "../src/auth/clock-guard";
import { CLOCK_SKEW_SECONDS, mintServiceToken, verifyServiceToken, verifyServiceTokenDurable } from "../src/auth/token";
import type { VerifyContext } from "../src/auth/token";
import { createPgDb } from "../src/db/pool";
import { dbSuiteEnabled, openTestDb, run } from "./helpers/pgdb";
import type { TestDb } from "./helpers/pgdb";

const enabled = dbSuiteEnabled("token-replay.local");
const SECRET = randomBytes(32).toString("hex");
const T1 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const T2 = "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8";
const now = (): number => Math.floor(Date.now() / 1000);

/** The nonce of a token (its payload is not secret; tests read it to inspect the store). */
function nonceOf(token: string): string {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8")) as { nonce: string };
  return payload.nonce;
}
const instance = (): VerifyContext => ({ secret: SECRET, profile: "production", nowSec: now(), nonces: new NonceCache() });
const mint = (tenantId = T1, ttlSec = 30) => mintServiceToken({ secret: SECRET, profile: "production", tenantId, nowSec: now(), ttlSec });

describe.skipIf(!enabled)("local: durable nonce store", () => {
  let t: TestDb;
  beforeAll(() => {
    t = openTestDb();
  }, 120_000);
  afterAll(async () => {
    await t.close();
  }, 120_000);

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
    expect(await store.claim(nonce, T1, exp)).toBe("OK");
    expect(await store.claim(nonce, T2, exp)).toBe("REPLAYED");
    const rows = await t.db.query<{ tenant_id: string }>("select tenant_id from service_token_nonces where nonce = $1", [nonce]);
    expect(rows.rows.map((r) => r.tenant_id)).toEqual([T1]);
  });

  it("concurrent claims of one nonce: exactly one wins", async () => {
    const store = pgNonceStore(t.db);
    const nonce = randomBytes(18).toString("base64url");
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(nonce, T1, now() + 30)));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
  });

  it("any database error rejects (fail closed): STORE_ERROR, never ok", async () => {
    const dead = createPgDb({ connectionString: "postgres://postgres@127.0.0.1:1/none", max: 1 });
    const r = await verifyServiceTokenDurable(mint(), instance(), pgNonceStore(dead));
    expect(r).toEqual({ ok: false, reason: "STORE_ERROR" });
    await dead.close();
  });

  it("the DATABASE clock is authoritative: a token expired by the DB clock is refused even when the app clock says it is valid", async () => {
    const store = pgNonceStore(t.db);
    // Token minted an hour ago (exp = an hour ago + 30 s); the app clock lags the DB by an hour, so it still looks live.
    const old = now() - 3600;
    const token = mintServiceToken({ secret: SECRET, profile: "production", tenantId: T1, nowSec: old, ttlSec: 30 });
    const laggingApp: VerifyContext = { ...instance(), nowSec: old + 1 };
    expect(verifyServiceToken(token, { ...laggingApp, nonces: new NonceCache() }).ok).toBe(true); // app alone would accept
    expect(await verifyServiceTokenDurable(token, laggingApp, store)).toEqual({ ok: false, reason: "EXPIRED" });
    expect((await t.db.query("select 1 from service_token_nonces where nonce = $1", [nonceOf(token)])).rowCount).toBe(0); // never stored
  });

  it("an over-long exp (beyond the 60 s ceiling + 5 s skew by the DB clock) is refused", async () => {
    const store = pgNonceStore(t.db);
    // App clock 10 minutes AHEAD of the DB: the token is within 60 s of ITS clock but ~10 min out by the DB clock.
    const ahead = now() + 600;
    const token = mintServiceToken({ secret: SECRET, profile: "production", tenantId: T1, nowSec: ahead, ttlSec: 30 });
    const aheadApp: VerifyContext = { ...instance(), nowSec: ahead };
    expect(await verifyServiceTokenDurable(token, aheadApp, store)).toEqual({ ok: false, reason: "TTL_TOO_LONG" });
    expect(await store.claim(randomBytes(18).toString("base64url"), T1, now() + 66)).toBe("TTL_TOO_LONG");
    expect(await store.claim(randomBytes(18).toString("base64url"), T1, now() + 60)).toBe("OK"); // boundary control
  });

  it("purge-then-replay of an expired token is refused (the fail-open the review found)", async () => {
    const store = pgNonceStore(t.db);
    const minted = now();
    const token = mintServiceToken({ secret: SECRET, profile: "production", tenantId: T1, nowSec: minted, ttlSec: 2 });
    const appAtMint: VerifyContext = { ...instance(), nowSec: minted + 1 }; // app clock lags: still thinks it is valid later
    expect((await verifyServiceTokenDurable(token, appAtMint, store)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 3200)); // the token is now expired by the DB clock
    run(t.name, `update service_token_nonces set expires_at = now() - interval '10 minutes' where nonce = '${nonceOf(token)}';`); // 5+ minutes pass
    expect(await store.claim(randomBytes(18).toString("base64url"), T1, now() + 30)).toBe("OK"); // triggers the purge
    expect((await t.db.query("select 1 from service_token_nonces where nonce = $1", [nonceOf(token)])).rowCount).toBe(0); // row is gone
    expect(await verifyServiceTokenDurable(token, { ...appAtMint, nonces: new NonceCache() }, store)).toEqual({ ok: false, reason: "EXPIRED" });
  });

  it("the clock guard trips on a simulated app-clock offset and passes within the allowance (injected clock)", async () => {
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const guard = (offsetMs: number) => createClockGuard({ db: t.db, clock: () => Date.now() + offsetMs, logger: log, cacheMs: 0 });
    await expect(guard(0).assertSynced()).resolves.toBeUndefined();
    await expect(guard(2000).assertSynced()).resolves.toBeUndefined();
    await expect(guard(-2000).assertSynced()).resolves.toBeUndefined();
    for (const off of [CLOCK_SKEW_SECONDS * 1000 + 3000, -(CLOCK_SKEW_SECONDS * 1000 + 3000), 3_600_000]) {
      await expect(guard(off).assertSynced(), String(off)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
    const dead = createPgDb({ connectionString: "postgres://postgres@127.0.0.1:1/none", max: 1 });
    await expect(createClockGuard({ db: dead, clock: () => Date.now(), logger: log, cacheMs: 0 }).assertSynced()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await dead.close();
    expect(Math.abs(await measureClockSkewSeconds(t.db, () => Date.now()))).toBeLessThan(2);
  });

  it("expired nonces are purged on later claims, and the API roles cannot touch the table or function", async () => {
    run(t.name, `insert into service_token_nonces (nonce, tenant_id, expires_at) values ('${"e".repeat(20)}', '${T1}', now() - interval '1 hour');`);
    expect(await pgNonceStore(t.db).claim(randomBytes(18).toString("base64url"), T1, now() + 30)).toBe("OK");
    const left = await t.db.query("select 1 from service_token_nonces where nonce = $1", ["e".repeat(20)]);
    expect(left.rowCount).toBe(0);
    for (const role of ["anon", "authenticated"]) {
      expect(() => run(t.name, "select * from service_token_nonces;", { role: role as "anon" })).toThrow(/permission denied/);
      expect(() => run(t.name, `select claim_service_token_nonce('${"z".repeat(20)}', '${T1}', now());`, { role: role as "anon" })).toThrow(/permission denied/);
    }
  });
});
