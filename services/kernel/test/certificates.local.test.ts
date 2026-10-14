/* eslint-disable @typescript-eslint/no-explicit-any */
// Certificate API (WP-34; docs/16 §7) over a real Postgres. The chain edge is an in-memory fake of the LBC ChainReader (the
// real-vault, real-anvil matrix is in packages/blast-radius/test/lbc/anvil.lbc.test.ts); the service, routes, access rules,
// persistence and the server-side re-check are real. Skips with a warning when local Postgres is unreachable (REQUIRE_PG=1 makes it fatal).
import { normalizePolicy } from "@symbolon/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeChain as LbcFake, SIGNER2, T0, engagement, exampleState, makeState } from "../../../packages/blast-radius/test/lbc/helpers/fake-chain";
import { createBuildLimiter } from "../src/certificates/service";
import { dbSuiteEnabled, openTestDb } from "./helpers/pgdb";
import type { TestDb } from "./helpers/pgdb";
import { CHAIN_ID, OTHER_TENANT, OWNER, POLICY_INPUT, TENANT, VAULT, call, openWorld } from "./helpers/world";
import type { World } from "./helpers/world";
import { mintServiceToken } from "../src/auth/token";
import { createApp } from "../src/app";
import { createClockGuard } from "../src/auth/clock-guard";
import { pgNonceStore } from "../src/auth/nonce-store";
import { noBlobStore } from "../src/blob/store";
import { createLogger } from "../src/log";
import { createKernelSigner } from "../src/receipt/build";
import { Secret } from "../src/secret";
import { generatePrivateKey } from "viem/accounts";
import { TOKEN_SECRET, fakeChain } from "./helpers/world";

const enabled = dbSuiteEnabled("certificates.local");
const GIT = "0123456789abcdef0123456789abcdef01234567";

function lbcChain(): LbcFake {
  // the fake chain's clock: blocks at T0.., and the service clock below is pinned to the same instant
  return new LbcFake().push(100n, exampleState());
}

