/* eslint-disable @typescript-eslint/no-explicit-any */
// Real anvil + real SymbolonVault + real Postgres (all migrations) + the real Hono app, for the WP-12 tests. Only the
// relayer wallet is anvil's unlocked account; every party signs with a generated throwaway key.
import { randomBytes, randomUUID } from "node:crypto";
import { normalizePolicy } from "@symbolon/policy";
import { symbolonVaultAbi } from "@symbolon/chain";
import { eip712Digest } from "@symbolon/schemas";
import type { Hex32 } from "@symbolon/schemas";
import type { Abi } from "viem";
import { createApp } from "../../src/app";
import type { AppDeps } from "../../src/app";
import { createClockGuard } from "../../src/auth/clock-guard";
import { pgNonceStore } from "../../src/auth/nonce-store";
import { mintServiceToken } from "../../src/auth/token";
import { noBlobStore } from "../../src/blob/store";
import { viemEngagementChain } from "../../src/chain/engagement-chain";
import type { EngagementChain } from "../../src/chain/engagement-chain";
import { viemChainReader } from "../../src/chain/reader";
import { viemVaultRelayer } from "../../src/chain/relayer";
import type { VaultRelayer } from "../../src/chain/relayer";
import { indexTenant } from "../../src/engagement/indexer";
import type { IndexerOptions } from "../../src/engagement/indexer";
import { createLogger } from "../../src/log";
import type { Logger } from "../../src/log";
import { createKernelSigner } from "../../src/receipt/build";
import { Secret } from "../../src/secret";
import { generatePrivateKey } from "viem/accounts";
import { openVaultWorld, newParty } from "./anvil-vault";
import type { Party, VaultWorld } from "./anvil-vault";
import { openTestDb } from "./pgdb";
import type { TestDb } from "./pgdb";
import { POLICY_INPUT, TOKEN_SECRET, call } from "./world";

export const TENANT_A = "4a1f0c52-7b3e-4d2a-9c11-0a1b2c3d4e51";
export const TENANT_B = "5b2e1d63-8c4f-4e3b-8d22-1b2c3d4e5f62";

export interface EngagementWorld {
  readonly v: VaultWorld;
  readonly t: TestDb;
  readonly logs: string[];
  readonly logger: Logger;
  readonly ec: EngagementChain;
  readonly relayer: VaultRelayer;
  app(over?: Partial<AppDeps>): ReturnType<typeof createApp>;
  token(tenantId?: string): string;
  /** One indexing pass for the tenant. Confirmation depth defaults to 0 here so tests control depth by mining. */
  index(tenantId?: string, o?: Partial<IndexerOptions>): ReturnType<typeof indexTenant>;
  tenantB: { owner: Party; vault: Hex32 | string };
  close(): Promise<void>;
}

async function seedTenant(t: TestDb, id: string, name: string, owner: string, vault: string): Promise<void> {
  const loaded = normalizePolicy(POLICY_INPUT);
  await t.db.query(
    `insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash)
     values ($1, $2, $3, $4, 31337, 'local', 'pilot', $5::jsonb, $6)`,
    [id, name, owner, vault, JSON.stringify(loaded.policy), loaded.policyHash],
  );
}

