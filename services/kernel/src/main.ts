// Process entry (the only place env, the wall clock and the network listener are touched). Boot order, each step fail-closed:
//   1. boot guards on the environment (boot.ts) and config (config.ts)
//   2. database connection, then the DB-side checks (startup.ts: profile stamp, tenant kinds, clock skew)
//   3. RPC chain id (@symbolon/chain verifyRpcChainId)
//   4. only then: listen
// Run:  node --import tsx services/kernel/src/main.ts   (tsx is not a dependency of this repo; build tooling is WP-00's call)
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { parseArtifact } from "@symbolon/blast-radius/lbc";
import { viemChainReader as viemLbcReader } from "@symbolon/blast-radius/lbc/viem-reader";
import type { PublicClient } from "viem";
import type { CertificateServiceConfig } from "./certificates/service";
import { arcConfigFromEnv, createArcPublicClient, verifyRpcChainId } from "@symbolon/chain";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createApp } from "./app";
import { createClockGuard } from "./auth/clock-guard";
import { pgNonceStore } from "./auth/nonce-store";
import { BootError } from "./boot";
import { fileBlobStore, noBlobStore } from "./blob/store";
import { viemEngagementChain } from "./chain/engagement-chain";
import { viemChainReader } from "./chain/reader";
import { viemVaultRelayer } from "./chain/relayer";
import type { VaultRelayer } from "./chain/relayer";
import { createCircleHttpApi } from "./circle/client";
import { circleVaultRelayer } from "./circle/relayer";
import { createCircleWebhookHandler } from "./circle/webhook";
import { loadConfig } from "./config";
import { placeholderNames, stripPlaceholders } from "./env";
import { emptyFixtureStore } from "./evidence/fixtures";
import { collectEvidence } from "./evidence/service";
import type { EvidenceServiceDeps, EvidenceSource } from "./evidence/service";
import { createPgDb } from "./db/pool";
import { indexAll, startIndexerLoop } from "./engagement/indexer";
import { createLogger, errorFields } from "./log";
import { createKernelSigner } from "./receipt/build";
import { StartupError, runStartupChecks } from "./startup";
import { startSchedulerLoop, recheckHolds } from "./release/scheduler";
import { viemGuardianPauser } from "./chain/guardian";
import type { GuardianPauser } from "./chain/guardian";
import { viemLedgerChain } from "./reconcile/ledger";
import { startReconcilerLoop } from "./reconcile/service";
import type { ReconcilerDeps, ReconcilerLoop } from "./reconcile/service";
import type { ReleaseDeps } from "./release/service";
import { pgPlanProvider } from "./service/plans";
import { systemClock } from "./time";
import type { Clock } from "./time";

function certificateConfig(client: PublicClient): CertificateServiceConfig | null {
  const gitSha = process.env["GIT_SHA"];
  if (gitSha === undefined || !/^[0-9a-f]{7,40}$/.test(gitSha)) return null;
  const artifactPath = process.env["LBC_ARTIFACT"];
  return {
    reader: viemLbcReader(client),
    gitSha,
    ...(artifactPath === undefined ? {} : { artifact: parseArtifact(JSON.parse(readFileSync(artifactPath, "utf8"))) }),
  };
}

