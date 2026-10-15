# Operator setup: every account, key and ID Warifu needs, and how to get each one

For Kevin. Work top to bottom; each step names exactly what you end up holding and where it goes.
Mainnet-specific steps are in `docs/DEPLOY_MAINNET.md`; this file points to them at the right moment.

## The three rules

1. **A secret goes in exactly two places:** your password manager and the host's environment-variable screen (Railway/Fly, Vercel). It never goes in chat, in the repo, in a screenshot, or in a `.env` you commit. The agents never need one.
2. **Production and sandbox share nothing:** a different key, database, Circle API key, vault and domain for each (INV-16). The sandbox is the public challenge. It is attackable by design and stays on testnet.
3. **Values you can send back to the agents** are only the non-secret ones: vault addresses, the tenant ID, domains, social handles, and a fact from the docs together with its URL.

## What you end up with

| # | Thing | Secret? | Production (testnet now, mainnet later) | Sandbox / challenge (testnet only) |
|---|---|---|---|---|
| 1 | Owner wallet (signs engagements and approvals in the browser) | key: yes | your main wallet | a separate throwaway wallet |
| 2 | Kernel signer key | yes | `KERNEL_SIGNER_PRIVATE_KEY` | its own key |
| 3 | Guardian key (pause-only) | yes | `GUARDIAN_PRIVATE_KEY` | its own key |
| 4 | Deployer keystore (deploys the vault) | yes | forge keystore | may be the same keystore on testnet |
| 5 | Arc RPC URL | token inside: yes | `ARC_RPC_URL` (testnet) / `ARC_MAINNET_RPC_URL` | `ARC_RPC_URL` |
| 6 | Vault address | no | `deployments/testnet.json` → production | `deployments/testnet.json` → sandbox |
| 7 | Postgres database | URL: yes | `DATABASE_URL` | another project's `DATABASE_URL` |
| 8 | Tenant ID | no | `WEB_SVC_TENANT_ID` | `WEB_SVC_TENANT_ID` |
| 9 | Service-token secret (web ↔ kernel) | yes | `SERVICE_TOKEN_SECRET` = `WEB_SVC_SECRET` | its own |
| 10 | Circle API key + entity secret | yes | `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` | separate API key and wallet set |
| 11 | Circle relayer wallet | no | `RELAYER_WALLET_ID`, `RELAYER_WALLET_ADDRESS` | its own |
| 12 | Circle webhook key ID(s) | no | `CIRCLE_WEBHOOK_PUBLIC_KEY_ID` | its own |
| 13 | Anthropic API key (challenge AI and extractor) | yes | optional | `ANTHROPIC_API_KEY` + a daily budget |
| 14 | Kernel host URL | no | e.g. `https://kernel.<your-domain>` | `https://kernel-challenge.<your-domain>` |
| 15 | Web domains | no | app domain | a **different** domain for the challenge |

---

## Step 0. Tools on your laptop (once)

- **Node 22.15 or newer.** `node --version`. The repo runs its TypeScript directly on Node 22, so nothing else is needed.
- **pnpm:** `corepack enable`. The repo pins pnpm itself, then run `pnpm install` at the repo root.
- **Arc Foundry** (`arc-forge`, `arc-cast`, `arc-anvil`) and the **`arc-canteen`** CLI: install them as the Arc docs describe (`https://docs.arc.io/llms.txt`). Stock Foundry works locally, but use the Arc builds against Arc.
- **Git:** you already have it. The agents can push now, and you merge PRs on GitHub.

## Step 1. Keys and wallets (about 15 minutes)

Make **fresh** keys. Never reuse a key across production, sandbox and mainnet; the deploy script and the deployments-file parser refuse shared addresses (SEC-04).

1. **Deployer keystore** (encrypted on disk, never in env):
   `arc-cast wallet new` → then `arc-cast wallet import warifu-deployer --interactive` and paste that private key into the prompt. You choose a password. Later you deploy with `--account warifu-deployer`.
2. **Kernel signer, guardian (×2 profiles):** run `arc-cast wallet new` four times: production signer, production guardian, sandbox signer and sandbox guardian. Save each private key and address in your password manager. Only the addresses go into the vault deploy; the private keys go into the kernel host's env.
3. **Owner:** your browser wallet (MetaMask or similar) for production, and a second, separate account for the sandbox. Add the Arc network to the wallet using the values from the Arc docs.
4. **Fund for gas.** Arc uses USDC as gas. On testnet, get USDC from Circle's testnet faucet (linked from the Arc docs) for the deployer, both owners and the relayer wallet (step 5).

