// Boot guards (INV-16, RT-05, docs/15 section 3; SEC-05 / SEC-14). They are pure functions of an env-like object and
// FAIL CLOSED: anything missing, malformed or ambiguous is a violation, and a violation stops the process before it
// listens. Violations name the variable and the rule, never the value (a value may be a secret).
//
// Covered here (the others need the DB or the deployments file and live in profile-db.ts / main.ts):
//   G0  KERNEL_PROFILE is explicitly "production" or "sandbox"          (no default: an unset profile must not boot)
//   G1  sandbox: NETWORK is testnet or local, never mainnet             (15 s3.1)
//   G2  sandbox: the kernel signer (and guardian) address is not in PROD_SIGNER_ADDRESSES   (15 s3.2)
//   G3  sandbox: no env var named ^(PROD|MAINNET)_ except the two denylists                  (15 s3.3)
//   G4  sandbox: DATABASE_URL / SUPABASE_URL host is not PROD_SUPABASE_HOST                  (15 s3.4)
//   G5  sandbox: EVIDENCE_MODE=fixtures; production: EVIDENCE_MODE is live                   (15 s3.5, RT-02)
//   G6  sandbox: CHALLENGE_LLM_DAILY_BUDGET_USD and CHALLENGE_IP_SALT set                    (15 s3.6)
//   G8  SERVICE_TOKEN_SECRET present, >= 32 bytes, not a placeholder; a sandbox secret is
//       not one of the PROD_* values (impossible by G3) and never equals KERNEL_SIGNER_PRIVATE_KEY (RT-31)
//   G10 every configured secret (and a DATABASE_URL password) is >= 16 characters: a short secret cannot be
//       redacted from logs reliably, so it is refused rather than silently left in the clear (SEC-07)
//   G9  production: no challenge switches (CHALLENGE_ENABLED=true, CHALLENGE_*)
//   G11 TEST_CLOCK_OFFSET_SECONDS is refused when KERNEL_PROFILE=production or NODE_ENV=production (WP-14)
import { privateKeyToAccount } from "viem/accounts";
import { MIN_SECRET_CHARS, configuredSecrets } from "./secrets";
import { PROFILES } from "./types";
import type { EnvLike, Profile } from "./types";

export { PROFILES };
export type { EnvLike, Profile };

export interface BootViolation {
  readonly rule: string;
  readonly variable: string;
  readonly message: string;
}

const DENYLIST_NAMES = new Set(["PROD_SIGNER_ADDRESSES", "PROD_SUPABASE_HOST"]);
const PLACEHOLDER = /^(change.?me|secret|password|test|todo|xxx+|0+|1+|replace.?me|example|placeholder)$/i;

