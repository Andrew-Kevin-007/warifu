# 16 — LOSS BOUND CERTIFICATE (LBC) — a computation anyone can re-run

> **Owner:** BLAST (library/CLI/API, WP-34) · WEB (UI, extends WP-21) · CONTRACTS (`configHash`, `engagementIds`, WP-07/08) · SCHEMAS (`LossBoundCertificate`, WP-01).
> **Depends on:** `08_BLAST_RADIUS.md` (threat models and closed forms are *not* restated here; this doc defines how they become a verifiable artifact), `06` (vault views), `05` (schema), `14` RT-18..22, `02` INV-18 and INV-22.
> **Spine it serves:** *Don't trust the agent. **Bound it. Prove it.** Invite attack.* ("Prove" here means "make it recomputable and empirically tested", never "formally proven"; see §4.)

## 1. Principle — a computation, not an authority

A Loss Bound Certificate is a JSON document that states, for one vault at one block, the maximum value that can leave **outside the owner's signed engagements** over several time horizons, under named threat models and named assumptions.

1. **It is a pure function of public inputs.** `LBC = f(chain state at block N, published algorithm version, published assumptions)`. Anyone with an RPC endpoint can recompute it with `pnpm lbc verify <vault>`. Our signature (if present) is a convenience, never the evidence (RT-20).
2. **It fails closed.** Missing input ⇒ `UNVERIFIED` or "not computed", never `0`, never `VALID`.
3. **It says what it excludes before it says the number** (RT-21). The UI renders `exclusions[]` above the headline.
4. **It expires on change.** Any change that could make the stated bound too small turns it `STALE` with a diff (INV-22, RT-19).
5. **One implementation.** `bounds.ts` (pure bigint math, no `Date`, no I/O) is used by the CLI, the API, the UI what-if sliders, the simulator oracle and the property tests. If two copies exist, that is a bug (INV-18).

## 2. Inputs and algorithm

### 2.1 Chain reads (`ChainReader` interface; viem implementation + mock for tests)

All reads are at block `N` (default: latest `finalized`/`safe` block if the chain exposes it, otherwise latest minus 2 confirmations; Arc finality is fast but check `evm-differences.md`, V-05).

| Read | Source |
|---|---|
| header `{number, hash, timestamp}` and `chainId` | `eth_getBlockByNumber`, `eth_chainId` |
| `token`, `tokenDecimals`, `owner`, `kernelSigner`, `guardian`, `perTxCap` (P), `dailyCap` (D), `hourlyCap` (hc), `humanThreshold` (H), `payeeChangeDelay`, `signerChangeDelay`, `RING_SIZE` (N = 64) | vault public getters |
| `configHash()` | vault view (see §2.4); recomputed locally and compared |
| `B = token.balanceOf(vault)` | ERC-20 |
| `engagementCount()`, `engagementIdAt(i)`, `engagements(id)` | vault views (v2 adds `engagementIds`; no log scanning needed) |
| `extcodehash(vault)` and immutable ranges | `eth_getCode` (only for the optional code-match step in §5.3) |

If `--block N` is an old block and the RPC lacks archive state, `verify` falls back to recomputation at latest with **digest equality** (§5.2) and says so in the output. It never silently downgrades.

### 2.2 Bounds (formulas defined in `08` §4; restated only as code contract)