## Step 2. Arc RPC (2 minutes)

- Testnet: `arc-canteen rpc` prints your Canteen-hosted RPC URL. That is `ARC_RPC_URL`. It carries a token, so treat it as a secret. Tokens last 90 days; `arc-canteen rotate-rpc-key` gives you a new one if auth fails.
- Mainnet: `docs/DEPLOY_MAINNET.md`, "Facts to take from the docs first".
- Also note a **public** RPC URL (no token) for the browser receipt verifier: `NEXT_PUBLIC_ARC_RPC_URL`. If Arc has no public endpoint without a token, leave it unset; the verifier then says so instead of guessing.

## Step 3. Deploy the vaults (testnet; about 10 minutes)

Get the USDC ERC-20 address from Arc's contract-addresses page. Never copy it from a chat or blog. From `contracts/`:

**Production vault (testnet):**
```
VAULT_PROFILE=production VAULT_TOKEN=<USDC address> VAULT_OWNER=<production owner> \
VAULT_KERNEL_SIGNER=<prod signer address> VAULT_GUARDIAN=<prod guardian address> \
VAULT_PER_TX_CAP=100000000 VAULT_DAILY_CAP=200000000 VAULT_HOURLY_CAP=25000000 VAULT_HUMAN_THRESHOLD=50000000 \
VAULT_PAYEE_CHANGE_DELAY=172800 VAULT_SIGNER_CHANGE_DELAY=86400 GIT_SHA=$(git rev-parse HEAD) \
arc-forge script script/Deploy.s.sol:DeployVault --rpc-url "$ARC_RPC_URL" --account warifu-deployer --broadcast
```
Amounts are USDC base units at 6 decimals (`100000000` = 100 USDC). The script reads the token's decimals on chain and reverts if anything it reads back differs from what you passed.

**Sandbox vault (testnet):** the same command with `VAULT_PROFILE=sandbox`, the sandbox owner, signer and guardian, and caps within the sandbox limits (per-tx ≤ 25 USDC, daily ≤ 60 USDC), e.g. `VAULT_PER_TX_CAP=25000000 VAULT_DAILY_CAP=60000000 VAULT_HOURLY_CAP=0 VAULT_HUMAN_THRESHOLD=10000000`.

Both write into `deployments/testnet.json`. Add the `txHash` and `blockNumber` from `contracts/broadcast/Deploy.s.sol/<chainId>/run-latest.json` to each group, then commit the file. It holds only public addresses. **Send the agents the vault addresses**: they wire the certificate, Seal and Dojo pages to them.

Fund the production vault with a small amount of USDC (send to the vault address from the owner).

## Step 4. Databases (about 10 minutes)

Create **two** Postgres databases: production and sandbox. Supabase works (two separate projects), as does any managed Postgres 15+.
- For each one, copy the **direct connection string** (`postgres://…`, with a password of at least 16 characters). That is `DATABASE_URL`.
- Apply the migrations from the repo root, once per database:
  ```
  DATABASE_URL='<production url>' pnpm kernel:migrate -- --profile production
  DATABASE_URL='<sandbox url>'    pnpm kernel:migrate -- --profile sandbox
  ```
  This applies every pending migration in order, records each one, and stamps the database's profile permanently. Run it again after every release; it applies only what is new. It refuses to use a production-stamped database as sandbox or the reverse.
- Note (V-15): the migrations have been tested on local Postgres 17 with a Supabase-like role setup, not yet on a real Supabase project. If a migration errors there, send the agents the error line, not the URL.

## Step 5. Policy and tenant (5 minutes)

1. Copy `packages/policy/test/fixtures/spec-04-section7.yaml` to a private file and edit it for the business: caps (must fit inside the vault you deployed), categories and the evidence URL allow-list.
2. Create the tenant (the business record the kernel works for):
   ```
   DATABASE_URL='<production url>' pnpm kernel:tenant -- --profile production --kind pilot \
     --name "<business name>" --owner <production owner address> \
     --deployments deployments/testnet.json --policy <your policy.yaml>
   ```
   It refuses a policy looser than the vault, an owner that isn't the vault owner, and any kind/profile mix that would break INV-16/17. It prints `WEB_SVC_TENANT_ID=<uuid>`; keep that.
