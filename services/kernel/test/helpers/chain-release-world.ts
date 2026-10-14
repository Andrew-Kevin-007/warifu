/* eslint-disable @typescript-eslint/no-explicit-any */
// The WP-14 / WP-15 chain world: real anvil + the real SymbolonVault + MockUSDC (contracts/out), real Postgres (all migrations),
// the real Hono app, the real scheduler and the real viem relayer. The service's kernel signer IS the vault's kernelSigner (the
// key of the throwaway `kernel` party), so a receipt the service signs verifies against `vault.kernelSigner()`, and an
// attestation it signs is accepted by the vault's `release()`. The only simulated thing is the clock: the service clock runs
// ahead of real time by an offset, and the chain is warped by the same amount so block.timestamp tracks service time.
import { randomBytes, randomUUID } from "node:crypto";
import { normalizePolicy } from "@symbolon/policy";
import { symbolonVaultAbi } from "@symbolon/chain";
import type { Hex32 } from "@symbolon/schemas";
import type { Abi, Address } from "viem";
import { noBlobStore } from "../../src/blob/store";
import { viemChainReader } from "../../src/chain/reader";
import type { ChainReader } from "../../src/chain/reader";
import { submitOwnerAck } from "../../src/evidence/service";
import type { EvidenceServiceDeps } from "../../src/evidence/service";
import { createKernelSigner } from "../../src/receipt/build";
import type { KernelSigner } from "../../src/receipt/build";
import { recheckHolds } from "../../src/release/scheduler";
import type { ReleaseDeps } from "../../src/release/service";
import { pgPlanProvider } from "../../src/service/plans";
import type { ReevalDeps } from "../../src/service/reeval";
import { Secret } from "../../src/secret";
import { USDC, anvilSuiteEnabled } from "./anvil-vault";
import { TENANT_A, activate, openEngagementWorld } from "./engagement-world";
import type { EngagementWorld } from "./engagement-world";
import { signAck } from "./evidence-world";
import { POLICY_INPUT, extraction, H, call } from "./world";

export { anvilSuiteEnabled };

