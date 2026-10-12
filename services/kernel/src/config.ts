// Runtime configuration, read once at the process edge (the only place env is read). Everything secret is wrapped in
// Secret. loadConfig() runs the boot guards first, so a config object only exists for an environment that passed them.
import { assertBootGuards, parseProfile } from "./boot";
import type { EnvLike, Profile } from "./boot";
import { Secret } from "./secret";

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
  /** Names + values that must never be logged. */
  readonly logSecrets: readonly Secret[];
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
    logSecrets: [databaseUrl, serviceTokenSecret, kernelSignerKey, env["GUARDIAN_PRIVATE_KEY"] ?? "", env["CIRCLE_API_KEY"] ?? "", env["CIRCLE_ENTITY_SECRET"] ?? ""].filter((s) => s !== "").map((s) => new Secret(s)),
  });
}
