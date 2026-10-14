/* eslint-disable @typescript-eslint/no-explicit-any */
// The WP-14 test world: real Postgres (all migrations), the real Hono app and services, a signed ACTIVE engagement with real
// payment terms and an OWNER_ACK milestone, an owner that signs with a real secp256k1 key, and a MUTABLE service clock. Only the
// network edges are faked: the chain READ edge (FakeChain, as in world.ts) and the relayer (a recorder with scripted outcomes).
// The real vault on anvil is covered separately (release.anvil.local.test.ts).
import { randomUUID } from "node:crypto";
import { computeTermsHash, epochSecondsFromIso, isoFromEpochSeconds, keccak256Utf8 } from "@symbolon/schemas";
import type { Address, Engagement, Hex32, PaymentTerms } from "@symbolon/schemas";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import type { PrivateKeyAccount } from "viem/accounts";
import type { VaultRelayer, ReleaseArgs } from "../../src/chain/relayer";
import { RelayError } from "../../src/chain/relayer";
import type { ReleaseDeps } from "../../src/release/service";
import type { ReevalDeps } from "../../src/service/reeval";
import { createKernelSigner } from "../../src/receipt/build";
import { Secret } from "../../src/secret";
import { recheckHolds } from "../../src/release/scheduler";
import { pgPlanProvider } from "../../src/service/plans";
import { submitOwnerAck } from "../../src/evidence/service";
import { buildEngagement, evidenceDeps, fakeEngagementChain, seedTenant, signAck } from "./evidence-world";
import { CHAIN_ID, DOC_TEXT, OWNER, PAYEE, VAULT, call, intentFor, openWorld } from "./world";
import type { World } from "./world";

export const NET30_EARLY: PaymentTerms = { netDays: 30, earlyPay: { discountBps: 200, withinDays: 10 }, payBeforeDueBufferHours: 0, allowImmediate: false };
export const DAY = 86_400;
export const ZERO32 = `0x${"0".repeat(64)}` as Hex32;

/** A relayer that records what it is handed and answers from a script (default: a fresh tx hash). */
export interface FakeRelayer extends VaultRelayer {
  readonly calls: ReleaseArgs[];
  /** Outcomes consumed in order by release(): an Error is thrown, a string is the tx hash returned. */
  readonly script: Array<Error | string>;
}

export function fakeRelayer(): FakeRelayer {
  const calls: ReleaseArgs[] = [];
  const script: Array<Error | string> = [];
  const nope = (): never => {
    throw new Error("not used by the release tests");
  };
  return {
    calls,
    script,
    registerEngagement: nope,
    proposePayeeChange: nope,
    executePayeeChange: nope,
    async release(i) {
      calls.push(i);
      const next = script.shift();
      if (next instanceof Error) throw next;
      return { txHash: (next ?? keccak256Utf8(`fake-release-tx-${String(calls.length)}`)) as Hex32 };
    },
  };
}

export const relayRefused = (name: string): RelayError => new RelayError(`the vault refused release: ${name}`, name);

export interface ReleaseWorld {
  readonly w: World;
  readonly owner: PrivateKeyAccount;
  readonly tenantId: string;
  readonly engagement: Engagement;
  readonly milestone: Hex32;
  readonly relayer: FakeRelayer;
  /** The service clock (epoch ms). Starts at the real time; tests move it with advance(). */
  readonly clock: { ms: number };
  now(): bigint;
  advance(seconds: number): void;
  readonly signerAddress: Address;
  release(over?: Partial<ReleaseDeps>): ReleaseDeps;
  reeval(): ReevalDeps;
  app(over?: Record<string, unknown>): ReturnType<World["app"]>;
  token(): string;
  /** Store one document and the intent for it over HTTP at REAL time (call before advance()); returns the response. */
  submit(over?: Record<string, unknown>): Promise<{ status: number; json: any }>;
  /** An owner ack for the milestone at the current service time (verified, stored as evidence). */
  ack(deadlineSeconds?: number): Promise<void>;
  close(): Promise<void>;
}

export interface ReleaseWorldOptions {
  readonly terms?: PaymentTerms | null;
  /** policy.caps.humanApprovalAbove in whole USDC (default 1500: a 1,000 USDC invoice needs no human). */
  readonly humanApprovalAbove?: string;
  readonly humanThresholdUnits?: bigint;
  readonly gross?: bigint;
  /** newPayee.alwaysHuman (default false: no first-payment escalation, so a clean invoice releases by itself). */
  readonly alwaysHuman?: boolean;
  /** Extra top-level policy sections (shallow-merged over the defaults). */
  readonly policy?: Record<string, unknown>;
}