```ts
// packages/blast-radius/src/bounds.ts  (pure; bigint only)
export interface BoundInputs {
  B: bigint; P: bigint; D: bigint; H: bigint; hc: bigint; N: bigint;   // N = 64
  sumRemaining: bigint;            // Σ (cap_i − released_i) over engagements with active && end >= blockTimestamp
}
export type Term = 'balance' | 'daily' | 'engagements' | 'hourly';
export interface Bound { horizonSeconds: bigint; value: bigint; binding: Term[] }   // all terms tied for the min

export function perReleaseUnapproved(i: BoundInputs): bigint       // p* = min(P, H)
export function perDay(i: BoundInputs): bigint                     // d* = min(D, N * p*)
export function boundT3c(i: BoundInputs, t: bigint): Bound         // min(B, d* * ceil(t/86400), sumRemaining, hc>0 ? hc * ceil(t/3600) : +inf)
export function timeToEmpty(i: BoundInputs): { days: bigint | null; limitedBy: Term }   // ceil(min(B, sumRemaining) / d*)
export function maxDetectionSeconds(i: BoundInputs, lossTarget: bigint): bigint | 'UNBOUNDED_BELOW_TARGET'
// inverse of boundT3c as a monotone step function; property-tested against boundT3c
```

Semantics, decided once (do not re-litigate in code review):

- **Horizon semantics:** "for *any* half-open interval `[T, T+t)` with `T ≥ T0`, while the on-chain configuration and engagement set are unchanged". Therefore `sumRemaining` includes every engagement with `active && end >= T0`, with **no filter on `start`** (a later-starting engagement could fall inside a later interval). This is conservative and makes the certificate time-independent until something changes. As engagements end or are paid, the true bound only shrinks, so a stated bound stays an upper bound. **Half-open matters:** the vault's rolling window excludes a release exactly 24 h old (`t > now − 1 d`), so releases at `T` and `T + 24 h` are both legal; a *closed* 24 h interval would contain two daily windows, a half-open one contains one. Golden vectors cover `24 h − 1 s`, `24 h`, `24 h + 1 s`.
- **T3 vs T3c:** T3 (stolen signer, honest payees) is *owner-exposed* value; T3c (colluding payee) is *attacker-extractable*. Headline = T3c; both are printed, same number, different words (`08` §4).
- **T2:** `0`, liveness `censorable`. **T1:** `0` under **A-EVID**; the weak-evidence exposure is computed only if the signed engagement terms are supplied (§2.3); otherwise it is `"NOT_COMPUTED"`, not `"0"`.
- **Alarmed variant:** `boundT3c(i, detectionLatencySeconds)` with `detectionLatencySeconds` a **published parameter** (default 300 s = 60 s poll + pause tx + finality margin), under **A-MON**. It is shown as "if the monitor and guardian work", never as the headline.
- **Horizons reported:** 1 min, 1 h, 6 h, 24 h, 48 h, 7 d.
- **Outstanding owner approvals** (`OwnerApproval` signed but unused) can be consumed by a compromised signer inside their deadline; they are owner-authorized amounts, not additional loss. Printed as a note, not added to the bound.

### 2.3 Optional off-chain inputs (each is hash-bound; none can lower a bound)

| Input | Flag | Used for | Binding |
|---|---|---|---|
| Signed engagement terms JSON (with `milestones[].evidence`, `paymentTerms`) | `--terms <dir>` | T1 weak-evidence exposure (`08` §4 table) | `keccak256(JCS(terms without signatures))` must equal the on-chain `termsHash` or that engagement is reported `TERMS_UNVERIFIED` and its exposure counts as its **full cap** |
| `policy.yaml` | `--policy <file>` | `POLICY_LOOSER_THAN_VAULT` flag (`08` §4) | `policyHash` printed; looser-than-vault ⇒ flag, never silently ignored |
| Blast Radius validation results JSON (`results/blast-validation.json`) | `--validation <file>` | `validation` block | contains its own `vaultCodeHash`, `gitSha`, seeds, model IDs; verified against §5.3 |

### 2.4 Contract surface the certificate needs (WP-07/08 change request)

```solidity
bytes32[] public engagementIds;                       // push in registerEngagement
function engagementCount() external view returns (uint256);
function engagementIdAt(uint256 i) external view returns (bytes32);
uint8 public constant RING_SIZE = 64;
event ConfigChanged(bytes32 indexed configHash);      // constructor, setGuardian, executeKernelSigner

// keccak256(abi.encode(token, tokenDecimals, owner, kernelSigner, guardian,
//                      perTxCap, dailyCap, hourlyCap, humanThreshold,
//                      payeeChangeDelay, signerChangeDelay, RING_SIZE))
function configHash() public view returns (bytes32);
```

