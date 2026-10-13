// Runtime configuration, read once at the process edge (the only place env is read). Everything secret is wrapped in
// Secret. loadConfig() runs the boot guards first, so a config object only exists for an environment that passed them.
import { assertBootGuards, parseProfile } from "./boot";
import type { EnvLike, Profile } from "./boot";
import { Secret } from "./secret";
import { redactionList } from "./secrets";

export type NetworkName = "testnet" | "local";

export interface KernelConfig {
  readonly profile: Profile;
  readonly network: NetworkName;
  readonly evidenceMode: "live" | "fixtures";
  readonly databaseUrl: Secret;
  readonly serviceTokenSecret: Secret;
  readonly kernelSignerKey: Secret;
  /** Directory for opaque document blobs (INV-23: stored and hashed, never parsed). */
  readonly blobDir: string | null;
  /** Hard cap on a JSON request body (bytes). */
  readonly maxJsonBytes: number;
  /** Hard cap on an uploaded blob (bytes); the sandbox accepts none (plain text only, docs/15 section 5). */
  readonly maxBlobBytes: number;
  /** Maximum service-token lifetime in seconds (docs/05 section 4: exp <= 60 s). */
  readonly maxTokenTtlSeconds: number;
  readonly challengeEnabled: boolean;
  /** WP-12 vault event indexer (docs/05 section 6). */
  readonly indexer: { readonly enabled: boolean; readonly confirmations: number; readonly pollMs: number; readonly startBlock: number };
  /** Throwaway-key relayer for local/testnet (the Circle relayer is WP-11). null = signatures are collected, nothing is submitted. */
  readonly relayerKey: Secret | null;
  /**
   * WP-11 Circle developer-controlled wallets: the relayer and the webhook receiver. null = not configured (the throwaway-key
   * relayer, or no relayer, is used and POST /webhooks/circle answers 501).
   */
  readonly circle: CircleConfig | null;
  /** WP-13. Optional deny-by-default egress proxy (HTTP CONNECT) for live evidence fetches; host:port. null = direct (pinned) connections. */
  readonly evidenceEgressProxy: { readonly host: string; readonly port: number } | null;
  /** WP-13. GitHub token for CI_PASS (public repos work without). Sent only to api.github.com. */
  readonly githubToken: Secret | null;
  /** WP-13. Largest artifact the kernel hashes for ARTIFACT_HASH evidence. */
  readonly maxArtifactBytes: number;
  /** Names + values that must never be logged. */
  readonly logSecrets: readonly Secret[];
}

export interface CircleConfig {
  readonly apiKey: Secret;
  readonly entitySecret: Secret;
  readonly blockchain: string;
  readonly walletId: string;
  readonly walletAddress: string;
  /** CIRCLE_WEBHOOK_PUBLIC_KEY_ID, comma separated; empty = the webhook receiver refuses everything. */
  readonly webhookKeyIds: readonly string[];
}

export class ConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(`${variable}: ${message}`);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

function intOf(env: EnvLike, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^[0-9]{1,12}$/.test(raw)) throw new ConfigError(name, "must be a non-negative integer");
  const n = Number.parseInt(raw, 10);
  if (n < min || n > max) throw new ConfigError(name, `must be between ${String(min)} and ${String(max)}`);
  return n;
}

export const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
export const DEFAULT_MAX_BLOB_BYTES = 10 * 1024 * 1024;
export const TOKEN_TTL_CEILING_SECONDS = 60;

function loadCircle(env: EnvLike, relayerKey: string): CircleConfig | null {
  const apiKey = env["CIRCLE_API_KEY"] ?? "";
  const entitySecret = env["CIRCLE_ENTITY_SECRET"] ?? "";
  const walletId = env["RELAYER_WALLET_ID"] ?? "";
  const walletAddress = env["RELAYER_WALLET_ADDRESS"] ?? "";
  const keyIds = (env["CIRCLE_WEBHOOK_PUBLIC_KEY_ID"] ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "");
  if (apiKey === "" && entitySecret === "" && walletId === "" && walletAddress === "") return null;
  // Half a configuration is an error, not a silent downgrade: a relayer that quietly is not Circle would hide a misconfiguration.
  if (apiKey === "") throw new ConfigError("CIRCLE_API_KEY", "required when any Circle relayer variable is set");
  if (!/^[0-9a-f]{64}$/.test(entitySecret)) throw new ConfigError("CIRCLE_ENTITY_SECRET", "must be 64 lowercase hex characters");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(walletId)) throw new ConfigError("RELAYER_WALLET_ID", "required (Circle wallet id)");
  if (!/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) throw new ConfigError("RELAYER_WALLET_ADDRESS", "required (0x address of the relayer wallet)");
  if (relayerKey !== "") throw new ConfigError("RELAYER_PRIVATE_KEY", "must be unset when the Circle relayer is configured (one relayer, one custody model)");
  for (const id of keyIds) if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw new ConfigError("CIRCLE_WEBHOOK_PUBLIC_KEY_ID", "malformed key id");
  const blockchain = env["CIRCLE_BLOCKCHAIN"] ?? "ARC-TESTNET";
  if (blockchain !== "ARC-TESTNET") throw new ConfigError("CIRCLE_BLOCKCHAIN", "only ARC-TESTNET is supported (mainnet identifier unverified, V-03)");
  return Object.freeze({ apiKey: new Secret(apiKey), entitySecret: new Secret(entitySecret), blockchain, walletId, walletAddress: walletAddress.toLowerCase(), webhookKeyIds: keyIds });
}

