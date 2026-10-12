// Process entry (the only place env, the wall clock and the network listener are touched). Boot order, each step fail-closed:
//   1. boot guards on the environment (boot.ts) and config (config.ts)
//   2. database connection, then the DB-side checks (startup.ts: profile stamp, tenant kinds, clock skew)
//   3. RPC chain id (@symbolon/chain verifyRpcChainId)
//   4. only then: listen
// Run:  node --import tsx services/kernel/src/main.ts   (tsx is not a dependency of this repo; build tooling is WP-00's call)
import { serve } from "@hono/node-server";
import { arcConfigFromEnv, createArcPublicClient, verifyRpcChainId } from "@symbolon/chain";
import { createApp } from "./app";
import { createClockGuard } from "./auth/clock-guard";
import { pgNonceStore } from "./auth/nonce-store";
import { BootError } from "./boot";
import { fileBlobStore, noBlobStore } from "./blob/store";
import { viemChainReader } from "./chain/reader";
import { loadConfig } from "./config";
import { createPgDb } from "./db/pool";
import { createLogger, errorFields } from "./log";
import { createKernelSigner } from "./receipt/build";
import { StartupError, runStartupChecks } from "./startup";
import { systemClock } from "./time";

async function main(): Promise<void> {
  const config = loadConfig(process.env); // throws BootError / ConfigError: names and rules only
  const logger = createLogger({ secrets: config.logSecrets.map((s) => s.reveal()) });
  const db = createPgDb({ connectionString: config.databaseUrl.reveal() });
  const arc = arcConfigFromEnv(process.env);
  const client = createArcPublicClient(arc);
  await verifyRpcChainId(client, arc.chainId);
  const chain = viemChainReader(client, arc.chainId);
  const clock = systemClock;
  await runStartupChecks({ db, chain, profile: config.profile, expectedChainId: arc.chainId, clock });

  const app = createApp({
    profile: config.profile,
    db,
    chain,
    signer: createKernelSigner(config.kernelSignerKey),
    clock,
    logger,
    serviceTokenSecret: config.serviceTokenSecret.reveal(),
    nonceStore: pgNonceStore(db),
    clockGuard: createClockGuard({ db, clock, logger }),
    blobs: config.blobDir === null ? noBlobStore : fileBlobStore(config.blobDir),
    maxJsonBytes: config.maxJsonBytes,
    maxBlobBytes: config.maxBlobBytes,
  });
  const port = Number.parseInt(process.env["PORT"] ?? "8787", 10);
  serve({ fetch: app.fetch, port, hostname: process.env["HOST"] ?? "127.0.0.1" });
  logger.info("kernel.listening", { profile: config.profile, count: port });
}

main().catch((e: unknown) => {
  const rules = e instanceof BootError ? e.violations.map((v) => `${v.rule}:${v.variable}`).join(",") : e instanceof StartupError ? e.rule : "";
  const log = createLogger();
  log.error("kernel.boot_failed", { ...errorFields(e), reasonCode: rules.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40) || "UNKNOWN" });
  process.exitCode = 1;
});
