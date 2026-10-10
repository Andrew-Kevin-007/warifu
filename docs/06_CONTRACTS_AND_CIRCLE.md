# 06 — CONTRACTS & CIRCLE/ARC INTEGRATION

> **v2 delta (contracts):** `configHash()` + `ConfigChanged` + `engagementIds`/`engagementCount()`/`engagementIdAt()` + `RING_SIZE` so a Loss Bound Certificate can be recomputed from chain state (`16` §2.4); `paymentTerms` is inside the `termsHash` preimage (no EIP-712 struct change); byte-reproducible builds; **no limit setters** (changing P/D/H/hourlyCap = new vault). **v2 delta (integration):** sandbox env vars and a second wallet set; webhook hardening; B0 baseline vendoring. If your repo already contains v1 contracts, these are **additive** changes (WP-07/08).

## Part A: `SymbolonVault.sol`

### A.1 Purpose
A per-business, **non-custodial** USDC vault. It releases funds only when (1) the **kernel signer** attests, (2) the payee is a **registered** engagement payee, (3) engagement/time/cap invariants hold, (4) per-tx and rolling-24 h caps hold, (5) amounts above `humanThreshold` carry an **owner approval**, and (6) the `intentId` has never been used. The owner can always pause and withdraw.

### A.2 Roles
| Role | Can | Cannot |
|---|---|---|
| **owner** | register engagements (with payee sig), pause/unpause, withdraw, propose payee change & signer rotation, close engagements, set guardian | n/a |
| **kernelSigner** | sign `Attestation`s | create payees, raise caps, withdraw, unpause |
| **guardian** | `pause()` only | unpause, withdraw, anything else |
| **payee** | co-sign engagement and payee change | withdraw on their own |
| **relayer** (anyone) | submit already-signed messages (pays gas) | change any message |

### A.3 State
```solidity
IERC20  public immutable token;          // USDC ERC-20 on Arc (address from docs; NEVER hardcode in code paths)
uint8   public immutable tokenDecimals;  // read at deploy; asserted by kernel (V-04)
address public owner; address public kernelSigner; address public guardian;
uint256 public perTxCap; uint256 public dailyCap; uint256 public humanThreshold;
uint256 public hourlyCap;                // P1 hardening found by Blast Radius (08 §8); 0 = disabled
uint32  public payeeChangeDelay; uint32 public signerChangeDelay;
bool    public paused;

struct Engagement { address payee; uint256 cap; uint256 released; uint64 start; uint64 end; bytes32 termsHash; bool active; }
mapping(bytes32 => Engagement) public engagements;
mapping(bytes32 => bool) public used;                     // intentId single-use (INV-4)
mapping(bytes32 => uint256) public engagementNonce;       // replay protection for engagement signatures
bytes32[] public engagementIds;                           // v2: push in registerEngagement (enumeration for certificates, no log scanning)
uint8 public constant RING_SIZE = 64;                     // v2: exposed so verifiers read the constant instead of assuming it

struct Rel { uint64 t; uint192 amt; }
Rel[64] private ring; uint8 private ringHead;             // EXACT rolling-24h window, max 64 releases/24h

struct PendingPayee { address newPayee; uint64 eta; }
mapping(bytes32 => PendingPayee) public pendingPayee;
address public pendingSigner; uint64 public pendingSignerEta;
```
> **Why a ring buffer and not a daily bucket:** a fixed UTC-day bucket permits ~2× `dailyCap` across the boundary; hourly buckets under-count by up to one bucket. The exact rolling window over the last 64 releases is bounded-gas and makes Blast Radius's closed form tight (`08_BLAST_RADIUS.md`). Cap on releases/24 h = 64 (revert `TooManyReleases`).

