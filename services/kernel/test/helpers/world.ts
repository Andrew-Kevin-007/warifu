/* eslint-disable @typescript-eslint/no-explicit-any */
// A small real world for the service tests: a throwaway Postgres (all migrations), one tenant with a stored policy, one
// signed ACTIVE engagement with two milestones, and Hono apps built over it. Only the network edge is faked: the chain reader
// (viem against Arc) answers from the same engagement the DB holds, exactly as the vault would after EngagementRegistered.
import { randomBytes, randomUUID } from "node:crypto";
import { normalizePolicy } from "@symbolon/policy";
import { computeTermsHash, deriveEntityId, deriveMilestoneId, epochSecondsFromIso, hashJcs, keccak256Utf8, termsPreimage } from "@symbolon/schemas";
import type { Engagement, Hex32, Milestone } from "@symbolon/schemas";
import { generatePrivateKey } from "viem/accounts";
import { createApp } from "../../src/app";
import type { AppDeps } from "../../src/app";
import { createClockGuard } from "../../src/auth/clock-guard";
import { pgNonceStore } from "../../src/auth/nonce-store";
import { mintServiceToken } from "../../src/auth/token";
import { noBlobStore } from "../../src/blob/store";
import type { BlobStore } from "../../src/blob/store";
import type { ChainReader, OnChainEngagement, VaultSnapshot } from "../../src/chain/reader";
import { createLogger } from "../../src/log";
import type { Logger } from "../../src/log";
import { createKernelSigner } from "../../src/receipt/build";
import { Secret } from "../../src/secret";
import { openTestDb } from "./pgdb";
import type { TestDb } from "./pgdb";

export const PAYEE = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
export const ATTACKER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
export const OWNER = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
export const VAULT = "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb";
export const TOKEN = "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199";
export const TENANT = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
export const OTHER_TENANT = "9b2c1d3e-5f60-4a71-8b92-a3b4c5d6e7f8";
export const CHAIN_ID = 31337;
export const GROSS = 1_000_000_000n; // 1,000.000000 USDC
export const DOC_TEXT = "INVOICE INV-0042\nAcme Design\nWebsite design milestone\nTotal: 1,000.00 USDC\n";
export const TOKEN_SECRET = randomBytes(32).toString("hex");

export const ENGAGEMENT_ID = deriveEntityId({ tenantId: TENANT, slug: "edith-site" });
export const M1 = deriveMilestoneId({ tenantId: TENANT, uuid: "1b4e28ba-2fa1-41d2-883f-0016d3cca427" });
export const M2 = deriveMilestoneId({ tenantId: TENANT, uuid: "2c5f39cb-3fb2-42e3-994a-1127e4ddb538" });
export const H = (label: string): Hex32 => keccak256Utf8(label);

const milestone = (id: Hex32, slug: string): Milestone => ({
  milestoneId: id,
  slug,
  description: `${slug} milestone`,
  amountBaseUnits: GROSS.toString(),
  partialAllowed: false,
  immediate: false,
  dueDate: null,
  category: "design",
  evidenceSpec: [{ type: "OWNER_ACK" }],
  status: "PENDING",
});

export function makeEngagement(tenantId = TENANT): Engagement {
  const base: Engagement = {
    engagementId: tenantId === TENANT ? ENGAGEMENT_ID : deriveEntityId({ tenantId, slug: "edith-site" }),
    tenantId,
    owner: OWNER,
    payee: PAYEE,
    payeeLabel: "Acme Design",
    currency: "USDC",
    currencyDecimals: 6,
    capBaseUnits: (3n * GROSS).toString(),
    start: "2020-01-01T00:00:00Z",
    end: "2099-12-31T23:59:59Z",
    sequential: false,
    milestones: tenantId === TENANT ? [milestone(M1, "design"), milestone(M2, "build")] : [milestone(deriveMilestoneId({ tenantId, uuid: randomUUID() }), "design")],
    paymentTerms: null,
    termsHash: H("placeholder"),
    ownerSig: `0x${"11".repeat(65)}`,
    payeeSig: `0x${"22".repeat(65)}`,
    nonce: "1",
    status: "ACTIVE",
    registeredTx: H("registered-tx"),
  };
  return { ...base, termsHash: computeTermsHash(base) };
}

