#!/usr/bin/env node
// pnpm env:init [--force]
// Writes services/kernel/.env.local and apps/web/.env.local (both git-ignored). Every key you must obtain yourself is a
// PASTE_<NAME>_HERE placeholder: the kernel and the web tier read a placeholder as "not set", so nothing half-boots on it.
// Internal secrets that are not API keys (the kernel<->web HMAC secret, the challenge IP salt) are generated here, once,
// and the same HMAC value goes into both files. An existing file is never overwritten without --force.
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const force = process.argv.includes("--force");
const rand = () => randomBytes(32).toString("base64url");
const P = (name) => `PASTE_${name}_HERE`;

export function kernelEnv({ serviceSecret, ipSalt }) {
  return `# services/kernel/.env.local (git-ignored). Sandbox profile on Arc testnet = the public challenge deployment.
# PASTE_*_HERE = you provide it; until then that feature is off or the kernel refuses to boot with a message naming it.
# Generated for you: SERVICE_TOKEN_SECRET, CHALLENGE_IP_SALT. Never commit this file, never paste it into chat.

KERNEL_PROFILE=sandbox            # sandbox | production (production needs its own keys, DB, vault: INV-16)
NETWORK=testnet                   # testnet | local   (mainnet: production profile only, docs/DEPLOY_MAINNET.md)
EVIDENCE_MODE=fixtures            # sandbox: fixtures; production: live
HOST=127.0.0.1
PORT=8787

# --- Chain (Canteen testnet RPC: run \`arc-canteen rpc\`) ------------------------------------------------------------
ARC_RPC_URL=${P("ARC_RPC_URL")}
INDEXER_START_BLOCK=0             # set to the sandbox vault's deployment block

# --- Database (local Postgres on D: works as is; for Supabase paste its direct connection string) ------------------
DATABASE_URL=postgres://postgres@localhost:54329/symbolon_local
SUPABASE_URL=${P("SUPABASE_URL")}
SUPABASE_SERVICE_ROLE_KEY=${P("SUPABASE_SERVICE_ROLE_KEY")}

# --- Keys (throwaway TESTNET keys only for the sandbox; each role its own key) ----------------------------------------
KERNEL_SIGNER_PRIVATE_KEY=${P("KERNEL_SIGNER_PRIVATE_KEY")}
GUARDIAN_PRIVATE_KEY=${P("GUARDIAN_PRIVATE_KEY")}
# Relayer: EITHER the throwaway key below OR the four Circle values, never both.
RELAYER_PRIVATE_KEY=${P("RELAYER_PRIVATE_KEY")}
CIRCLE_API_KEY=${P("CIRCLE_API_KEY")}
CIRCLE_ENTITY_SECRET=${P("CIRCLE_ENTITY_SECRET")}
RELAYER_WALLET_ID=${P("RELAYER_WALLET_ID")}
RELAYER_WALLET_ADDRESS=${P("RELAYER_WALLET_ADDRESS")}
CIRCLE_WEBHOOK_PUBLIC_KEY_ID=${P("CIRCLE_WEBHOOK_PUBLIC_KEY_ID")}
CIRCLE_BLOCKCHAIN=ARC-TESTNET

# --- LLM (extractor, planner, house attackers). Sandbox key must carry a provider-side monthly spend cap. -----------
ANTHROPIC_API_KEY=${P("ANTHROPIC_API_KEY")}
GITHUB_TOKEN=${P("GITHUB_TOKEN")}   # optional, production CI evidence only

# --- Internal (generated) --------------------------------------------------------------------------------------------
SERVICE_TOKEN_SECRET=${serviceSecret}
CHALLENGE_IP_SALT=${ipSalt}
CHALLENGE_ENABLED=true
CHALLENGE_LLM_DAILY_BUDGET_USD=5

# --- Sandbox boot guards (docs/15 section 3). Fill with the PRODUCTION addresses/host so the sandbox refuses to reuse them.
PROD_SIGNER_ADDRESSES=
PROD_SUPABASE_HOST=
`;
}

export function webEnv({ serviceSecret }) {
  return `# apps/web/.env.local (git-ignored). NO payment or signing secrets here (INV-11).
# WEB_SVC_SECRET must equal the kernel's service-token secret (already copied for you).

WEB_SVC_URL=http://127.0.0.1:8787
WEB_SVC_SECRET=${serviceSecret}
WEB_SVC_TENANT_ID=${P("WEB_SVC_TENANT_ID")}       # printed by \`pnpm kernel:tenant\`
WEB_SVC_PROFILE=sandbox

# Public, non-secret (inlined into the browser bundle)
NEXT_PUBLIC_PROFILE=app                            # app | challenge
NEXT_PUBLIC_SITE_URL=http://localhost:3000
# (left empty on purpose: an empty value makes the page fall back to the RECORDED replay; fill when the sandbox is deployed)
NEXT_PUBLIC_CHAIN_ID=              # paste the Arc testnet chain id
NEXT_PUBLIC_ARC_RPC_URL=           # paste a public read-only RPC URL (no key in it)
NEXT_PUBLIC_SANDBOX_VAULT=         # paste the sandbox vault address after deploy
NEXT_PUBLIC_CHALLENGE_URL=         # paste the challenge origin URL once deployed
`;
}

function main() {
  const serviceSecret = rand();
  const ipSalt = rand();
  const targets = [
    [join(root, "services", "kernel", ".env.local"), kernelEnv({ serviceSecret, ipSalt })],
    [join(root, "apps", "web", ".env.local"), webEnv({ serviceSecret })],
  ];
  for (const [path, body] of targets) {
    if (existsSync(path) && !force) {
      console.log(`kept    ${path} (exists; --force to regenerate)`);
      continue;
    }
    writeFileSync(path, body, { encoding: "utf8", mode: 0o600 });
    console.log(`wrote   ${path}`);
  }
  console.log("\nNext: open both files and replace every PASTE_*_HERE you have a value for. The rest can stay.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