### A.4 Functions
```solidity
constructor(IERC20 token_, address owner_, address kernelSigner_, address guardian_,
            uint256 perTxCap_, uint256 dailyCap_, uint256 hourlyCap_ /* 0 = off */, uint256 humanThreshold_,
            uint32 payeeChangeDelay_, uint32 signerChangeDelay_);

// Engagement: owner + payee dual signature (smart-wallet-friendly via SignatureChecker/ERC-1271)
function registerEngagement(EngagementTerms calldata t, bytes calldata ownerSig, bytes calldata payeeSig) external;
function closeEngagement(bytes32 engagementId) external onlyOwner;

// THE release path
// `ref` + `ownerApprovalSig` are empty (zero ref, empty bytes) when a.amount <= humanThreshold.
struct OwnerApprovalRef { bytes32 receiptHash; uint64 deadline; }   // the fields of OwnerApproval the vault cannot derive from `a`
function release(Attestation calldata a, bytes calldata kernelSig,
                 OwnerApprovalRef calldata ref, bytes calldata ownerApprovalSig) external nonReentrant;

// Payee change: old payee + new payee + owner signatures, then delay
function proposePayeeChange(PayeeChange calldata pc, bytes calldata ownerSig, bytes calldata oldSig, bytes calldata newSig) external;
function executePayeeChange(bytes32 engagementId) external;

// Safety
function pause() external;                         // owner or guardian
function unpause() external onlyOwner;
function proposeKernelSigner(address next) external onlyOwner;
function executeKernelSigner() external onlyOwner; // after signerChangeDelay
function withdraw(address to, uint256 amount) external onlyOwner;   // non-custodial (INV-12)
function setGuardian(address g) external onlyOwner;                 // emits ConfigChanged

// v2: read-only surface for Loss Bound Certificates (16 §2.4)
function engagementCount() external view returns (uint256);
function engagementIdAt(uint256 i) external view returns (bytes32);
// keccak256(abi.encode(token, tokenDecimals, owner, kernelSigner, guardian, perTxCap, dailyCap, hourlyCap,
//                      humanThreshold, payeeChangeDelay, signerChangeDelay, RING_SIZE)).  `paused` and `pendingSigner*` are EXCLUDED.
function configHash() public view returns (bytes32);
event ConfigChanged(bytes32 indexed configHash);                    // constructor, setGuardian, executeKernelSigner
```
**No setters for `perTxCap`, `dailyCap`, `hourlyCap`, `humanThreshold`, delays or `token` exist or will be added in v2:** a different limit means a different vault (and a different certificate). This removes the "owner quietly loosens a cap" path and keeps certificates meaningful. `registerEngagement` verifies signatures over `EngagementTerms(…, termsHash, nonce)`; the off-chain preimage of `termsHash` includes `paymentTerms` and `milestones[].evidenceSpec` (`05` §2), so the payee's signature covers the discount terms.