`paused` and `pendingSigner*` are deliberately **excluded** from `configHash` (pausing only tightens; a pending signer change is not effective until executed, at which point `kernelSigner` changes and so does the hash). In v2 the vault has **no limit setters**: changing `P/D/H/hc` means a new vault. That is a deliberate property (no "owner loosens cap quietly" path), and `lbc verify` still checks generically so a future setter cannot make a certificate lie. `foundry.toml` must set `bytecode_hash = "none"` and `cbor_metadata = false` so builds are byte-reproducible (§5.3).

## 3. Schema (`lbc/1`; `LossBoundCertificateSchema` in `packages/schemas`)

Money values are decimal strings of base units. Canonicalization = RFC 8785 JCS. `certHash = keccak256(JCS(cert minus certHash and publisher))`.

```jsonc
{
  "schema": "lbc/1",
  "algorithm": { "id": "symbolon-bounds", "version": "1.0.0", "gitSha": "…", "detectionLatencySeconds": 300 },
  "subject": { "vault": "0x…", "chainId": 0 /* from deployments/<network>.json */, "token": "0x…", "tokenDecimals": 6 },
  "asOf": { "blockNumber": 123456, "blockHash": "0x…", "timestamp": 1760000000 },
  "inputs": {
    "configHash": "0x…",
    "engagementsDigest": "0x…",          // keccak256(JCS(sorted by id: {id,payee,cap,start,end,termsHash,active})); EXCLUDES released
    "policyHash": "0x… | null",
    "balanceBaseUnits": "200000000",
    "limits": { "perTxCap": "100000000", "dailyCap": "200000000", "hourlyCap": "0", "humanThreshold": "50000000", "ringSize": 64 },
    "sumRemainingBaseUnits": "150000000",
    "activeEngagements": 3
  },
  "bounds": {
    "T1": { "unauthorizedLoss": "0", "assumes": ["A-EVID"], "weakEvidenceExposure": "30000000 | NOT_COMPUTED" },
    "T2": { "loss": "0", "liveness": "censorable" },
    "T3c": {
      "perReleaseUnapproved": "50000000", "perDay": "200000000",
      "horizons": [ { "label": "1m", "seconds": 60, "value": "150000000", "binding": ["engagements"] } ],
      "timeToEmpty": { "days": 1, "limitedBy": "engagements" },
      "alarmed": { "seconds": 300, "value": "150000000", "assumes": ["A-MON"] }
    },
    "T3_ownerExposed": "same numbers as T3c.horizons"
  },
  "assumptions": [ { "id": "A-EVID", "text": "…" }, { "id": "A-MON", "text": "…" }, { "id": "A-OWNER-KEY", "text": "…" }, { "id": "A-TOKEN", "text": "…" }, { "id": "A-CHAIN", "text": "…" }, { "id": "A-MODEL", "text": "…" } ],
  "exclusions": [ { "id": "X-OWNER-KEY", "text": "Owner key compromise (T4): loss = balance." } ],
  "notes": [ "Outstanding owner approvals are owner-authorized amounts and are not added to the bound." ],
  "validation": {
    "t3Trials": 500, "t3Violations": 0, "upper95": "0.006",     // rule of three: 3/n when violations = 0
    "t3BestAttack24h": "150000000", "tightness": "1.0",   // = the 24 h bound here: min(B=200M, d*=200M, ΣR=150M)
    "t1Plans": 240, "t1Losses": 0,
    "codeMatch": { "status": "MATCH | NOT_CHECKED | MISMATCH", "validatedCodeHash": "0x…", "gitSha": "…" }
  },
  "validity": { "status": "VALID | STALE | UNVERIFIED", "reasons": [], "checkedAt": 1760000100, "freshnessSeconds": 86400 },
  "certHash": "0x…",
  "publisher": { "address": "0x…", "sig": "0x…" }   // OPTIONAL EIP-191 over certHash; convenience only
}
```