export const POLICY_INPUT = {
  version: 1,
  tenant: "edith-studio",
  currency: { code: "USDC", decimals: 6, treatUsdAsUsdc: true },
  caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: "1500" },
  categories: { design: "5000", dev: "5000" },
};

export interface FakeChain extends ChainReader {
  failWith: Error | null;
  paused: boolean;
  caps: { perTxCap: bigint; dailyCap: bigint; humanThreshold: bigint };
  engagements: Map<string, OnChainEngagement>;
  reads: number;
}

export function fakeChain(): FakeChain {
  const c: FakeChain = {
    chainId: CHAIN_ID,
    failWith: null,
    paused: false,
    caps: { perTxCap: 2_000_000_000n, dailyCap: 5_000_000_000n, humanThreshold: 1_500_000_000n },
    engagements: new Map(),
    reads: 0,
    async snapshot(): Promise<VaultSnapshot> {
      c.reads++;
      if (c.failWith !== null) throw c.failWith;
      return { token: TOKEN, tokenDecimals: 6, vaultTokenDecimals: 6, balance: 100_000_000_000n, hourlyCap: 0n, paused: c.paused, ...c.caps };
    },
    async engagement(_v, id) {
      if (c.failWith !== null) throw c.failWith;
      return c.engagements.get(id) ?? null;
    },
    async payeeChangeLive() {
      if (c.failWith !== null) throw c.failWith;
      return false;
    },
    async ping() {
      if (c.failWith !== null) throw c.failWith;
    },
  };
  return c;
}

export interface World {
  readonly t: TestDb;
  readonly chain: FakeChain;
  readonly logs: string[];
  readonly logger: Logger;
  readonly signerKey: string;
  app(over?: Partial<AppDeps>): ReturnType<typeof createApp>;
  token(tenantId?: string, over?: Partial<Parameters<typeof mintServiceToken>[0]>): string;
  close(): Promise<void>;
}