describe.skipIf(!enabled)("certificate routes", () => {
  let w: World;
  let reader: LbcFake;
  const clockMs = Number(T0 + 10n) * 1000;
  const certApp = (over: Record<string, unknown> = {}) => w.app({ clock: () => clockMs, certificates: { reader, gitSha: GIT, limiter: createBuildLimiter(100, 100), ...over } } as any);
  beforeAll(async () => {
    w = await openWorld();
  }, 120_000);
  afterAll(async () => {
    await w?.close();
  });

  it("answers 501 when certificates are not configured, and 401 without a token", async () => {
    reader = lbcChain();
    expect((await call(w.app(), "GET", `/v1/certificates/${VAULT}`, w.token())).status).toBe(501);
    expect((await call(certApp(), "GET", `/v1/certificates/${VAULT}`, null)).status).toBe(401);
  });

  it("POST build: persists, returns the certificate with a fresh VALID re-check and the UI view; a repeat is idempotent (200)", async () => {
    reader = lbcChain();
    const app = certApp();
    const r = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.certificate.schema).toBe("lbc/1");
    expect(r.json.certificate.validity.status).toBe("VALID");
    expect(r.json.verification.outcome).toBe("VALID");
    expect(r.json.view.headline).toContain("at most $150.00");
    expect(r.json.view.order[0]).toBe("exclusions");
    const rows = await w.t.db.query<{ cert_hash: string; validity_status: string; chain_id: string; block_number: string }>("select cert_hash, validity_status, chain_id::text, block_number::text from certificates");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ cert_hash: r.json.certificate.certHash, validity_status: "VALID", chain_id: String(CHAIN_ID), block_number: "100" });
    const again = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(again.status).toBe(200);
    expect(again.json.certificate.certHash).toBe(r.json.certificate.certHash);
    expect((await w.t.db.query("select 1 from certificates")).rows).toHaveLength(1);
  });

  it("GET latest and GET by hash return the stored document with a CURRENT validity, not the stored status", async () => {
    reader = lbcChain();
    const app = certApp();
    const built = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    const hash = built.json.certificate.certHash;
    const latest = await call(app, "GET", `/v1/certificates/${VAULT}`, w.token());
    expect(latest.status).toBe(200);
    expect(latest.json.verification.outcome).toBe("VALID");
    // a config change on chain: the stored row still says VALID, the API says STALE with a diff
    reader.next({ kernelSigner: SIGNER2 });
    const stale = await call(app, "GET", `/v1/certificates/${VAULT}/${hash}`, w.token());
    expect(stale.status).toBe(200);
    expect(stale.json.certificate.validity).toMatchObject({ status: "STALE", reasons: ["CONFIG_CHANGED"] });
    expect(stale.json.verification.diffs.map((d: any) => d.path)).toContain("inputs.configHash");
    expect(stale.json.view.diff.length).toBeGreaterThan(0);
    const stored = await w.t.db.query<{ validity_status: string }>("select validity_status from certificates where cert_hash = $1", [hash]);
    expect(stored.rows[0]!.validity_status).toBe("VALID");
  });

  it("an unreadable chain gives UNVERIFIED on read and 503 on build; never VALID, never the stored status", async () => {
    reader = lbcChain();
    const app = certApp();
    const built = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(built.status).toBe(201);
    reader.fault = "vaultState";
    const read = await call(app, "GET", `/v1/certificates/${VAULT}`, w.token());
    expect(read.status).toBe(200);
    expect(read.json.verification.outcome).toBe("UNVERIFIED");
    expect(read.json.certificate.validity.status).toBe("UNVERIFIED");
    const rebuild = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(rebuild.status).toBe(503);
    reader.fault = null;
  });

  it("a row altered in the database is caught by the re-check (the server does not trust its own storage)", async () => {
    reader = lbcChain();
    const app = certApp();
    const built = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    const hash = built.json.certificate.certHash;
    const forged = structuredClone(built.json.certificate);
    forged.bounds.T3c.horizons[3].value = "1";
    await w.t.db.query("update certificates set cert = $2::jsonb where cert_hash = $1", [hash, JSON.stringify(forged)]);
    const r = await call(app, "GET", `/v1/certificates/${VAULT}/${hash}`, w.token());
    expect(r.json.verification.outcome).toBe("MISMATCH");
    expect(r.json.certificate.validity.status).toBe("UNVERIFIED");
  });

  it("is tenant scoped: another tenant's vault, an unknown vault and malformed identifiers are all 404", async () => {
    reader = lbcChain();
    const app = certApp();
    await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    // OTHER_TENANT is seeded with the same vault address in the shared world, so use a different token's tenant on a vault it does not own
    const foreign = "0x000000000000000000000000000000000000dEaD";
    expect((await call(app, "GET", `/v1/certificates/${foreign}`, w.token())).status).toBe(404);
    expect((await call(app, "POST", `/v1/certificates/${foreign}/build`, w.token())).status).toBe(404);
    expect((await call(app, "GET", "/v1/certificates/not-an-address", w.token())).status).toBe(404);
    expect((await call(app, "GET", `/v1/certificates/${VAULT}/0x1234`, w.token())).status).toBe(404);
    expect((await call(app, "GET", `/v1/certificates/${VAULT}/0x${"ab".repeat(32)}`, w.token())).status).toBe(404);
    expect((await call(app, "GET", `/v1/certificates/${foreign}`, w.token(OTHER_TENANT))).status).toBe(404);
  });

  it("no certificate yet -> 404 (never an empty VALID)", async () => {
    const fresh = openTestDb("production");
    try {
      await fresh.db.query(
        "insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash) values ($1,'t',$2,$3,$4,'local','pilot',$5::jsonb,$6)",
        [TENANT, OWNER, VAULT, CHAIN_ID, JSON.stringify(normalizePolicy(POLICY_INPUT).policy), normalizePolicy(POLICY_INPUT).policyHash],
      );
      const logger = createLogger({ sink: { write: () => undefined }, secrets: [] });
      const app = createApp({
        profile: "production", db: fresh.db, chain: fakeChain(), signer: createKernelSigner(new Secret(generatePrivateKey())), clock: () => clockMs, logger,
        serviceTokenSecret: TOKEN_SECRET, nonceStore: pgNonceStore(fresh.db), clockGuard: createClockGuard({ db: fresh.db, clock: () => clockMs, logger }), blobs: noBlobStore,
        maxJsonBytes: 262144, maxBlobBytes: 1048576, certificates: { reader: lbcChain(), gitSha: GIT },
      });
      const token = mintServiceToken({ secret: TOKEN_SECRET, profile: "production", tenantId: TENANT, nowSec: Math.floor(Date.now() / 1000) });
      expect((await call(app, "GET", `/v1/certificates/${VAULT}`, token)).status).toBe(404);
    } finally {
      await fresh.close();
    }
  });

  it("POST build is rate limited per vault with Retry-After", async () => {
    reader = lbcChain();
    const app = certApp({ limiter: createBuildLimiter(2, 100, 600) });
    expect((await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token())).status).toBeLessThan(300);
    expect((await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token())).status).toBeLessThan(300);
    const limited = await call(app, "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("a build over a vault state no vault can have is refused (422), not published", async () => {
    reader = new LbcFake().push(100n, makeState({ perTxCap: 0n, engagements: [engagement("z")] }));
    const r = await call(certApp(), "POST", `/v1/certificates/${VAULT}/build`, w.token());
    expect(r.status).toBe(422);
    expect(r.json.error.detail.reason).toBe("INVALID_STATE");
  });
});