function set(env: EnvLike, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v.trim() === "" ? undefined : v;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function addressOfKey(key: string): string | null {
  try {
    return privateKeyToAccount(key as `0x${string}`).address.toLowerCase();
  } catch {
    return null;
  }
}

function listAddresses(csv: string | undefined): string[] {
  return (csv ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

export function parseProfile(env: EnvLike): Profile | null {
  const p = env["KERNEL_PROFILE"];
  return p === "production" || p === "sandbox" ? p : null;
}

export function evaluateBootGuards(env: EnvLike): BootViolation[] {
  const v: BootViolation[] = [];
  const add = (rule: string, variable: string, message: string): void => void v.push({ rule, variable, message });

  const profile = parseProfile(env);
  if (profile === null) {
    add("G0", "KERNEL_PROFILE", 'must be exactly "production" or "sandbox" (there is no default)');
    return v; // nothing else is meaningful without a profile
  }

  // G10: nothing short enough to be guessed or to collide with ordinary log text.
  for (const [name, value] of configuredSecrets(env)) {
    if (value.length < MIN_SECRET_CHARS) add("G10", name, `must be at least ${String(MIN_SECRET_CHARS)} characters`);
  }
  const dbUrl = set(env, "DATABASE_URL");
  if (dbUrl !== undefined) {
    try {
      const pw = decodeURIComponent(new URL(dbUrl).password);
      if (pw !== "" && pw.length < MIN_SECRET_CHARS) add("G10", "DATABASE_URL", `its password must be at least ${String(MIN_SECRET_CHARS)} characters`);
    } catch {
      // an unparsable URL is reported by G4 (sandbox) or fails at connect time; no password to measure
    }
  }

  // G11: the test clock (WP-14) moves the scheduler's time and exists only outside production, whatever the profile says.
  if (set(env, "TEST_CLOCK_OFFSET_SECONDS") !== undefined && (profile === "production" || env["NODE_ENV"] === "production")) {
    add("G11", "TEST_CLOCK_OFFSET_SECONDS", "the test clock must not be set in production (profile or NODE_ENV)");
  }

  // G8: the web->kernel HMAC secret (RT-31, SEC-14).
  const secret = set(env, "SERVICE_TOKEN_SECRET");
  if (secret === undefined) add("G8", "SERVICE_TOKEN_SECRET", "is required");
  else {
    if (new TextEncoder().encode(secret).length < 32) add("G8", "SERVICE_TOKEN_SECRET", "must be at least 32 bytes");
    if (PLACEHOLDER.test(secret.trim())) add("G8", "SERVICE_TOKEN_SECRET", "is a placeholder");
    if (secret === set(env, "KERNEL_SIGNER_PRIVATE_KEY") || secret === set(env, "GUARDIAN_PRIVATE_KEY")) {
      add("G8", "SERVICE_TOKEN_SECRET", "must not reuse a signing key");
    }
  }

  if (set(env, "DATABASE_URL") === undefined) add("G8", "DATABASE_URL", "is required");

  const evidenceMode = set(env, "EVIDENCE_MODE") ?? "live";
  const signerKey = set(env, "KERNEL_SIGNER_PRIVATE_KEY");
  if (signerKey === undefined) add("G2", "KERNEL_SIGNER_PRIVATE_KEY", "is required");
  const signerAddr = signerKey === undefined ? null : addressOfKey(signerKey);
  if (signerKey !== undefined && signerAddr === null) add("G2", "KERNEL_SIGNER_PRIVATE_KEY", "is not a valid secp256k1 private key");

  if (profile === "production") {
    if (evidenceMode !== "live") add("G5", "EVIDENCE_MODE", 'production requires "live" evidence (fixtures would accept invented evidence)');
    for (const name of Object.keys(env)) {
      if (/^CHALLENGE_/.test(name) && set(env, name) !== undefined) add("G9", name, "challenge switches must not be set in the production profile");
    }
    if (set(env, "NETWORK") === undefined) add("G1", "NETWORK", "is required");
    return v;
  }

  // --- sandbox -----------------------------------------------------------------------------------------------------
  const network = set(env, "NETWORK");
  if (network !== "testnet" && network !== "local") add("G1", "NETWORK", "the sandbox runs on testnet or local only");

  const denied = listAddresses(env["PROD_SIGNER_ADDRESSES"]);
  if (signerAddr !== null && denied.includes(signerAddr)) add("G2", "KERNEL_SIGNER_PRIVATE_KEY", "the signer address is a production signer");
  const guardianKey = set(env, "GUARDIAN_PRIVATE_KEY");
  if (guardianKey !== undefined) {
    const g = addressOfKey(guardianKey);
    if (g === null) add("G2", "GUARDIAN_PRIVATE_KEY", "is not a valid secp256k1 private key");
    else if (denied.includes(g)) add("G2", "GUARDIAN_PRIVATE_KEY", "the guardian address is a production address");
  }

  for (const name of Object.keys(env)) {
    if (/^(PROD|MAINNET)_/.test(name) && !DENYLIST_NAMES.has(name) && env[name] !== undefined) {
      add("G3", name, "a production/mainnet variable is present in the sandbox environment");
    }
  }

  const prodHost = set(env, "PROD_SUPABASE_HOST")?.toLowerCase();
  for (const name of ["DATABASE_URL", "SUPABASE_URL"] as const) {
    const value = set(env, name);
    if (value === undefined) continue;
    const host = hostOf(value);
    if (host === null) add("G4", name, "is not a valid URL");
    else if (prodHost !== undefined && (host === prodHost || host.endsWith(`.${prodHost}`))) add("G4", name, "points at the production database host");
  }

  if (evidenceMode !== "fixtures") add("G5", "EVIDENCE_MODE", 'the sandbox requires "fixtures" (no outbound evidence fetches)');

  const budget = set(env, "CHALLENGE_LLM_DAILY_BUDGET_USD");
  if (budget === undefined || !/^[0-9]+(\.[0-9]{1,6})?$/.test(budget) || /^0+(\.0+)?$/.test(budget)) {
    add("G6", "CHALLENGE_LLM_DAILY_BUDGET_USD", "must be a positive decimal amount");
  }
  const salt = set(env, "CHALLENGE_IP_SALT");
  if (salt === undefined || salt.length < 16) add("G6", "CHALLENGE_IP_SALT", "must be set (>= 16 characters)");

  return v;
}

export class BootError extends Error {
  readonly violations: readonly BootViolation[];
  constructor(violations: readonly BootViolation[]) {
    super(`boot guards failed: ${violations.map((x) => `${x.rule} ${x.variable}`).join("; ")}`);
    this.name = "BootError";
    this.violations = violations;
  }
}

/** Throws BootError (names and rules only, no values) unless every guard holds. */
export function assertBootGuards(env: EnvLike): void {
  const violations = evaluateBootGuards(env);
  if (violations.length > 0) throw new BootError(violations);
}