`validity` is **not** part of `certHash` (it is a verification result, recomputed by every verifier); `bounds`, `inputs`, `asOf`, `assumptions`, `exclusions`, `algorithm` are.

## 4. Assumptions, exclusions and language rules (DEC-012)

### 4.1 Assumptions (always listed)

| ID | Assumption |
|---|---|
| A-EVID | Evidence collectors report truthfully about the world (weak evidence is highlighted, not solved). |
| A-MON | The monitor and guardian are running for the "alarmed" figure only. |
| A-OWNER-KEY | The owner key (T4) is not compromised; recommend multisig/hardware. |
| A-TOKEN | The settlement token behaves as an honest ERC-20 (no issuer freeze, upgrade or depeg events). |
| A-CHAIN | The chain is live and final at block `N`; the verifier's RPC is honest (use your own). |
| A-MODEL | The Solidity semantics match the modeled semantics in `08` §4; no bytecode bug outside that model (validated empirically, not formally proven). |

### 4.2 Exclusions (rendered above the number)

Owner-key compromise (T4) · payee-key compromise receiving *authorized* funds (T5) · USDC issuer actions, blocklisting, depeg · chain halt or deep reorg · RPC dishonesty · contract bugs outside the model · quality or delivery of the work (we bound *who*, *how much*, *how fast*) · **availability**: with a stolen signer the 64-slot ring can be filled with dust to block legitimate payments for 24 h (RT-29; not a fund-loss path) · tokens other than the configured one.

### 4.3 Language rules (enforced by `pnpm claims:lint`, owner SEC)

- Allowed: "calculated from on-chain state", "empirically tested against N trials; 0 violations (95 % upper bound on violation rate ≈ 3/N)", "assuming A-…", "recomputable with `pnpm lbc verify`".
- Forbidden in README, UI strings, video script, docs outside quotes of this rule: **provable/provably/proven/proof of safety, guaranteed, unhackable, unbreakable, 100 % secure, risk-free/zero risk, audited** (unless an external audit exists and is linked). Negations such as "no guarantees" or "not audited" are fine; "unaudited" is encouraged. The spine's verb "Prove it" is allowed (it points at `pnpm lbc verify`, which is recomputation, not a proof of safety). Scope of the lint: `README.md`, `apps/web/src/**`, `docs/VIDEO_SCRIPT.md` and the submission-form text; the design docs quote the rule and are exempt. Opt-out comment `<!-- claims-lint-allow: reason -->` (or `// claims-lint-allow: reason` in code) on the same or previous line is reviewed by VERIFIER. Implementation: `scripts/claims-lint.mjs` (WP-37 may extend it).
- The headline sentence is generated from the certificate, not typed: *"If the AI and the kernel key are both compromised, at most **$X** can leave in the first **24 h** (calculated from on-chain state at block N; assumptions and exclusions below)."*

## 5. Verification and staleness

### 5.1 CLI

```
pnpm lbc build  <vault> --rpc <url> [--block N|finalized|latest] [--terms <dir>] [--policy <file>] [--validation <file>] [--out cert.json]
pnpm lbc verify <vault | cert.json> --rpc <url> [--block N] [--artifact <foundry-artifact.json>] [--terms <dir>] [--policy <file>] [--json]
pnpm lbc explain cert.json
```
Exit codes: `0` VALID · `10` STALE · `20` UNVERIFIED · `30` MISMATCH (recomputation at the stated block differs from the document: forged or buggy) · `2` usage error. `verify <vault>` with no document fetches the latest published certificate from the API and verifies it with the user's own RPC.

### 5.2 Algorithm (`verify.ts`)

