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
forge test                                    # 139 tests: unit, fuzz (1000 runs), invariants (256 x 64)
FOUNDRY_PROFILE=ci forge test                 # 10k fuzz runs, 512 x 128 invariants
forge coverage --report summary --no-match-coverage "(test|script|lib)"
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
| `Invariants.t.sol` | handler-based INV-1..7, INV-12, Σ released ≤ Σ caps, `used` monotonic, balance accounting, append-only engagement list, stable `configHash` |
| `Fuzz.t.sol` | one model-based fuzz per state-changing function |
| `Deploy.t.sol` | deploy script in-process: profile limits, read-back verification, deployments JSON groups, SEC-04 disjoint profiles |

## Deploy (`script/Deploy.s.sol`, not yet run against any network)
Usage is in the script header. It reads parameters from `VAULT_*` env vars, takes the deployer key only from forge's
wallet options, enforces profile limits (sandbox perTx ≤ 25 / daily ≤ 60 tokens, testnet/local only; unknown chains get
the mainnet limits perTx ≤ 100 / daily ≤ 200), reads every immutable back, recomputes `configHash`, refuses addresses
shared between `production` and `sandbox`, and writes its group into `deployments/<network>.json`
(`{vault, token, tokenDecimals, owner, kernelSigner, guardian, caps, delays, deployer, chainId, configHash,
runtimeCodeHash, artifactPath, gitSha}`). `txHash` and `blockNumber` come from forge's `broadcast/` log afterwards.
Never hardcode the token address: take USDC from the Arc contract-addresses page.

## Arc notes
- The vault accounts in ERC-20 base units only (USDC ERC-20 interface = 6 decimals; the native 18-decimal balance
  is never read). `tokenDecimals` is read once at deploy.
- USDC blocklist reverts consume gas without moving funds. A release to a blocklisted payee reverts atomically
  (`used[intentId]` stays false); the kernel should screen and decode the failure.
- Value transfers to `address(0)` revert on Arc: constructor, `withdraw`, `setGuardian`, payees are checked non-zero.
- Block timestamps can repeat on Arc, so pause-cancellation of payee changes uses an epoch counter, not time.