export async function openReleaseWorld(o: ReleaseWorldOptions = {}): Promise<ReleaseWorld> {
  const w = await openWorld();
  const owner = privateKeyToAccount(generatePrivateKey());
  const tenantId = randomUUID();
  const base = buildEngagement(tenantId, owner.address as Address, [[{ type: "OWNER_ACK" }]]);
  const gross = (o.gross ?? 1_000_000_000n).toString();
  const withTerms: Engagement = {
    ...base,
    paymentTerms: o.terms === undefined ? NET30_EARLY : o.terms,
    milestones: base.milestones.map((m) => ({ ...m, amountBaseUnits: gross })),
  };
  const engagement: Engagement = { ...withTerms, termsHash: computeTermsHash(withTerms) };
  const policyExtra = {
    caps: { perTxHardCap: "2000", dailyCap: "5000", weeklyCap: "10000", humanApprovalAbove: o.humanApprovalAbove ?? "1500" },
    velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "5000" },
    newPayee: { firstPaymentMax: "5000", alwaysHuman: o.alwaysHuman ?? false },
    ...o.policy,
  };
  await seedTenant(w, tenantId, engagement, policyExtra);
  w.chain.engagements.set(engagement.engagementId, {
    payee: engagement.payee as `0x${string}`,
    cap: BigInt(engagement.capBaseUnits),
    released: 0n,
    start: epochSecondsFromIso(engagement.start),
    end: epochSecondsFromIso(engagement.end),
    termsHash: engagement.termsHash,
    active: true,
  });
  if (o.humanThresholdUnits !== undefined) w.chain.caps.humanThreshold = o.humanThresholdUnits;

  const clock = { ms: Date.now() };
  const relayer = fakeRelayer();
  const signer = createKernelSigner(new Secret(w.signerKey));
  const milestone = engagement.milestones[0]?.milestoneId as Hex32;
  const svcClock = (): number => clock.ms;
  const rd = (): ReevalDeps => ({ db: w.t.db, chain: w.chain, signer, clock: svcClock, profile: "production", logger: w.logger });

  const world: ReleaseWorld = {
    w,
    owner,
    tenantId,
    engagement,
    milestone,
    relayer,
    clock,
    now: () => BigInt(Math.floor(clock.ms / 1000)),
    advance: (s) => void (clock.ms += s * 1000),
    signerAddress: signer.address,
    release: (over = {}) => ({ ...rd(), relayer, ...over }),
    reeval: rd,
    // The HTTP edge keeps the REAL clock (tokens are judged by the database clock); the services behind it use the test clock.
    app: (over = {}) =>
      w.app({
        plans: pgPlanProvider(rd()),
        approvals: { ...rd(), engagementChain: fakeEngagementChain() },
        afterEvidence: (t: string, m: Hex32) => recheckHolds(world.release(), t, { milestoneId: m }),
        ...over,
      } as never),
    token: () => w.token(tenantId),
    async submit(over = {}) {
      const app = world.app();
      const d = await call(app, "POST", "/v1/documents", w.token(tenantId), { text: `${DOC_TEXT}${randomUUID()}`, mime: "text/plain" });
      const body = intentFor(d.json, { tenantId, engagementId: engagement.engagementId, milestoneId: milestone, ...over });
      return call(app, "POST", "/v1/intents", w.token(tenantId), body);
    },
    async ack(deadlineSeconds = 3600) {
      const deps = evidenceDeps(w, { kind: "live", guard: { resolver: { resolve: async () => [] }, transport: { get: async () => { throw new Error("no network in tests"); } } }, githubToken: null }, {
        clock: svcClock,
        engagementChain: fakeEngagementChain(),
      });
      const deadline = world.now() + BigInt(deadlineSeconds);
      const sig = await signAck(owner, { milestoneId: milestone, artifactHash: ZERO32, override: false, deadline });
      await submitOwnerAck(deps, tenantId, { milestoneId: milestone, artifactHash: ZERO32, override: false, deadline: deadline.toString(), signature: sig });
    },
    close: () => w.close(),
  };
  return world;
}

export { CHAIN_ID, OWNER, PAYEE, VAULT, isoFromEpochSeconds };