3. Sandbox: the same command with `--profile sandbox --kind challenge`, the sandbox owner and the sandbox database.

## Step 6. Circle developer-controlled wallets (about 20 minutes, once per network)

1. Create a Circle developer account and a **testnet** API key (mainnet later, as a separate key). Keep a separate key for the sandbox.
2. Entity secret:
   `node --import tsx services/kernel/scripts/generate-wallet.ts entity-secret --out D:\secrets\circle-entity-secret.txt`
   This writes a new 32-byte secret to a file outside the repo and never prints it. Register it with Circle as their docs describe, and keep the recovery file Circle gives you.
3. Relayer wallet (PowerShell: set the two variables with `$env:NAME='…'` in that window only):
   `CIRCLE_API_KEY=… CIRCLE_ENTITY_SECRET=… node --import tsx services/kernel/scripts/generate-wallet.ts wallet --profile production`
   It prints `RELAYER_WALLET_ID` and `RELAYER_WALLET_ADDRESS`. Fund that address with USDC for gas. Repeat with `--profile sandbox` and the sandbox key.
   (If `tsx` is not installed, use `node --experimental-transform-types --import ./packages/blast-radius/scripts/register-ts.mjs` in its place.)
4. Webhook: in the Circle console, add a notification subscription pointing at `https://<kernel host>/webhooks/circle`. Circle shows the public key ID(s) it signs with; put them, comma-separated, in `CIRCLE_WEBHOOK_PUBLIC_KEY_ID`. If empty, the kernel refuses every webhook, which is safe but means no push updates; it still polls the chain.

Circle is optional for a first run. Without it, the kernel collects signatures but doesn't submit; on testnet only, `RELAYER_PRIVATE_KEY` (a funded throwaway key) can submit instead. Mainnet refuses the raw-key relayer.

## Step 7. Host the kernel (Railway or Fly; about 15 minutes per profile)

Create **two** services from this repo: production and sandbox.
- Build: Dockerfile at `services/kernel/Dockerfile`, with the build context at the **repo root**. It has not yet been built on a real host (the dev machine has no Docker); if the first build fails, send the agents the last 30 lines of the build log.
- Optional volume mounted at `/data/blobs`, with `BLOB_DIR=/data/blobs` (production only).
- Health: the service listens on `PORT` (8787) once every boot check passes. If a check fails it exits and logs which rule failed (`reasonCode`), never a value.