async function seedTenant(w: TestDb, tenantId: string, engagement: Engagement, name: string): Promise<void> {
  const loaded = normalizePolicy(POLICY_INPUT);
  await w.db.query(
    `insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash)
     values ($1, $2, $3, $4, $5, 'local', 'pilot', $6::jsonb, $7)`,
    [tenantId, name, OWNER, VAULT, CHAIN_ID, JSON.stringify(loaded.policy), loaded.policyHash],
  );
  await w.db.query(
    `insert into engagements (engagement_id, tenant_id, owner, payee, payee_label, currency, currency_decimals, cap_base_units, start_at, end_at,
                              sequential, terms, terms_hash, owner_sig, payee_sig, nonce, status, registered_tx)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11,$12::jsonb,$13,$14,$15,$16,$17,$18)`,
    [
      engagement.engagementId, tenantId, engagement.owner, engagement.payee, engagement.payeeLabel, engagement.currency, engagement.currencyDecimals,
      engagement.capBaseUnits, engagement.start, engagement.end, engagement.sequential, JSON.stringify(termsPreimage(engagement)), engagement.termsHash,
      engagement.ownerSig, engagement.payeeSig, engagement.nonce, engagement.status, engagement.registeredTx,
    ],
  );
  for (const m of engagement.milestones) {
    await w.db.query(
      `insert into milestones (milestone_id, engagement_id, slug, description, amount_base_units, partial_allowed, immediate, due_date, category, evidence_spec, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [m.milestoneId, engagement.engagementId, m.slug, m.description, m.amountBaseUnits, m.partialAllowed, m.immediate, m.dueDate, m.category, JSON.stringify(m.evidenceSpec), m.status],
    );
  }
}

export async function openWorld(): Promise<World> {
  const t = openTestDb("production");
  const eng = makeEngagement(TENANT);
  const other = makeEngagement(OTHER_TENANT);
  await seedTenant(t, TENANT, eng, "tenant one");
  await seedTenant(t, OTHER_TENANT, other, "tenant two");
  const chain = fakeChain();
  for (const e of [eng, other]) {
    chain.engagements.set(e.engagementId, {
      payee: e.payee as `0x${string}`,
      cap: BigInt(e.capBaseUnits),
      released: 0n,
      start: epochSecondsFromIso(e.start),
      end: epochSecondsFromIso(e.end),
      termsHash: e.termsHash,
      active: true,
    });
  }
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
    blobs: noBlobStore as BlobStore,
    maxJsonBytes: 256 * 1024,
    maxBlobBytes: 1024 * 1024,
    ...over,
  });
  return {
    t,
    chain,
    logs,
    logger,
    signerKey,
    app: (over = {}) => createApp(base(over)),
    token: (tenantId = TENANT, over = {}) =>
      mintServiceToken({ secret: TOKEN_SECRET, profile: over.profile ?? "production", tenantId, nowSec: Math.floor(Date.now() / 1000), ...over }),
    close: () => t.close(),
  };
}

// --- requests -----------------------------------------------------------------------------------------------------------------
type App = ReturnType<typeof createApp>;

export async function call(app: App, method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; headers: Headers }> {
  const h: Record<string, string> = { ...headers };
  if (token !== null) h["authorization"] = `Bearer ${token}`;
  let payload: string | FormData | undefined;
  if (body instanceof FormData) payload = body;
  else if (typeof body === "string") {
    h["content-type"] ??= "application/json";
    payload = body; // sent as-is (lets a test send malformed JSON)
  } else if (body !== undefined) {
    h["content-type"] ??= "application/json";
    payload = JSON.stringify(body);
  }
  const res = await app.request(`http://kernel.test${path}`, { method, headers: h, ...(payload === undefined ? {} : { body: payload }) });
  const text = await res.text();
  const parse = (): unknown => {
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      return text;
    }
  };
  return { status: res.status, json: parse(), headers: res.headers };
}

export function form(fields: Record<string, string | Blob>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

// --- intents ------------------------------------------------------------------------------------------------------------------
export function extraction(over: Record<string, unknown> = {}) {
  return {
    docType: "INVOICE",
    invoiceNumber: "INV-0042",
    issueDate: "2026-10-04",
    dueDate: null,
    payee: { legalName: "Acme Design", walletAddress: PAYEE as string | null, claimsAddressChange: false },
    amount: { printed: "1,000.00", currencyPrinted: "USDC", decimalSeparatorGuess: ".", parsedBaseUnits: "1000000000" as string | null, decimals: 6 as number | null },
    references: { engagementId: null, milestoneId: null, poNumber: null },
    statedTerms: { raw: null, netDays: null, earlyPay: null, ambiguous: false },
    lineItems: [{ description: "Website design", amountPrinted: "1,000.00" as string | null }],
    anomalies: [] as Array<{ code: string; quote: string }>,
    confidence: 0.93,
    ...over,
  };
}

/** Every call gets a fresh invoice number (a repeated one is, correctly, a REPLAY); pass an explicit extraction to pin it. */
export function intentFor(doc: { documentId: string; docHash: string }, over: Record<string, unknown> = {}) {
  const inv = `INV-${String((randomBytes(4).readUInt32BE(0) % 900000) + 100000)}`;
  return {
    schemaVersion: 1,
    tenantId: TENANT,
    documentId: doc.documentId,
    docHash: doc.docHash,
    extraction: {
      a: extraction({ invoiceNumber: inv }),
      b: extraction({ invoiceNumber: inv, confidence: 0.88 }),
      modelA: "claude-sonnet-5-5",
      modelB: "claude-haiku-5-5",
      promptHashA: H("prompt A"),
      promptHashB: H("prompt B"),
    },
    consensus: { status: "AGREE", diffs: [] },
    engagementId: ENGAGEMENT_ID as string | null,
    milestoneId: M1 as string | null,
    timingProposal: null,
    planSelection: null,
    agentRecommendation: null,
    submittedAt: "2026-10-05T10:05:00Z",
    ...over,
  };
}

/** Post a document as `tenant` and return what the kernel recorded. */
export async function postDoc(w: World, app: App, text = DOC_TEXT, tenantId = TENANT): Promise<{ documentId: string; docHash: string; normalizedHash: string; receivedAt: string }> {
  const r = await call(app, "POST", "/v1/documents", w.token(tenantId), form({ text, mime: "text/plain" }));
  if (r.status !== 201 && r.status !== 200) throw new Error(`document post failed: ${String(r.status)} ${JSON.stringify(r.json)}`);
  return r.json;
}

export { hashJcs };