async function main(): Promise<void> {
  const env = stripPlaceholders(process.env); // PASTE_*_HERE template values read as unset
  const config = loadConfig(env); // throws BootError / ConfigError: names and rules only
  const logger = createLogger({ secrets: config.logSecrets.map((s) => s.reveal()) });
  const pending = placeholderNames(process.env);
  if (pending.length > 0) logger.warn("kernel.env_placeholders", { count: pending.length, reasonCode: pending.join(",").slice(0, 300) });
  const db = createPgDb({ connectionString: config.databaseUrl.reveal() });
  const arc = arcConfigFromEnv(env);
  const client = createArcPublicClient(arc);
  await verifyRpcChainId(client, arc.chainId);
  const chain = viemChainReader(client, arc.chainId);
  const clock = systemClock;
  await runStartupChecks({ db, chain, profile: config.profile, expectedChainId: arc.chainId, clock });

  const engagementChain = viemEngagementChain(client, arc.chainId);
  // Relayer: Circle developer-controlled wallet when CIRCLE_* + RELAYER_WALLET_* are set (WP-11); else a throwaway-key relayer
  // only if RELAYER_PRIVATE_KEY is set (local/testnet; config refuses both at once); else none.
  const circleApi = config.circle === null ? null : createCircleHttpApi({ apiKey: config.circle.apiKey });
  let relayer: VaultRelayer | null = null;
  if (config.circle !== null && circleApi !== null) {
    relayer = circleVaultRelayer({
      api: circleApi,
      publicClient: client,
      chainId: arc.chainId,
      walletId: config.circle.walletId,
      walletAddress: config.circle.walletAddress as `0x${string}`,
      entitySecret: config.circle.entitySecret,
    });
  } else if (config.relayerKey !== null) {
    relayer = viemVaultRelayer({ publicClient: client, walletClient: createWalletClient({ chain: arc.chain, transport: http(arc.rpcUrl) }), account: privateKeyToAccount(config.relayerKey.reveal() as `0x${string}`) });
  }
  // WP-15 guardian: its own key, pause-only on the vault. Absent = the breaker halts the kernel but cannot pause the vault.
  const guardian: GuardianPauser | null =
    config.guardianKey === null
      ? null
      : viemGuardianPauser({ publicClient: client, walletClient: createWalletClient({ chain: arc.chain, transport: http(arc.rpcUrl) }), account: privateKeyToAccount(config.guardianKey.reveal() as `0x${string}`) });
  const reconcilerDeps: ReconcilerDeps = { db, chain, ledger: viemLedgerChain(client), guardian, clock, logger };
  // Late-bound so the webhook can trigger a pass before the loop object exists (the loop is created after the app deps).
  let reconciler: ReconcilerLoop | null = null;
  const indexer = config.indexer.enabled
    ? startIndexerLoop({ db, chain: engagementChain, logger }, { intervalMs: config.indexer.pollMs, options: { confirmations: BigInt(config.indexer.confirmations), startBlock: BigInt(config.indexer.startBlock) } })
    : null;

  // The webhook only TRIGGERS an indexer pass (fire and forget: the answer to Circle must not wait for chain reads).
  const circleWebhook =
    config.circle === null || circleApi === null
      ? undefined
      : createCircleWebhookHandler({
          db,
          api: circleApi,
          clock,
          logger,
          allowedKeyIds: config.circle.webhookKeyIds,
          trigger: () => {
            // Index first (chain events are the evidence), then reconcile what they show. The webhook body decides nothing.
            void indexAll({ db, chain: engagementChain, logger }, { confirmations: BigInt(config.indexer.confirmations), startBlock: BigInt(config.indexer.startBlock) })
              .then(() => reconciler?.trigger())
              .catch((e: unknown) => logger.warn("webhook.trigger_failed", { ...errorFields(e) }));
            return Promise.resolve();
          },
        });
  // Evidence (WP-13, RT-02). The sandbox gets a fixture store and NO network code; production gets the guarded transport.
  // The sandbox challenge orchestrator (WP-32) replaces the empty store with the scenario fixtures.
  // The socket-owning module is imported only on the live branch, so a sandbox process never even loads it.
  const evidenceSource: EvidenceSource =
    config.evidenceMode === "fixtures"
      ? { kind: "fixtures", fixtures: emptyFixtureStore }
      : await (async (): Promise<EvidenceSource> => {
          const { createPinnedHttpsTransport, systemResolver } = await import("./evidence/ssrf/transport");
          return { kind: "live", guard: { resolver: systemResolver, transport: createPinnedHttpsTransport({ proxy: config.evidenceEgressProxy }) }, githubToken: config.githubToken?.reveal() ?? null };
        })();

  const signer = createKernelSigner(config.kernelSignerKey);
  const blobs = config.blobDir === null ? noBlobStore : fileBlobStore(config.blobDir);
  const evidenceDeps: EvidenceServiceDeps = { db, clock, profile: config.profile, logger, source: evidenceSource, chain, engagementChain, blobs, maxArtifactBytes: config.maxArtifactBytes };
  // WP-14. The test clock (TEST_CLOCK_OFFSET_SECONDS, refused in production by boot guard G11) shifts the scheduler's time only.
  const offsetMs = (config.scheduler.testClockOffsetSeconds ?? 0) * 1000;
  const schedulerClock: Clock = offsetMs === 0 ? clock : () => clock() + offsetMs;
  const releaseDeps: ReleaseDeps = {
    db, chain, signer, relayer, clock: schedulerClock, profile: config.profile, logger,
    txStatus: (h) => engagementChain.txStatus(h),
    recollect: async (tenantId, milestoneId) => void (await collectEvidence(evidenceDeps, tenantId, { milestoneId })),
  };
  const scheduler = config.scheduler.enabled ? startSchedulerLoop(releaseDeps, { chainId: arc.chainId, intervalMs: config.scheduler.pollMs }) : null;
  const reevalDeps = { db, chain, signer, clock, profile: config.profile, logger };
  reconciler = config.reconciler.enabled
    ? startReconcilerLoop(reconcilerDeps, { chainId: arc.chainId, intervalMs: config.reconciler.pollMs, options: { startBlock: BigInt(config.indexer.startBlock) } })
    : null;

  const certificates = certificateConfig(client);
  const app = createApp({
    ...(circleWebhook === undefined ? {} : { circleWebhook }),
    profile: config.profile,
    db,
    chain,
    signer,
    plans: pgPlanProvider(reevalDeps),
    approvals: { ...reevalDeps, engagementChain },
    breaker: { db, chain, engagementChain, clock, logger },
    afterEvidence: (tenantId, milestoneId) => recheckHolds(releaseDeps, tenantId, { milestoneId }),
    clock,
    logger,
    serviceTokenSecret: config.serviceTokenSecret.reveal(),
    nonceStore: pgNonceStore(db),
    clockGuard: createClockGuard({ db, clock, logger }),
    blobs,
    maxJsonBytes: config.maxJsonBytes,
    maxBlobBytes: config.maxBlobBytes,
    engagements: { chain: engagementChain, relayer },
    evidence: evidenceDeps,
    // Certificates (WP-34) are enabled by naming the running build's git revision; the optional Foundry artifact enables the code match.
    ...(certificates === null ? {} : { certificates }),
  });
  const port = Number.parseInt(process.env["PORT"] ?? "8787", 10);
  serve({ fetch: app.fetch, port, hostname: process.env["HOST"] ?? "127.0.0.1" });
  logger.info("kernel.listening", { profile: config.profile, count: port });
  process.once("SIGTERM", () => void Promise.all([indexer?.stop(), scheduler?.stop(), reconciler?.stop()]));
}

main().catch((e: unknown) => {
  const rules = e instanceof BootError ? e.violations.map((v) => `${v.rule}:${v.variable}`).join(",") : e instanceof StartupError ? e.rule : "";
  const log = createLogger();
  log.error("kernel.boot_failed", { ...errorFields(e), reasonCode: rules.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "UNKNOWN" });
  process.exitCode = 1;
});