**Production env** (set in the host's variables screen):

| Variable | Value |
|---|---|
| `KERNEL_PROFILE` | `production` |
| `NETWORK` | `testnet` (mainnet later: `docs/DEPLOY_MAINNET.md`) |
| `ARC_RPC_URL` | step 2 |
| `DATABASE_URL` | production database |
| `SERVICE_TOKEN_SECRET` | `openssl rand -hex 32`. The **same** value goes to the web app as `WEB_SVC_SECRET` |
| `KERNEL_SIGNER_PRIVATE_KEY` | production signer |
| `GUARDIAN_PRIVATE_KEY` | production guardian |
| `EVIDENCE_MODE` | `live` |
| `INDEXER_START_BLOCK` | the vault's deploy block |
| `GIT_SHA` | the deployed commit (enables the Loss Bound Certificate) |
| `CIRCLE_*`, `RELAYER_WALLET_*` | step 6 (optional) |
| `GITHUB_TOKEN` | optional; for CI-pass evidence on private repos |
| `HOST` / `PORT` | the image sets `0.0.0.0` / `8787` |

**Sandbox env:** `KERNEL_PROFILE=sandbox`, `NETWORK=testnet`, `EVIDENCE_MODE=fixtures`, the sandbox database, signer, guardian and secret, `CHALLENGE_LLM_DAILY_BUDGET_USD` (a small cap, e.g. `5`), `CHALLENGE_IP_SALT` (`openssl rand -hex 16`), `ANTHROPIC_API_KEY` (a key used only here), `PROD_SIGNER_ADDRESSES` (production signer and guardian addresses, comma-separated, so the sandbox refuses them), and `PROD_SUPABASE_HOST` (the production DB host, so the sandbox refuses it). The sandbox must contain no `PROD_*` (except those two lists), `MAINNET_*` or `ARC_MAINNET_*` variable; the boot guards refuse to start otherwise. The challenge service (WP-32) may add variables; this table will be updated when it lands.

## Step 8. Web on Vercel (two projects)

Settings for both: Root Directory `apps/web`, Node 22.x, Framework Next.js (`docs/DEPLOY_VERCEL.md`).

**App project** (your main domain):

| Variable | Value | Secret? |
|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | `https://<app domain>` | no |
| `NEXT_PUBLIC_CHAIN_ID` | the chain ID the vault is on | no |
| `NEXT_PUBLIC_ARC_RPC_URL` | public RPC for the receipt verifier (step 2) | must not contain a token |
| `NEXT_PUBLIC_SANDBOX_VAULT` | sandbox vault address (judge page links) | no |
| `NEXT_PUBLIC_CHALLENGE_URL` | `https://<challenge domain>` | no |
| `WEB_SVC_URL` | production kernel URL | no |
| `WEB_SVC_SECRET` | = production `SERVICE_TOKEN_SECRET` | **yes**, server-only (never `NEXT_PUBLIC_`) |
| `WEB_SVC_TENANT_ID` | step 5 | no |
| `WEB_SVC_PROFILE` | `production` | no |

**Challenge project** (a **different** domain; no wallet code is built into it):
`NEXT_PUBLIC_PROFILE=challenge`, `NEXT_PUBLIC_SITE_URL=https://<challenge domain>`, `WEB_SVC_URL` = sandbox kernel, `WEB_SVC_SECRET` = sandbox secret, `WEB_SVC_TENANT_ID` = sandbox tenant, `WEB_SVC_PROFILE=sandbox`.

Never put a private key, `CIRCLE_*`, `KERNEL_*`, `GUARDIAN_*` or `DATABASE_URL` into a Vercel project; `pnpm test:web-env` fails the build if the code ever reads one.

## Step 9. Smoke test (15 minutes)

1. Open `/dashboard` on the app domain and connect the owner wallet. The vault balance and caps show.
2. `/engagements/new`: create one engagement with a payee you control. Sign as owner, then open the payee link (`/sign/<token>`) in the payee's wallet and sign.
3. `/intents/new`: paste a short invoice for that milestone. Watch the decision on `/intents/<id>`. Approve if it asks.
4. After release: open the receipt at `/audit/<receiptHash>`. It must verify in the browser. Then open `/certificate/<vault>` and `/seal/<vault>`.
5. Try one refusal on purpose (a different payee address in the invoice). You get a REJECT with a Nice-try line and `/share/<receiptHash>`.
6. The challenge domain: `/challenge` loads with no wallet prompt, and an attempt shows up in the Dojo counter.

A payment between your own wallets is labelled `internal` and is **never** traction (AGENTS.md §6).

## Step 10. After the first real payment

- A real pilot's payment → `traction_events` row (`network`, `real`, `tenant`, `amount_base_units`, `tx_hash`), then run `arc-canteen update traction`. Product milestones → `arc-canteen update product`.
- Mainnet: `docs/DEPLOY_MAINNET.md` (separate Circle mainnet key, fresh keys, small caps, one small smoke payment labelled `internal`).

## What to send the agents (and only this)

- Vault addresses and deploy blocks, as the committed `deployments/testnet.json` (or just the addresses).
- Kernel URLs, the app domain and the challenge domain.
- The production and sandbox tenant IDs.
- Real social handles for the footer (Discord, X, Telegram, GitHub), or "remove them".
- Any Arc or Circle fact you read in their docs, with its URL (for `docs/VERIFY_LOG.md`).
- On failure: the last 30 lines of the log, with secrets cut out.

## If something goes wrong

- **Kernel exits at boot:** the log line `kernel.boot_failed` names the rule (e.g. `G1_NETWORK`, `CHAIN_ID_MISMATCH`). Fix that variable; nothing else is wrong.
- **Pause everything:** the guardian can pause the vault (pause-only), and the breaker halts the kernel. Funds stay in the vault, and only the owner can withdraw.
- **A secret leaked:** rotate it at the source (Circle console, `arc-canteen rotate-rpc-key`, a new signer through the vault's delayed signer change), then update the host env.