1. **Provenance.** `chainId` equals the document's; `eth_getBlockByNumber(asOf.blockNumber).hash == asOf.blockHash` (else `UNVERIFIED: BLOCK_HASH_MISMATCH`, covering wrong chain and reorg).
2. **Recompute at the stated block** (archive state available): rebuild `inputs` and `bounds` with `bounds.ts`; every field must match exactly. Any difference ⇒ `MISMATCH` (exit 30) with a field-level diff. If archive state is unavailable, recompute from **latest** and require `configHash` and `engagementsDigest` to be equal to the document's; then `inputs.limits` and `bounds` are fully determined by those digests except `balance` and `sumRemaining`, which are handled in step 3. The output says `MODE=latest-with-digest-equality`.
3. **Recompute at latest** and compare:

| Observation at latest | Result |
|---|---|
| `configHash` differs | `STALE: CONFIG_CHANGED` (diff of fields) |
| `engagementsDigest` differs (new/closed engagement, payee, cap, window or terms changed) | `STALE: ENGAGEMENTS_CHANGED` |
| balance increased **and** any horizon's `binding` contains `balance` | `STALE: BALANCE_INCREASED` |
| balance increased but `balance` is not binding in any horizon | `VALID` (the min was set by another term) |
| balance decreased; `sumRemaining` decreased (payments or time) | `VALID` (the bound only tightened) |
| `paused` flipped | no effect on validity (pausing only tightens; unpausing restores the stated bounds) |
| `now − asOf.timestamp > freshnessSeconds` | `STALE: FRESHNESS_EXCEEDED` (re-run `build`) |
| any RPC call fails, returns empty/zero code, or decoding fails | `UNVERIFIED: RPC_ERROR`, never `VALID` |

4. Multiple reasons are all reported; severity order is `MISMATCH` > `UNVERIFIED` > `STALE` > `VALID`.

### 5.3 Code match (optional but strongly recommended; required for the "validated" badge)

`--artifact` takes the Foundry JSON artifact. `verify` fetches `eth_getCode(vault)`, zeroes the byte ranges listed in `deployedBytecode.immutableReferences` in both the on-chain code and the artifact, and compares. `MATCH` ⇒ `validation.codeMatch.status = MATCH` and the validation numbers are attributed to this code. `MISMATCH` or a `validatedCodeHash` that does not equal the artifact's hash ⇒ `UNVERIFIED: CODE_NOT_VALIDATED`. Without an artifact the status is `NOT_CHECKED` and the UI says "validated against build `<gitSha>`; on-chain code not matched". (RT-18: the empirical claim only transfers to the exact bytecode that was tested.)

## 6. Availability note and limits

- Bounds are for **value**, not for service continuity (ring-buffer dust fill, relayer censorship).
- They hold under the modeled semantics (`08` §12); this is calculation plus ≥ 500 differential trials, not a formal proof of the Solidity or of Arc.
- `upper95 = 3/n` is a statement about the rate at which *random and heuristic attacks* violated the bound in our simulator, not about unknown attacks.
- Tightness below 0.95 means the bound is loose (conservative). That is reported, not hidden.

## 7. Surfaces

| Surface | Spec |
|---|---|
| CLI | §5.1; lives in `packages/blast-radius/src/cli/lbc.ts`; `pnpm lbc` script at repo root |
| API (kernel service) | `GET /v1/certificates/:vault` (latest published), `GET /v1/certificates/:vault/:certHash`, `POST /v1/certificates/:vault/build` (rate-limited; public for sandbox vaults, tenant-authenticated for pilot vaults). Responses always include a server-side `validity` re-check performed against the configured RPC. |
| UI `/certificate/[vault]` (WEB; extends WP-21) | order: **exclusions → headline sentence (generated) → status chip → horizon table with `binding` → assumptions → validation block → "verify it yourself" copy-able command → diff panel when STALE**. `RECORDED` watermark when served from a replay bundle (DEC-016). No client-side hand-typed numbers. |
| `/blast-radius` what-if | uses `bounds.ts` unchanged; changing sliders never mutates a published certificate. |
| Challenge page card D (`15` §1) | embeds the sandbox vault certificate and its `lbc verify` command. |
| `/judge` | one card: certificate status, headline sentence, copy-able verify command. |
| Replay bundle (`15` §7) | includes the certificate and the chain reads used (so `verify-bundle` can recompute offline). |