export const ZERO32 = `0x${"0".repeat(64)}` as Hex32;
export const DAY = 86_400;
const MOCK_USDC_ABI = [
  { type: "function", name: "mint", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** 10000000n -> "10.00" (whole units and two decimals, bigint arithmetic only). */
export const printedOf = (units: bigint): string => `${(units / USDC).toString()}.${((units % USDC) / 10_000n).toString().padStart(2, "0")}`;

export interface ChainReleaseWorld {
  readonly ew: EngagementWorld;
  readonly tenantId: string;
  readonly signer: KernelSigner;
  readonly chain: ChainReader;
  engagementId: Hex32;
  milestoneId: Hex32;
  /** Gross invoice amount of the milestone, base units. */
  readonly gross: bigint;
  nowMs(): number;
  now(): bigint;
  /** Move the service clock (and the chain's block time) forward to this epoch second. */
  advanceTo(epochSeconds: bigint): Promise<void>;
  reevalDeps(): ReevalDeps;
  releaseDeps(over?: Partial<ReleaseDeps>): ReleaseDeps;
  app(over?: Record<string, unknown>): ReturnType<EngagementWorld["app"]>;
  token(): string;
  /** POST a document and an intent for the milestone (real time); returns the response. */
  submit(over?: { text?: string }): Promise<{ status: number; json: any }>;
  /** Owner acknowledges the milestone (real EIP-712 signature, verified through the vault's domain). */
  ack(): Promise<void>;
  balanceOf(who: Address): Promise<bigint>;
  usedOnChain(intentId: Hex32): Promise<boolean>;
  index(): ReturnType<EngagementWorld["index"]>;
  close(): Promise<void>;
}

export interface ChainReleaseOptions {
  /** Gross milestone amount in base units (default 10 USDC; the vault's human threshold is 20 USDC, per-tx cap 25). */
  readonly gross?: bigint;
  readonly paymentTerms?: Record<string, unknown> | null;
}

export async function openChainReleaseWorld(o: ChainReleaseOptions = {}): Promise<ChainReleaseWorld> {
  const ew = await openEngagementWorld();
  const gross = o.gross ?? 10n * USDC;
  // Policy: strictly inside the vault's limits (perTx 25, daily 60, human threshold 20 USDC), evidence fresh for a month.
  const loaded = normalizePolicy({
    ...POLICY_INPUT,
    caps: { perTxHardCap: "25", dailyCap: "60", weeklyCap: "200", humanApprovalAbove: "20" },
    velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 5, maxAmountPerPayeePerDay: "60" },
    newPayee: { firstPaymentMax: "25", alwaysHuman: false },
    evidence: { freshnessHours: 24 * 60, allowOwnerOverride: true, urlAllowlist: [] },
    categories: { design: "200", dev: "200", tools: "100" },
  });
  await ew.t.db.query("update tenants set policy = $2::jsonb, policy_hash = $3 where id = $1", [TENANT_A, JSON.stringify(loaded.policy), loaded.policyHash]);

  // Fund the vault.
  const { v } = ew;
  const mintTx = await v.wallet.writeContract({ address: v.token, abi: MOCK_USDC_ABI, functionName: "mint", args: [v.vault, 500n * USDC], account: v.relayerAccount, chain: null } as never);
  await v.pub.waitForTransactionReceipt({ hash: mintTx });

  let offsetMs = 0;
  const nowMs = (): number => Date.now() + offsetMs;
  const signer = createKernelSigner(new Secret(v.kernel.key));
  const chain = viemChainReader(v.pub, 31337);
  const rd = (): ReevalDeps => ({ db: ew.t.db, chain, signer, clock: nowMs, profile: "production", logger: ew.logger });
  const evidence: EvidenceServiceDeps = {
    db: ew.t.db,
    clock: nowMs,
    profile: "production",
    logger: ew.logger,
    source: { kind: "live", guard: { resolver: { resolve: async () => [] }, transport: { get: async () => { throw new Error("no network in tests"); } } }, githubToken: null },
    chain,
    engagementChain: ew.ec,
    blobs: noBlobStore,
    maxArtifactBytes: 1024,
  };
  const rel = (over: Partial<ReleaseDeps> = {}): ReleaseDeps => ({ ...rd(), relayer: ew.relayer, txStatus: (h) => ew.ec.txStatus(h), ...over });

  const world: ChainReleaseWorld = {
    ew,
    tenantId: TENANT_A,
    signer,
    chain,
    engagementId: "" as Hex32,
    milestoneId: "" as Hex32,
    gross,
    nowMs,
    now: () => BigInt(Math.floor(nowMs() / 1000)),
    async advanceTo(t) {
      const cur = BigInt(Math.floor(nowMs() / 1000));
      if (t <= cur) return;
      offsetMs += Number(t - cur) * 1000;
      // Warp the chain to the service's time so the vault's own clock agrees with the scheduler's.
      const chainNow = BigInt((await v.pub.getBlock()).timestamp);
      if (t > chainNow) {
        await v.dev.increaseTime({ seconds: Number(t - chainNow) });
        await v.dev.mine({ blocks: 1 });
      }
    },
    reevalDeps: rd,
    releaseDeps: rel,
    app: (over = {}) =>
      ew.app({
        signer,
        chain,
        plans: pgPlanProvider(rd()),
        approvals: { ...rd(), engagementChain: ew.ec },
        afterEvidence: (t: string, m: Hex32) => recheckHolds(rel(), t, { milestoneId: m }),
        ...over,
      } as never),
    token: () => ew.token(TENANT_A),
    async submit(opts = {}) {
      const app = world.app();
      const text = opts.text ?? `INVOICE ${randomUUID()}\nAcme Design\nWebsite design milestone\nTotal: ${printedOf(gross)} USDC\n`;
      const d = await call(app, "POST", "/v1/documents", world.token(), { text, mime: "text/plain" });
      if (d.status !== 201 && d.status !== 200) throw new Error(`document post failed ${String(d.status)}`);
      const inv = `INV-${String((randomBytes(4).readUInt32BE(0) % 900000) + 100000)}`;
      const printed = printedOf(gross);
      const ex = (conf: number) =>
        extraction({
          invoiceNumber: inv,
          confidence: conf,
          payee: { legalName: "Acme Design", walletAddress: v.payee.address, claimsAddressChange: false },
          amount: { printed, currencyPrinted: "USDC", decimalSeparatorGuess: ".", parsedBaseUnits: gross.toString(), decimals: 6 },
          lineItems: [{ description: "Website design", amountPrinted: printed }],
        });
      const body = {
        schemaVersion: 1,
        tenantId: TENANT_A,
        documentId: d.json.documentId,
        docHash: d.json.docHash,
        extraction: { a: ex(0.93), b: ex(0.88), modelA: "claude-sonnet-5-5", modelB: "claude-haiku-5-5", promptHashA: H("prompt A"), promptHashB: H("prompt B") },
        consensus: { status: "AGREE", diffs: [] },
        engagementId: world.engagementId,
        milestoneId: world.milestoneId,
        timingProposal: null,
        planSelection: null,
        agentRecommendation: null,
        submittedAt: "2026-10-05T10:05:00Z",
      };
      return call(app, "POST", "/v1/intents", world.token(), body);
    },
    async ack() {
      const deadline = world.now() + BigInt(29 * DAY);
      const sig = await signAck(v.owner.account, { milestoneId: world.milestoneId, artifactHash: ZERO32, override: false, deadline }, 31337, v.vault);
      await submitOwnerAck(evidence, TENANT_A, { milestoneId: world.milestoneId, artifactHash: ZERO32, override: false, deadline: deadline.toString(), signature: sig });
    },
    async balanceOf(who) {
      return (await v.pub.readContract({ address: v.token, abi: MOCK_USDC_ABI as unknown as Abi, functionName: "balanceOf", args: [who] })) as bigint;
    },
    async usedOnChain(intentId) {
      return (await v.pub.readContract({ address: v.vault, abi: symbolonVaultAbi as Abi, functionName: "used", args: [intentId] })) as boolean;
    },
    index: () => ew.index(),
    async close() {
      await ew.close();
    },
  };

  // The engagement goes through the real sign -> relay -> index path.
  const app = world.app();
  const { e } = await activate(ew, app, {
    end: new Date(Date.now() + 90 * DAY * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"), // outlives a due-date payAt
    capBaseUnits: (4n * gross + 10n * USDC).toString(),
    milestones: [
      {
        slug: "design",
        uuid: randomUUID(),
        description: "Website design",
        amountBaseUnits: gross.toString(),
        partialAllowed: false,
        immediate: false,
        dueDate: null,
        category: "design",
        evidenceSpec: [{ type: "OWNER_ACK" }],
      },
    ],
    ...(o.paymentTerms === undefined ? {} : { paymentTerms: o.paymentTerms }),
  });
  world.engagementId = e.engagementId;
  const eng = await ew.t.db.query<{ milestone_id: string }>("select milestone_id from milestones where engagement_id = $1 order by milestone_id", [e.engagementId]);
  world.milestoneId = eng.rows[0]?.milestone_id as Hex32;
  return world;
}

