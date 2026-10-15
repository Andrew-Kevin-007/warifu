# Going to Arc mainnet (production profile)

Owner: Kevin runs every step that spends real money or touches a real key. Agents never receive, print or commit a mainnet key (AGENTS.md §0.10). The sandbox (challenge) never runs on mainnet: boot guard G1 refuses it and G3 refuses any `PROD_*`, `MAINNET_*` or `ARC_MAINNET_*` variable in a sandbox environment.

## What the code enforces (2026-10-15)

| Where | Rule |
|---|---|
| `packages/chain/src/config.ts` | No mainnet chain id is hardcoded (V-03). `NETWORK=mainnet` needs `ARC_MAINNET_CHAIN_ID` (a positive integer that is not the testnet or local id) and `ARC_MAINNET_RPC_URL` (https, no credentials, not loopback). A stray `ARC_RPC_URL` is refused, so a testnet endpoint can't be picked up by accident. A `deployments/mainnet.json` parses only when that id is passed in. |
| `services/kernel/src/main.ts` | Before anything else runs, `verifyRpcChainId` asks the live node for its chain id and stops the process on a mismatch. |
| `services/kernel/src/config.ts` | Mainnet runs only in the `production` profile, with live evidence and no scheduler test clock. The raw-key relayer (`RELAYER_PRIVATE_KEY`) is refused on mainnet: submission goes through the Circle relayer, or nothing is submitted. |
| `services/kernel/src/circle/wallet.ts` | `CIRCLE_BLOCKCHAIN` is never defaulted on mainnet. It must be an Arc identifier and never a testnet one, and Circle rejects an identifier it doesn't know. |
| `contracts/script/Deploy.s.sol` | Any chain other than Arc testnet or local is treated as mainnet. A sandbox deploy there reverts, and production caps are held under the script's mainnet ceilings until independently reviewed. Every immutable is read back and compared after deploy. |

## Facts to take from the docs first (V-03, not verified by any agent)

Write each one into `docs/VERIFY_LOG.md` with its URL before you use it:

1. Arc mainnet chain id and an https RPC endpoint: `https://docs.arc.io/llms.txt`, network page.
2. USDC ERC-20 interface address on Arc mainnet: the contract-addresses page. Never copy it from a blog or chat. The vault reads `decimals()` on chain, and the deploy script compares it.
3. Circle's `blockchain` identifier for Arc mainnet, and whether developer-controlled wallets support it: `https://developers.circle.com/llms.txt`. Use the **mainnet** API key; it is separate from the testnet key.
4. Fee floor and finality on mainnet (testnet: a 20 gwei `maxFeePerGas` floor). If finality differs, set `INDEXER_CONFIRMATIONS` to match (V-24).

## Steps

1. **Keys (yours, offline).** Create fresh keys for owner, kernel signer and guardian. Never reuse a testnet or sandbox key; SEC-04 rejects shared addresses. Keep the deployer in a forge keystore (`--account`), never in env.
2. **Deploy the vault.** From `contracts/`, with the mainnet USDC address and small caps:
   `VAULT_PROFILE=production VAULT_TOKEN=<USDC> VAULT_OWNER=… VAULT_KERNEL_SIGNER=… VAULT_GUARDIAN=… VAULT_PER_TX_CAP=… VAULT_DAILY_CAP=… VAULT_HOURLY_CAP=… VAULT_HUMAN_THRESHOLD=… VAULT_PAYEE_CHANGE_DELAY=172800 VAULT_SIGNER_CHANGE_DELAY=86400 GIT_SHA=$(git rev-parse HEAD) arc-forge script script/Deploy.s.sol:DeployVault --rpc-url $ARC_MAINNET_RPC_URL --account <keystore> --broadcast`
   This writes `deployments/mainnet.json`. Copy `txHash` and `blockNumber` from `broadcast/Deploy.s.sol/<chainId>/run-latest.json`.
3. **Relayer wallet (Circle, mainnet key).** `NETWORK=mainnet CIRCLE_BLOCKCHAIN=<from step 3 of the facts> node --import tsx services/kernel/scripts/generate-wallet.ts wallet --profile production`. Fund the printed address with a small amount of USDC for gas.
4. **Kernel env (production host only).** `KERNEL_PROFILE=production`, `NETWORK=mainnet`, `ARC_MAINNET_CHAIN_ID`, `ARC_MAINNET_RPC_URL`, `ARC_RPC_URL` unset, `EVIDENCE_MODE=live`, Circle mainnet key, entity secret and relayer wallet, kernel signer key, guardian key, `INDEXER_START_BLOCK=<deploy block>`, and its own `DATABASE_URL`. The kernel refuses to start if any of this is missing or inconsistent.
5. **Smoke test with one small real payment** to a wallet you control, labelled `internal` (self-dealing is never traction, AGENTS.md §6). Then check the receipt at `/audit` and the vault's certificate at `/certificate/<vault>`.
6. **Web.** Set `NEXT_PUBLIC_ARC_RPC_URL` to the mainnet RPC on the production web project only. The challenge web project stays on testnet.
7. **Traction.** Only a real pilot's payment becomes a `traction_events` row (`network=mainnet`, `real`). Then run `arc-canteen update traction`.

## Rollback

The guardian pauses the vault (pause-only role). The breaker halts the kernel. Funds stay in the vault, and only the owner can withdraw.