export async function openEngagementWorld(): Promise<EngagementWorld> {
  const v = await openVaultWorld();
  const t = openTestDb("production");
  await seedTenant(t, TENANT_A, "tenant a", v.owner.address, v.vault);
  const otherOwner = newParty();
  await seedTenant(t, TENANT_B, "tenant b", otherOwner.address, v.vault); // a second tenant row; used for isolation tests

  const chain = viemChainReader(v.pub, 31337);
  const ec = viemEngagementChain(v.pub, 31337);
  const relayer = viemVaultRelayer({ publicClient: v.pub, walletClient: v.wallet, account: v.relayerAccount });
  const logs: string[] = [];
  const signerKey = generatePrivateKey();
  const logger = createLogger({ sink: { write: (l) => void logs.push(l) }, secrets: [signerKey, TOKEN_SECRET] });
  const base = (over: Partial<AppDeps>): AppDeps => ({
    profile: "production",
    db: t.db,
    chain,
    signer: createKernelSigner(new Secret(signerKey)),
    clock: () => Date.now(),
    logger,
    serviceTokenSecret: TOKEN_SECRET,
    nonceStore: pgNonceStore(t.db),
    clockGuard: createClockGuard({ db: t.db, clock: () => Date.now(), logger }),
    blobs: noBlobStore,
    maxJsonBytes: 256 * 1024,
    maxBlobBytes: 1024 * 1024,
    engagements: { chain: ec, relayer },
    ...over,
  });
  return {
    v,
    t,
    logs,
    logger,
    ec,
    relayer,
    app: (over = {}) => createApp(base(over)),
    token: (tenantId = TENANT_A) => mintServiceToken({ secret: TOKEN_SECRET, profile: "production", tenantId, nowSec: Math.floor(Date.now() / 1000) }),
    index: (tenantId = TENANT_A, o = {}) => indexTenant({ db: t.db, chain: ec, logger }, tenantId, { confirmations: 0n, ...o }),
    tenantB: { owner: otherOwner, vault: v.vault },
    async close() {
      await t.close();
      await v.stop();
    },
  };
}

// --- request helpers -----------------------------------------------------------------------------------------------------------

export function termsBody(w: EngagementWorld, over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const iso = (s: number): string => new Date(s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    slug: `eng-${randomBytes(4).toString("hex")}`,
    owner: w.v.owner.address,
    payee: w.v.payee.address,
    payeeLabel: "Acme Design",
    capBaseUnits: "100000000",
    start: iso(now - 3600),
    end: iso(now + 30 * 86_400),
    sequential: false,
    milestones: [
      {
        slug: "design",
        uuid: randomUUID(),
        description: "Website design",
        amountBaseUnits: "10000000",
        partialAllowed: false,
        immediate: false,
        dueDate: null,
        category: "design",
        evidenceSpec: [{ type: "OWNER_ACK" }],
      },
    ],
    paymentTerms: { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: false },
    ...over,
  };
}

export async function createEng(w: EngagementWorld, app: ReturnType<typeof createApp>, over: Record<string, unknown> = {}, tenant = TENANT_A) {
  const r = await call(app, "POST", "/v1/engagements", w.token(tenant), termsBody(w, over));
  if (r.status !== 201) throw new Error(`create failed: ${String(r.status)} ${JSON.stringify(r.json)}`);
  return r.json as { engagementId: Hex32; typedData: any; digest: Hex32; status: string; termsHash: Hex32 };
}

export async function signAs(w: EngagementWorld, app: ReturnType<typeof createApp>, e: { engagementId: string; typedData: any }, role: "owner" | "payee", who?: Party) {
  const party = who ?? (role === "owner" ? w.v.owner : w.v.payee);
  const signature = await w.v.signTyped(party, e.typedData);
  return call(app, "POST", `/v1/engagements/${e.engagementId}/sign`, w.token(), { role, signature });
}

/** Create, sign by both, relay, mine and index: the full happy path. */
export async function activate(w: EngagementWorld, app: ReturnType<typeof createApp>, over: Record<string, unknown> = {}) {
  const e = await createEng(w, app, over);
  await signAs(w, app, e, "owner");
  const r = await signAs(w, app, e, "payee");
  await w.v.mine(1);
  await w.index();
  return { e, last: r };
}

export async function chainEngagement(w: EngagementWorld, id: string) {
  return w.v.pub.readContract({ address: w.v.vault, abi: symbolonVaultAbi as Abi, functionName: "engagements", args: [id] }) as Promise<readonly [string, bigint, bigint, bigint, bigint, string, boolean]>;
}

export async function dbStatus(w: EngagementWorld, id: string): Promise<{ status: string; registered_tx: string | null; submitted_tx: string | null; payee: string; registration_error: string | null }> {
  const r = await w.t.db.query<{ status: string; registered_tx: string | null; submitted_tx: string | null; payee: string; registration_error: string | null }>(
    "select status, registered_tx, submitted_tx, payee, registration_error from engagements where engagement_id = $1",
    [id],
  );
  const row = r.rows[0];
  if (row === undefined) throw new Error("no such engagement");
  return row;
}

export { eip712Digest, call };
