# contracts/ (owner: CONTRACTS — WP-07, WP-08)

`SymbolonVault` per `docs/06_CONTRACTS_AND_CIRCLE.md` Part A: 13-step `release` order, exact rolling 24 h ring buffer
(64 slots), optional `hourlyCap`, owner approval via `OwnerApprovalRef`, dual-signed engagements, three-signature
payee change with delay, certificate surface (`configHash()`, `ConfigChanged`, `engagementIds`, `RING_SIZE`).
No setters for caps, threshold, delays or token: they are `immutable`; a different limit means a new vault.

## Toolchain
- Target: **Arc Foundry** (`arc-forge`), not yet run (VERIFY_LOG V-19). Stock Foundry is the local dev loop only.
- solc **0.8.30**, `evm_version = "prague"` (a subset of Arc's Osaka baseline; reasoning in `docs/QUESTIONS.md`,
  WP-07 entry item 1, V-21). `bytecode_hash = "none"`, `cbor_metadata = false` for byte-reproducible builds.
- Dependencies are git submodules pinned to release commits: `lib/forge-std` v1.12.0, `lib/openzeppelin-contracts`
  v5.7.0. After cloning: `git submodule update --init contracts/lib/forge-std contracts/lib/openzeppelin-contracts`
  (non-recursive is enough; OZ's own nested submodules are not used).

## Commands (from `contracts/`)
```
forge build                                   # arc-forge build on the target toolchain
forge test                                    # unit, fuzz (1000 runs), invariants (256 x 64 per campaign)
FOUNDRY_PROFILE=ci forge test                 # 10k fuzz runs, 512 x 128 invariants
forge test --match-contract GasTest -vv       # cold-gas numbers; `forge snapshot --match-contract GasTest` writes .gas-snapshot
forge coverage --report summary --no-match-coverage "test|script|lib"
node script/coverage-check.mjs                # coverage gate: SymbolonVault.sol 100 % lines/statements/branches/functions
node script/mutation-check.mjs --jobs 6       # every mutant in script/mutants.mjs must be killed (writes reports/mutation.json)
node script/check-reproducible-build.mjs      # two clean builds must be byte-identical (FORGE_BIN=arc-forge in CI)
```
`FOUNDRY_OFFLINE=true` keeps forge from downloading a compiler (on Windows the svm cache lives on C:).

## Tests (`docs/06` A.5)
| File | Covers |
|---|---|
| `Release.t.sol` | steps 1–11 each with positive and negative cases; approval path (wrong intent, amount + 1, wrong signer, tampered `ref`, expired, Safe owner, ignored at/below threshold); check order; chain-id and vault domain separation; high-s and malformed signatures; discounted amount vs gross `intentId`; Arc blocklist revert is atomic; reentrant token |
| `Engagement.t.sol` | dual-signature registration, ERC-1271 owner and payee, replay and re-registration after close, bad signers, validation, close |
| `PayeeChange.t.sol` | three signatures, delay boundary, cancel on pause (also within one timestamp), no change while paused, nonce replay, supersede |
| `Rolling.t.sol` | 24 h boundary at t−1/t/t+1 s (half-open), 64-slot saturation, wraparound over three laps, hourly boundary, error precedence, differential fuzz against a full-history model |
| `Admin.t.sol` | guardian pause-only, signer rotation delay and effect, withdraw while paused, access control, constructor validation |
| `Config.t.sol` | `configHash()` preimage, viem-computed vectors, exactly which calls emit `ConfigChanged`, `engagementIds` order vs events, `RING_SIZE == 64` |
| `ArcDecimals.t.sol` | decimals read at deploy; 6↔18 scaling confusion reverts at the caps |
| `Vectors.t.sol` | every on-chain case of `packages/schemas/vectors/eip712.json` (typeHash, domainSeparator, structHash, digest) and an end-to-end run over the vector digests |
| `Build.t.sol` | artifact settings, no CBOR trailer, `immutableReferences`, the certificate code-match algorithm (`docs/16` §5.3) |
| `Invariants.t.sol` + `utils/VaultHandler.sol` | four handler campaigns (default caps; hourlyCap 0 + threshold 0 + zero delays; ERC-1271 wallets in every signing role; tiny base-unit caps). The handler calls all 11 state-changing functions from honest and hostile callers and is a second implementation of the release rules: it computes before each call whether the call MUST succeed, so both soundness (INV-1..7) and liveness (INV-12: the owner can always pause and withdraw) are checked. Also: exact rolling-window model equality, per-engagement ledger, nonces and pending records equal the model, immutables unchanged, `configHash` equals its documented preimage, `used` mirrors successful releases, balance accounting, append-only engagement list |
| `Fuzz.t.sol` | one model-based fuzz per state-changing function |
| `FuzzModel.t.sol` | differential fuzz of the whole revert precedence of `release` (random history, then every field randomized) and of the validation order of `registerEngagement` and `proposePayeeChange` against small oracles; `execute*` with any caller and any id; single use of every pending record; an outcome sweep proving every precedence step and success is reached |
| `Events.t.sol` | every function emits exactly the documented events with exactly the documented arguments, in order (e.g. `Released.amount` is the per-release amount, not cumulative); failed calls emit nothing |
| `Surface.t.sol` | the external ABI is pinned: 11 state-changing functions + 37 getters/digests, no setter besides `setGuardian`, no payable entry point, no receive/fallback |
| `EdgeCases.t.sol` | a clock below one day (empty ring slots never count), `start == end` windows, rejected registrations leave the list untouched, insufficient balance does not burn the intent, roles are not transitive |
| `Gas.t.sol` | cold-gas ceilings for release (plain, approved, 64th in window, ERC-1271 everywhere), register, payee change, pause, withdraw |
| `Deploy.t.sol` | deploy script in-process: profile limits, read-back verification, deployments JSON groups, SEC-04 disjoint profiles |

## Deploy (`script/Deploy.s.sol`, not yet run against any network)
Usage is in the script header. It reads parameters from `VAULT_*` env vars, takes the deployer key only from forge's
wallet options, enforces profile limits (sandbox perTx ≤ 25 / daily ≤ 60 tokens, testnet/local only; unknown chains get
the mainnet limits perTx ≤ 100 / daily ≤ 200), reads every immutable back, recomputes `configHash`, refuses addresses
shared between `production` and `sandbox`, and writes its group into `deployments/<network>.json`
(`{vault, token, tokenDecimals, owner, kernelSigner, guardian, caps, delays, deployer, chainId, configHash,
runtimeCodeHash, artifactPath, gitSha}`). `txHash` and `blockNumber` come from forge's `broadcast/` log afterwards.
Never hardcode the token address: take USDC from the Arc contract-addresses page.

## Threat notes (WP-08)
What each defence is, and which mutant (`script/mutants.mjs`) removes it: the mutation run must go red for every one.
| Threat | Defence in the vault | Residual / out of scope |
|---|---|---|
| Compromised kernel signer | every release is bounded by `perTxCap`, engagement `cap`, rolling `dailyCap`, optional `hourlyCap` and 64 releases per 24 h; owner approval above `humanThreshold`; owner and guardian can pause; signer rotation is owner-only and timelocked; the signer cannot change a payee (three signatures plus delay) | the bound is the certificate's number, not zero: a signer that is wrong inside the caps still moves money to the registered payee |
| Compromised owner key | none by design (the owner can always withdraw: non-custodial, INV-12). The guardian can pause but never unpause, withdraw, rotate or change limits | key custody (Safe / ERC-1271 owners are supported) |
| Compromised guardian | can only pause (which also cancels pending payee changes); cannot unpause | a griefing pause until the owner unpauses |
| Replay of an attestation or approval | `used[intentId]` is set before any external call and never cleared; an approval binds (intentId, amount, receiptHash, deadline); the EIP-712 domain binds chain id and vault address | |
| Replay of a registration or payee change | engagement ids are never reusable (closing keeps them); payee-change nonces must strictly increase | |
| Signature malleability / malformed signatures | OZ ECDSA rejects high-s and bad lengths | |
| Hostile ERC-1271 wallets (owner, payee, kernel) | OZ `SignatureChecker`: STATICCALL and an exact magic word, so a wallet can neither mutate state during a check nor re-enter; gas burners fail closed; a wallet that says yes to everything only authorizes what that wallet's role can already do | EIP-7702-delegated owners without ERC-1271 lose signing but keep `pause`/`withdraw` (they use `msg.sender`) |
| Reentrancy through the token | `nonReentrant` on `release` and `withdraw`; checks-effects-interactions (`used`, caps and the ring are written before the transfer) | tokens with transfer hooks other than USDC are not a supported configuration |
| Limit tampering | `perTxCap`, `dailyCap`, `hourlyCap`, `humanThreshold`, delays and `token` are `immutable`; `configHash` binds them with owner, signer and guardian; `Surface.t.sol` pins the ABI so a setter needs a deliberate test edit | a different limit means a new vault and a new certificate |
| Ring saturation (DoS) | 64 releases per rolling 24 h is a documented ceiling (`TooManyReleases`); filling it needs kernel signatures | a compromised signer can exhaust the 24 h release count; the amount bound still holds |
| Timestamp edges | windows are half-open (`t > now - window`); boundaries are tested at t-1, t, t+1; pause cancellation uses an epoch, not time (Arc timestamps can repeat) | |
| Blocklisted payee | the transfer reverts atomically, `used` stays false and nothing is counted; the owner can close the engagement or run a three-signature payee change | USDC blocklist behaviour is modelled by a mock (V-19, V-23) |
| Fee-on-transfer / rebasing token | not supported: accounting is in requested base units | USDC only |
| Unbounded growth | `engagementIds` only grows (one slot per engagement, index-readable); every loop is bounded by `RING_SIZE` | an off-chain enumerator pages by index |

## Verification run (WP-08)
- **Invariants**: `Invariants.t.sol` (four campaigns). Reach counters are printed per run with `-vv`.
- **Fuzz**: `FOUNDRY_PROFILE=ci forge test` runs every fuzz test at 10,000 runs and every invariant at 512 x 128.
- **Mutation**: `script/mutation-check.mjs` applies each mutant in `script/mutants.mjs` (every comparison, check, store,
  event, modifier and `configHash` field of the vault) to a scratch copy, runs the suite with `--fail-fast`, and
  requires a failing test; a mutant that does not compile is INVALID, not killed. The last full run is recorded in
  `reports/mutation.json` (it embeds the sha256 of the vault source it ran against). Mutants deliberately not generated
  (equivalent or unobservable) are listed at the top of `script/mutants.mjs`.
- **Coverage**: `script/coverage-check.mjs` runs `forge coverage` and fails below 100 % lines, statements, branches
  and functions on `src/SymbolonVault.sol`; the last result is in `reports/coverage.json`. (docs/06 asks for >= 95 %
  lines and every revert path; the gate is stricter.)
- **Gas**: `Gas.t.sol` measures with every account and slot cold. Most of a first release is the cold scan of the 64
  ring slots; the Arc gas schedule is unverified (V-19), so the numbers are indicative only.
- **Not verified here**: `arc-forge` (V-19), real Arc execution, USDC blocklist semantics beyond the mock (V-23).

## Arc notes
- The vault accounts in ERC-20 base units only (USDC ERC-20 interface = 6 decimals; the native 18-decimal balance
  is never read). `tokenDecimals` is read once at deploy.
- USDC blocklist reverts consume gas without moving funds. A release to a blocklisted payee reverts atomically
  (`used[intentId]` stays false); the kernel should screen and decode the failure.
- Value transfers to `address(0)` revert on Arc: constructor, `withdraw`, `setGuardian`, payees are checked non-zero.
- Block timestamps can repeat on Arc, so pause-cancellation of payee changes uses an epoch counter, not time.