/** "host:port" with a DNS-label-ish host or a bracketed IPv6; anything else is a ConfigError (the proxy is infrastructure, not input). */
export function parseProxy(name: string, raw: string | undefined): { host: string; port: number } | null {
  if (raw === undefined || raw === "") return null;
  const m = /^([A-Za-z0-9.-]{1,253}):([0-9]{1,5})$/.exec(raw);
  const port = m === null ? 0 : Number.parseInt(m[2] as string, 10);
  if (m === null || port < 1 || port > 65535) throw new ConfigError(name, "expected host:port");
  return { host: m[1] as string, port };
}

export function loadConfig(env: EnvLike): KernelConfig {
  assertBootGuards(env);
  const profile = parseProfile(env);
  if (profile === null) throw new ConfigError("KERNEL_PROFILE", "invalid"); // unreachable after the guards; fail closed anyway
  const network = env["NETWORK"];
  if (network !== "testnet" && network !== "local") throw new ConfigError("NETWORK", "mainnet is not supported (V-03)");
  const evidenceMode = env["EVIDENCE_MODE"] === "fixtures" ? "fixtures" : "live";
  const databaseUrl = env["DATABASE_URL"] ?? "";
  const serviceTokenSecret = env["SERVICE_TOKEN_SECRET"] ?? "";
  const kernelSignerKey = env["KERNEL_SIGNER_PRIVATE_KEY"] ?? "";
  const relayerKey = env["RELAYER_PRIVATE_KEY"] ?? "";
  if (relayerKey !== "" && relayerKey === kernelSignerKey) throw new ConfigError("RELAYER_PRIVATE_KEY", "must not be the kernel signer key (separate roles)");
  const blobDir = env["BLOB_DIR"] !== undefined && env["BLOB_DIR"] !== "" ? env["BLOB_DIR"] : null;
  return Object.freeze({
    profile,
    network,
    evidenceMode,
    databaseUrl: new Secret(databaseUrl),
    serviceTokenSecret: new Secret(serviceTokenSecret),
    kernelSignerKey: new Secret(kernelSignerKey),
    blobDir,
    maxJsonBytes: intOf(env, "MAX_JSON_BYTES", DEFAULT_MAX_JSON_BYTES, 1024, 4 * 1024 * 1024),
    maxBlobBytes: profile === "sandbox" ? 0 : intOf(env, "MAX_BLOB_BYTES", DEFAULT_MAX_BLOB_BYTES, 0, 64 * 1024 * 1024),
    maxTokenTtlSeconds: TOKEN_TTL_CEILING_SECONDS,
    challengeEnabled: profile === "sandbox" && env["CHALLENGE_ENABLED"] !== "false",
    indexer: {
      enabled: env["INDEXER_ENABLED"] !== "false",
      // Default 2: Arc is documented as final on inclusion (docs/05 s6) but finality is not verified here, VERIFY(V-24).
      confirmations: intOf(env, "INDEXER_CONFIRMATIONS", 2, 0, 1000),
      pollMs: intOf(env, "INDEXER_POLL_MS", 5000, 250, 3_600_000),
      startBlock: intOf(env, "INDEXER_START_BLOCK", 0, 0, Number.MAX_SAFE_INTEGER),
    },
    relayerKey: relayerKey === "" ? null : new Secret(relayerKey),
    circle: loadCircle(env, relayerKey),
    evidenceEgressProxy: parseProxy("EVIDENCE_EGRESS_PROXY", env["EVIDENCE_EGRESS_PROXY"]),
    githubToken: env["GITHUB_TOKEN"] === undefined || env["GITHUB_TOKEN"] === "" ? null : new Secret(env["GITHUB_TOKEN"]),
    maxArtifactBytes: intOf(env, "MAX_ARTIFACT_BYTES", 5 * 1024 * 1024, 1, 64 * 1024 * 1024),
    logSecrets: redactionList(env).map((s) => new Secret(s)),
  });
}
