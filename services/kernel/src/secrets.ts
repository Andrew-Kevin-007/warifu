// The inventory of configured secrets (SEC-07). One list drives three things: the >= 16 character boot guard (a short
// secret cannot be redacted reliably, so it is refused instead of silently left in the clear), the log redactor, and
// the config's Secret wrappers.
import type { EnvLike } from "./types";

/** Secret env names from services/kernel/.env.example plus the sandbox salt and the LLM key. */
export const NAMED_SECRETS = [
  "SERVICE_TOKEN_SECRET",
  "KERNEL_SIGNER_PRIVATE_KEY",
  "GUARDIAN_PRIVATE_KEY",
  "CIRCLE_API_KEY",
  "CIRCLE_ENTITY_SECRET",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "CHALLENGE_IP_SALT",
  "CIRCLE_WEBHOOK_SECRET",
] as const;

/** Any other variable that looks like a credential is treated as one (so a new secret cannot be forgotten here). */
const SECRET_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|SERVICE_ROLE_KEY|_SALT)$/;
/** Looks secret by name but is a public identifier or a list of addresses. */
const NOT_SECRET = new Set(["CIRCLE_WEBHOOK_PUBLIC_KEY_ID", "PROD_SIGNER_ADDRESSES"]);

export const MIN_SECRET_CHARS = 16;

export function secretNames(env: EnvLike): string[] {
  const names = new Set<string>(NAMED_SECRETS);
  for (const k of Object.keys(env)) if (SECRET_NAME.test(k) && !NOT_SECRET.has(k)) names.add(k);
  return [...names].sort();
}

/** [name, value] of every secret that is actually configured (non-empty). */
export function configuredSecrets(env: EnvLike): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const n of secretNames(env)) {
    const v = env[n];
    if (v !== undefined && v.trim() !== "") out.push([n, v]);
  }
  return out;
}

/** The credentials embedded in a connection URL: the userinfo, the password and the user, raw and URL-decoded. */
export function urlSecrets(url: string | undefined): string[] {
  if (url === undefined || url === "") return [];
  const out = new Set<string>([url]);
  const add = (v: string): void => {
    if (v !== "") {
      out.add(v);
      try {
        out.add(decodeURIComponent(v));
      } catch {
        // not percent-encoded text
      }
    }
  };
  try {
    const u = new URL(url);
    add(u.password);
    add(u.username);
    if (u.password !== "") add(`${u.username}:${u.password}`);
    else if (u.username !== "") add(u.username);
    for (const [, v] of u.searchParams) if (v.length >= 8) add(v); // ?password=... / ?sslkey=...
  } catch {
    // not a URL: the whole string is already in the set
  }
  return [...out];
}

/** Every string that must never appear in a log line: all configured secrets and everything inside the URL credentials. */
export function redactionList(env: EnvLike): string[] {
  const out = new Set<string>();
  for (const [, value] of configuredSecrets(env)) out.add(value);
  for (const n of ["DATABASE_URL", "SUPABASE_URL"]) for (const s of urlSecrets(env[n])) out.add(s);
  // A URL's user name alone is not secret enough to bother (and too short to redact safely): keep what is >= 8.
  return [...out].filter((s) => s.length >= 8);
}
