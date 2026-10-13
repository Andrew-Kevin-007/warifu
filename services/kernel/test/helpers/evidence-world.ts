// Evidence test world (WP-13): the WP-10 world (real Postgres, all migrations, real Hono app, fake chain READ edge) plus extra
// tenants whose SIGNED engagements carry the evidence specs under test, a counting stub of the two network edges (DNS and
// HTTPS) and an owner that signs with a real secp256k1 key. Nothing here talks to a real network.
import { randomUUID } from "node:crypto";
import { normalizePolicy } from "@symbolon/policy";
import { computeTermsHash, deriveEntityId, deriveMilestoneId, eip712DomainSeparator, EIP712_TYPES, symbolonDomain, termsPreimage } from "@symbolon/schemas";
import type { Address, Engagement, EvidenceRequirement, Hex32 } from "@symbolon/schemas";
import { recoverAddress } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import { noBlobStore } from "../../src/blob/store";
import type { BlobStore } from "../../src/blob/store";
import type { EvidenceServiceDeps, EvidenceSource } from "../../src/evidence/service";
import type { GuardDeps, PinnedRequest, TransportResponse } from "../../src/evidence/ssrf/guard";
import { CHAIN_ID, POLICY_INPUT, PAYEE, VAULT, openWorld } from "./world";
import type { World } from "./world";

export interface NetStub extends GuardDeps {
  readonly dnsCalls: string[];
  readonly requests: PinnedRequest[];
}

/** A resolver + transport pair that counts every call; the SEC-02 "egress log". */
export function netStub(dns: Record<string, readonly string[]>, respond: (q: PinnedRequest) => TransportResponse | Error = () => ({ status: 200, location: null, body: new TextEncoder().encode("ok"), truncated: false })): NetStub {
  const dnsCalls: string[] = [];
  const requests: PinnedRequest[] = [];
  return {
    dnsCalls,
    requests,
    resolver: {
      async resolve(host) {
        dnsCalls.push(host);
        const a = dns[host];
        if (a === undefined) throw new Error("NXDOMAIN");
        return a;
      },
    },
    transport: {
      async get(q) {
        requests.push(q);
        const r = respond(q);
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

export const enc = new TextEncoder();
export const jsonResponse = (v: unknown, status = 200): TransportResponse => ({ status, location: null, body: enc.encode(JSON.stringify(v)), truncated: false });

export interface SeededTenant {
  readonly tenantId: string;
  readonly owner: PrivateKeyAccount;
  readonly engagement: Engagement;
  /** milestone ids in the order specs were given */
  readonly milestones: Hex32[];
}

export const ownerOf = (): PrivateKeyAccount => privateKeyToAccount(generatePrivateKey());

/** An ACTIVE signed engagement (terms hash computed, not just stored) with one milestone per spec list. */
export function buildEngagement(tenantId: string, owner: Address, specs: ReadonlyArray<readonly EvidenceRequirement[]>, status = "ACTIVE"): Engagement {
  const milestones = specs.map((spec, i) => ({
    milestoneId: deriveMilestoneId({ tenantId, uuid: randomUUID() }),
    slug: `m${String(i + 1)}`,
    description: `milestone ${String(i + 1)}`,
    amountBaseUnits: "1000000000",
    partialAllowed: false,
    immediate: false,
    dueDate: null,
    category: "design",
    evidenceSpec: [...spec],
    status: "PENDING" as const,
  }));
  const base: Engagement = {
    engagementId: deriveEntityId({ tenantId, slug: "evidence-test" }),
    tenantId,
    owner,
    payee: PAYEE,
    payeeLabel: "Acme Design",
    currency: "USDC",
    currencyDecimals: 6,
    capBaseUnits: "5000000000",
    start: "2020-01-01T00:00:00Z",
    end: "2099-12-31T23:59:59Z",
    sequential: false,
    milestones,
    paymentTerms: null,
    termsHash: `0x${"0".repeat(64)}`,
    ownerSig: `0x${"11".repeat(65)}`,
    payeeSig: `0x${"22".repeat(65)}`,
    nonce: "1",
    status: status as Engagement["status"],
    registeredTx: `0x${"33".repeat(32)}`,
  };
  return { ...base, termsHash: computeTermsHash(base) };
}

export async function seedTenant(w: World, tenantId: string, engagement: Engagement, policyExtra: Record<string, unknown> = {}): Promise<void> {
  const loaded = normalizePolicy({ ...POLICY_INPUT, ...policyExtra });
  await w.t.db.query(
    `insert into tenants (id, name, owner_address, vault_address, chain_id, network, kind, policy, policy_hash)
     values ($1, $2, $3, $4, $5, 'local', 'pilot', $6::jsonb, $7)`,
    [tenantId, `evidence tenant ${tenantId.slice(0, 4)}`, engagement.owner, VAULT, CHAIN_ID, JSON.stringify(loaded.policy), loaded.policyHash],
  );
  await w.t.db.query(
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
    await w.t.db.query(
      `insert into milestones (milestone_id, engagement_id, slug, description, amount_base_units, partial_allowed, immediate, due_date, category, evidence_spec, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)`,
      [m.milestoneId, engagement.engagementId, m.slug, m.description, m.amountBaseUnits, m.partialAllowed, m.immediate, m.dueDate, m.category, JSON.stringify(m.evidenceSpec), m.status],
    );
  }
}

export async function seedEvidenceTenant(w: World, specs: ReadonlyArray<readonly EvidenceRequirement[]>, opts: { status?: string; policyExtra?: Record<string, unknown> } = {}): Promise<SeededTenant> {
  const owner = ownerOf();
  const tenantId = randomUUID();
  const engagement = buildEngagement(tenantId, owner.address, specs, opts.status);
  await seedTenant(w, tenantId, engagement, opts.policyExtra);
  return { tenantId, owner, engagement, milestones: engagement.milestones.map((m) => m.milestoneId) };
}

/** Real-crypto EIP-712 verification over the same digest the vault uses; only the RPC (ERC-1271 / domainSeparator) is faked. */
export const fakeEngagementChain = (): EvidenceServiceDeps["engagementChain"] => ({
  chainId: CHAIN_ID,
  domainSeparator: async () => eip712DomainSeparator(symbolonDomain(CHAIN_ID, VAULT)),
  isValidSignature: async (signer, digest, signature) => {
    try {
      return (await recoverAddress({ hash: digest, signature })).toLowerCase() === signer.toLowerCase();
    } catch {
      return false;
    }
  },
});

export function evidenceDeps(w: World, source: EvidenceSource, over: Partial<EvidenceServiceDeps> = {}): EvidenceServiceDeps {
  return {
    db: w.t.db,
    clock: () => Date.now(),
    profile: source.kind === "fixtures" ? "sandbox" : "production",
    logger: w.logger,
    source,
    chain: w.chain,
    engagementChain: fakeEngagementChain(),
    blobs: noBlobStore as BlobStore,
    maxArtifactBytes: 1024 * 1024,
    ...over,
  };
}

export { openWorld };

/** A signed MilestoneAck via viem's own typed-data signer (independent of our digest helper). */
export async function signAck(owner: PrivateKeyAccount, m: { milestoneId: Hex32; artifactHash: Hex32; override: boolean; deadline: bigint }, chainId = CHAIN_ID, vault: Address = VAULT): Promise<string> {
  return owner.signTypedData({
    domain: { name: "SymbolonVault", version: "1", chainId, verifyingContract: vault },
    types: { MilestoneAck: EIP712_TYPES.MilestoneAck.map((f) => ({ name: f.name, type: f.type })) },
    primaryType: "MilestoneAck",
    message: m,
  });
}