## 8. Links to Blast Radius validation (`08` §5)

- `t3-sim.ts` uses `boundT3c` as its oracle; a violation (measured > bound) fails CI and its seed is committed as a regression.
- `validation` in the certificate is populated **only** from a results file whose `vaultCodeHash` and `gitSha` are present; absent or mismatched ⇒ the block is rendered as "not validated for this deployment".
- Patch-loop story (`08` §8): certificates before/after `hourlyCap` are both kept and rendered side by side; the diff is generated, not typed.

## 9. How a counterparty uses it

A vendor, auditor or Circle reviewer runs `pnpm lbc verify <vault> --rpc <their own RPC> --artifact <build>`; if the exit code is 0 they have independently recomputed "at most $X in 24 h under T3c" from public chain state. If it is 10 they know exactly what changed. They never need to trust Symbolon's server, signature or website.

## 10. Work plan and acceptance (WP-34; deps WP-25, WP-07)

| Step | Output |
|---|---|
| Schema + `bounds.ts` extensions (`binding`, `maxDetectionSeconds`, `timeToEmpty`) | `packages/schemas`, `packages/blast-radius/src/bounds.ts` |
| `ChainReader`, `build.ts`, `verify.ts`, CLI | `packages/blast-radius/src/lbc/*` |
| API + persistence (`certificates` table, `05` DDL) | `services/kernel` |
| UI `/certificate/[vault]` | `apps/web` (WEB, with WP-21) |
| Tests below | `packages/blast-radius/test/lbc/*`, `packages/sec-suite` mutation checks |

**Tests (all must exist before G4):**
1. ≥ 12 golden vectors with hand-computed bounds (include `H > P`, `hc > 0`, `ΣR < B`, `B < d*`, `N·p* < D`, zero engagements, horizon boundaries 24 h ± 1 s).
2. Property tests: tightening any cap never raises any bound; each bound ≤ `B` and ≤ `ΣR`; `maxDetectionSeconds` is the exact inverse of `boundT3c`; `perDay ≤ D`.
3. Digest tests: `engagementsDigest` is unchanged by `released`, changes with payee/cap/start/end/termsHash/active, and is independent of registration order.
4. Anvil staleness matrix: fund vault (balance binding ⇒ STALE; not binding ⇒ VALID) · register engagement ⇒ STALE · close engagement ⇒ STALE · rotate signer ⇒ STALE · `setGuardian` ⇒ STALE · release payment ⇒ VALID · pause/unpause ⇒ VALID · wait past freshness ⇒ STALE.
5. Tamper tests: edit any bound/limit/digest field in the JSON ⇒ `MISMATCH`; wrong chainId or blockHash ⇒ `UNVERIFIED`; RPC returning empty/zero ⇒ `UNVERIFIED` (fail closed); wrong artifact ⇒ `CODE_NOT_VALIDATED`.
6. Verifier mutation test (SEC suite): programmatically flip each comparison operator and each `min` in `bounds.ts`/`verify.ts`; the suite must fail for every mutant (kill rate reported).
7. `claims:lint` passes on README, UI strings and docs; a seeded forbidden word fails it.
8. Differential agreement: for 500 random configs, `bounds.ts` output equals the independent Python/BigInt reference in `packages/blast-radius/test/reference.py` (second implementation by VERIFIER, not by BLAST).

**Acceptance:** all tests green; `pnpm lbc verify` against the testnet sandbox vault returns 0 with the user's own RPC; after a config change the same command returns 10 with a diff; the UI page and `/judge` card render from live data and from a replay bundle; no number on any surface is hand-typed (INV-18).