describe("limiter", () => {
  it("allows up to the per-vault ceiling inside the window, then names the wait; the window slides", () => {
    const l = createBuildLimiter(2, 10, 60);
    expect(l.take("v", 0)).toBe(0);
    expect(l.take("v", 1000)).toBe(0);
    expect(l.take("v", 2000)).toBe(59);
    expect(l.take("other", 2000)).toBe(0);
    expect(l.take("v", 61_000)).toBe(0);
  });
  it("applies a global ceiling across vaults", () => {
    const l = createBuildLimiter(5, 2, 60);
    expect(l.take("a", 0)).toBe(0);
    expect(l.take("b", 0)).toBe(0);
    expect(l.take("c", 0)).toBeGreaterThan(0);
  });
});

describe.skipIf(!enabled)("sandbox profile: challenge vaults are public, others are not (INV-16/17)", () => {
  let t: TestDb;
  beforeAll(() => {
    t = openTestDb("sandbox");
  });
  afterAll(async () => {
    await t?.close();
  });
  it("any authenticated caller may read a challenge tenant's certificate; a non-challenge vault stays 404", async () => {
    const loaded = normalizePolicy(POLICY_INPUT);
    const CH_TENANT = "7a3f2504-4f89-41d3-9a0c-0305e82c3302";
    const OTHER = "8b4f2504-4f89-41d3-9a0c-0305e82c3303";
    await t.db.query("insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash) values ($1,'challenge',$2,$3,$4,'local','challenge',$5::jsonb,$6)", [CH_TENANT, OWNER, VAULT, CHAIN_ID, JSON.stringify(loaded.policy), loaded.policyHash]);
    const reader = lbcChain();
    const logger = createLogger({ sink: { write: () => undefined }, secrets: [] });
    const app = createApp({
      profile: "sandbox", db: t.db, chain: fakeChain(), signer: createKernelSigner(new Secret(generatePrivateKey())), clock: () => clockMsOf(), logger,
      serviceTokenSecret: TOKEN_SECRET, nonceStore: pgNonceStore(t.db), clockGuard: createClockGuard({ db: t.db, clock: () => clockMsOf(), logger }), blobs: noBlobStore,
      maxJsonBytes: 262144, maxBlobBytes: 1048576, certificates: { reader, gitSha: GIT, limiter: createBuildLimiter(100, 100) },
    });
    const tok = (tenantId: string) => mintServiceToken({ secret: TOKEN_SECRET, profile: "sandbox", tenantId, nowSec: Math.floor(Date.now() / 1000) });
    // a caller that is NOT the challenge tenant (no tenant row at all) can read and build the challenge vault's certificate
    const built = await call(app, "POST", `/v1/certificates/${VAULT}/build`, tok(OTHER));
    expect(built.status, JSON.stringify(built.json)).toBe(201);
    expect((await call(app, "GET", `/v1/certificates/${VAULT}`, tok(OTHER))).json.verification.outcome).toBe("VALID");
    expect((await call(app, "GET", "/v1/certificates/0x000000000000000000000000000000000000dEaD", tok(OTHER))).status).toBe(404);
  });
});

function clockMsOf(): number {
  return Number(T0 + 10n) * 1000;
}