**Why `release()` takes an `OwnerApprovalRef` (review fix, breaking vs the v1 text).** The owner signs `OwnerApproval` while the intent is `ESCALATE`d, so `receiptHash` inside it is the hash of the **escalation receipt the owner actually reviewed**. The attestation is signed later (at `payAt`, after the kernel's fresh re-evaluation) and carries the hash of the **final `RELEASE` receipt**, which did not exist when the owner signed. The vault therefore cannot rebuild the signed struct from `a` alone: `intentId` and `amount` come from `a` (so an approval cannot be replayed on another intent or stretched to a larger amount), while `receiptHash` and `deadline` come from `ref`. The kernel service, not the vault, binds `ref.receiptHash` to the superseded escalation decision (`04` K-12) and refuses to sign an attestation otherwise. Amounts at or below `humanThreshold` ignore `ref` and `ownerApprovalSig`.

`release` check order (revert with custom errors; **all** must pass):
1. `!paused` → `Paused`
2. `a.deadline >= block.timestamp` → `Expired`
3. `!used[a.intentId]` → `AlreadyUsed` ; then set `used[a.intentId] = true` (checks-effects-interactions)
4. verify `kernelSig` over `Attestation` by `kernelSigner` → `BadKernelSig`
5. `Engagement e = engagements[a.engagementId]`; `e.active` → `NoEngagement`
6. `a.payee == e.payee` → `PayeeMismatch` (INV-2)
7. `e.start <= block.timestamp <= e.end` → `OutOfWindow` (**enforces the time bounds the arc-escrow sample stores but never reads**)
8. `a.amount > 0 && a.amount <= perTxCap` → `PerTxCap`
9. `e.released + a.amount <= e.cap` → `EngagementCap` (INV-3)
10. rolling-24h: `sum(ring where t > now-1d) + a.amount <= dailyCap` and count < 64 → `DailyCap`/`TooManyReleases`; if `hourlyCap > 0`: `sum(ring where t > now-1h) + a.amount <= hourlyCap` → `HourlyCap`
11. if `a.amount > humanThreshold`: `ref.deadline >= block.timestamp` → `ApprovalExpired`; then verify `ownerApprovalSig` over `OwnerApproval(a.intentId, ref.receiptHash, a.amount, ref.deadline)` by `owner` (SignatureChecker, so a Safe works) → `ApprovalRequired`
12. effects: `e.released += a.amount`; push `Rel(now, amount)`
13. interaction: `token.safeTransfer(e.payee, a.amount)`; emit `Released(intentId, engagementId, payee, amount, receiptHash)`

**Arc specifics to respect:** `address(0)` transfers revert (validate constructor/withdraw args non-zero); USDC blocklist reverts consume gas without a receipt (document in README; kernel decodes failures and screens); don't use native-balance (18-dec) accounting: **the vault accounts in ERC-20 base units only**; USDC emits transfer events via the system emitter, so index the vault's own events plus `Transfer` logs per Arc's "USDC system events" doc. Compile/test/deploy with **Arc Foundry** (`arc-forge`, `arc-anvil`, `arc-cast`). Read `evm-differences.md` first.

### A.5 Foundry test plan (`contracts/test/`)
| File | Content |
|---|---|
| `Release.t.sol` | each revert path (steps 1–11) has a positive and negative test; EIP-712 vectors cross-checked with TS (`packages/receipts` test vectors). *(review fix)* Approval path: wrong `intentId`, `amount + 1`, wrong signer, tampered `ref.receiptHash`/`ref.deadline`, expired `ref.deadline` (`ApprovalExpired`) and a Safe (ERC-1271) owner each revert or pass as specified; an approval for amount X never releases X + 1; `ref`/sig are ignored at or below `humanThreshold` |
| `Engagement.t.sol` | dual-sig registration, ERC-1271 owner (mock Safe), nonce replay, bad signer |
| `PayeeChange.t.sol` | 3-sig requirement, delay, cancel on pause, no change while paused |
| `Rolling.t.sol` | exact rolling window incl. boundary at t±1 s, 64-slot saturation, wraparound |
| `Admin.t.sol` | guardian can pause not unpause; signer rotation delay; withdraw while paused |
| `Invariants.t.sol` | handler-based invariants: **INV-1..7, INV-12**; `Σ released ≤ Σ caps`; `used` monotonic; balance accounting |
| `Fuzz.t.sol` | random sequences of attestations/withdrawals/pauses; assert caps and payee set |
| `ArcDecimals.t.sol` | decimals read matches token; 6↔18 scaling confusion reverts at caps |
| `Config.t.sol` *(v2)* | `configHash()` equals the documented `abi.encode` preimage; changes on `setGuardian` and `executeKernelSigner`; **unchanged** by `pause/unpause`, `proposeKernelSigner`, releases, deposits and new engagements; `ConfigChanged` emitted exactly on those paths; `engagementIds` enumerates in registration order and matches `engagements(id)`; `RING_SIZE == 64` |
| `Build.t.sol` / CI step *(v2)* | two clean builds produce byte-identical runtime code (`foundry.toml`: `bytecode_hash = "none"`, `cbor_metadata = false`); the artifact's `immutableReferences` are recorded for `lbc verify --artifact` |
Coverage target: ≥ 95% lines, 100% of revert paths.

### A.6 Deployment
`contracts/script/Deploy.s.sol` + `scripts/deploy-vault.ts` (wrapper). Outputs `deployments/<network>.json` with `{vault, token, tokenDecimals, owner, kernelSigner, guardian, caps, deployer, txHash, blockNumber}` and a verification step reading all immutables back. *(v2)* Also records `{configHash, runtimeCodeHash, artifactPath, gitSha}`, and the file has two top-level groups: `production` and `sandbox` (the sandbox boot guard reads only `sandbox`, `15` §3). **Sandbox vaults** use throwaway keys, small caps (e.g. perTx 25, daily 60 test-USDC) and are deployed by a separate script/account from production. **Per-tenant vaults by script (P0)**; factory clones are P1. **Mainnet vaults: `perTxCap ≤ $100`, `dailyCap ≤ $200`, funded ≤ $200 total** until independently reviewed.

---

## Part B: Circle & Arc integration

### B.1 Honest Circle-tool scorecard (don't over-claim in the submission)

| Circle/Arc capability | Used for | Priority | Status after verification |
|---|---|---|---|
| **Developer-controlled wallets** | relayer wallet (EOA) that submits `release`, `registerEngagement`; optional funding wallet; *(v2)* a **separate wallet set** for the sandbox relayer | P0 | verified product; exact SDK calls V-11 |
| **USDC (ERC-20 + native gas)** | settlement asset; gas paid in USDC | P0 | verified |
| **Arc Foundry / Contracts** | build/test/deploy `SymbolonVault` | P0 | verified |
| **Compliance Engine** | counterparty address screening (K-13) | P1 | used in arc-fintech sample; access V-01 |
| **Webhooks** | transaction state sync | P0 | pattern in both samples |
| **ERC-8183 (jobs)** | kernel as deterministic evaluator adapter | P2 | testnet only; V-05 |
| **ERC-8004 (agent identity)** | register kernel/extractor identities | P2 | tutorial exists |
| **Memo contract** | anchor `receiptHash` in the payment tx metadata | P2 | docs index confirms |
| **EURC** | EUR-invoiced contractors | P2 | |
| **App Kit** (Send/Unified Balance) | optional UI balance/send | P2 | |
| **Agent Wallets / Circle CLI** | Blast Radius probe target (mainnet, OTP) | P2 | policies mainnet-only |
| Gateway / CCTP / USYC / Swap | **not used** | n/a | say so |

### B.2 Developer-controlled wallet relayer pattern
Reuse the arc-escrow approach (`generate-wallet.mjs`, entity secret registration, `createContractExecutionTransaction`).
- Relayer wallet: **EOA** (docs: choose EOA when the source can hold native token for gas; Arc gas is USDC).
- Because `release` takes a struct argument, prefer submitting **pre-encoded calldata** (viem `encodeFunctionData`) via the contract-execution API's `callData` input if supported **(V-11)**; otherwise encode `abiParameters` as the SDK requires. Log the exact working call in `docs/VERIFY_LOG.md`.
- Idempotency: Circle supports an idempotency key per transaction request; **derive it from `intentId`** so retries cannot double-submit (and the vault's `used[intentId]` backstops it).
- Webhook receiver: `POST /v1/webhooks/circle`; verify signature per Circle's notification-signature docs (pattern in arc-escrow's webhook route; V-12); *(v2, RT-30)* enforce a timestamp window and idempotency key; on `transactions.*` **trigger the reconciler only** (the reconciler trusts chain events, never the webhook body, to mark a release confirmed).
- Gas: Arc USDC gas ≈ $0.01/tx with a 20 Gwei `maxFeePerGas` floor; set fee parameters per Circle SDK; keep ≥ $2 USDC in the relayer.

### B.3 Kernel signer
Default: secp256k1 key in `KERNEL_SIGNER_PRIVATE_KEY` (kernel service only). **Disclose** in the README. If V-02 shows dev-controlled wallets can sign EIP-712 typed data, move the signer into a Circle wallet (key never in env). Rotation runbook in `12_RISKS_AND_GATES.md`.

### B.4 Chain config (`packages/chain`)
```ts
// Never hardcode token addresses; load from deployments/<network>.json produced from docs' contract-addresses page.
ArcNetwork = {
  testnet: { chainId: 5042002 /* 0x4cef52 per ARC CLI README sample; verify via eth_chainId */, rpc: process.env.ARC_RPC_URL },
  mainnet: { chainId: /* V-03 */, rpc: process.env.ARC_MAINNET_RPC_URL }
}
```
Helpers: `Money` (bigint + decimals), `toBaseUnits(string, decimals)`, `formatUnits`, `assertTokenDecimals(vault)`, event decoders (`Released`, `EngagementRegistered`), `getBalanceBaseUnits`. **No native-18-decimal values leak above this package.**

### B.5 Env vars (kernel service only unless noted)
```
NODE_ENV, NETWORK=testnet|mainnet|local, ARC_RPC_URL, ARC_MAINNET_RPC_URL, VAULT_ADDRESS (per tenant in DB)
CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_BLOCKCHAIN (ARC-TESTNET per arc-escrow README; mainnet value V-03)
RELAYER_WALLET_ID, RELAYER_WALLET_ADDRESS
KERNEL_SIGNER_PRIVATE_KEY, GUARDIAN_PRIVATE_KEY
SERVICE_TOKEN_SECRET            # HMAC for web→kernel (v2: distinct secret per profile; tokens bind tenant+audience+exp+nonce)
# v2, sandbox kernel only (KERNEL_PROFILE=sandbox; boot guards in 15 §3):
KERNEL_PROFILE=production|sandbox, EVIDENCE_MODE=live|fixtures, PROD_SIGNER_ADDRESSES (denylist), PROD_SUPABASE_HOST (denylist),
CHALLENGE_ENABLED, CHALLENGE_LLM_DAILY_BUDGET_USD, CHALLENGE_IP_SALT, ANTHROPIC_API_KEY (dedicated, provider-side spend cap)
# the sandbox kernel hosts the challenge orchestrator, which calls packages/extractor in-process (the ONLY allowed
# services->extractor import; kernel-core must still never import it)
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
GITHUB_TOKEN (optional, evidence CI reads), CIRCLE_WEBHOOK_PUBLIC_KEY_ID (V-12)
# apps/web only (NO secrets):
NEXT_PUBLIC_PROFILE=app|challenge   # v2: 'challenge' build has no wallet/signing code and no cookies
NEXT_PUBLIC_KERNEL_URL, NEXT_PUBLIC_CHAIN_ID, NEXT_PUBLIC_VAULT_ADDRESS (default tenant),
SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY (server-only, extractor)  # allowed: LLM key is not a payment secret
```
`pnpm test:web-env` fails if `apps/web` runtime can read `CIRCLE_*`, `KERNEL_*`, `GUARDIAN_*`, or `SERVICE_TOKEN_SECRET`-minting capability beyond the signed token it receives. *(v2)* A second check scans the **challenge build output** and fails if it contains wallet/signing code (`wagmi`, `signTypedData`, `eth_sendTransaction`, wallet-connect modules) or any `PROD_*`/`MAINNET_*` variable name (SEC-05/06).

### B.6 Compliance Engine (K-13, P1)
Port the screening call pattern from `circlefin/arc-fintech` (`/dashboard/compliance`). On engagement creation and daily, screen the payee address; store `{status, checkedAt, provider}` in `evidence`-like table (`screening_results`, add in a later migration). If access is unavailable (V-01), set `policy.screening.required=false`; receipts then show `SCREENING_DISABLED`. Never silently pass.

### B.7 Optional ERC-8183 adapter (P2; go/no-go at Gate G2)
Read `https://docs.arc.io/arc/tutorials/create-your-first-erc-8183-job.md`. If a job has client/provider/evaluator roles with escrow and a deliverable hash, build `Erc8183Evaluator` where **the kernel decision (not an LLM) completes the job**. Pitch: *"Circle's own agentic-commerce standard, with a deterministic evaluator."* Abort if the semantics don't map cleanly in ≤ 4 h.

### B.8 Reuse map (what to lift from the Circle samples)
| Need | Lift from | Notes |
|---|---|---|
| Next.js + Supabase scaffolding, auth, realtime | `arc-escrow`, `arc-fintech` | Apache-2.0; keep license headers; list in README "Attribution" |
| `generate-wallet.mjs` | `arc-escrow` | Creates dev-controlled wallet, writes ids to `.env.local` |
| Webhook route + signature verification | `arc-escrow` (`/api/webhooks/circle`), `arc-fintech` (`/api/circle/webhook`) | adapt to Hono |
| Compliance screening call | `arc-fintech` | V-01 |
| Vitest setup | `arc-fintech` (`vitest.config.ts`, `tests/`) | |
| **Do not reuse** *(in Symbolon)* | `validate-work` release logic | that is the pattern we replace |
| **Vendor as baseline B0 only** *(v2, WP-36)* | the release-decision path of `circlefin/arc-escrow` at a **pinned commit hash** → `packages/attack-suite/vendor/arc-escrow/` (Apache-2.0 header kept) | stub only network edges (LLM call → recorded outputs; Circle API → local relayer). If the path cannot be vendored in ≤ 3 h, fall back to B1 and say so (DEC-015). Never attack a live third-party deployment. |
