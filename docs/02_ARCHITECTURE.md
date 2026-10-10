# 02 — ARCHITECTURE

> **v2 delta.** New trust boundary **TB-6** (anonymous public attacker → sandbox), invariants **INV-15..INV-23**, new components (`packages/terms`, `packages/sec-suite`, challenge profile of the kernel service, replay builder, certificate module), a **sandbox** deployment that shares nothing with production, and new sequences 5.5–5.7. Rationale and exploit analysis: `14_RED_TEAM_V2.md`.

## 1. System context

```
                         ┌──────────────────────────────┐
   Owner (browser wallet)│        apps/web (Vercel)     │  NO Circle secrets, NO signer key
   Payee (link + wallet) │  UI · upload · /audit · /judge│
   Reviewer ───────────► │  packages/extractor (LLM)     │───┐ PaymentIntent (HMAC-authenticated)
                         └──────────────────────────────┘   │
                                                            ▼
                         ┌──────────────────────────────────────────────────────────┐
                         │          services/kernel (Railway/Fly)  ALL SECRETS      │
                         │  Hono API · kernel-core (pure) · policy · receipts       │
                         │  evidence collectors · scheduler · reconciler · breaker   │
                         └───────┬───────────────┬───────────────┬──────────────────┘
                                 │               │               │
                    Supabase Postgres      Circle APIs      Arc RPC (viem)
                    (state, receipts)   (dev-controlled      (events, reads)
                                         wallet = relayer,
                                         Compliance Engine)
                                                 │
                                                 ▼
                                   ┌────────────────────────────┐
                                   │  SymbolonVault.sol (Arc)   │  holds USDC; releases only on
                                   │  per-business instance     │  valid kernel attestation
                                   └────────────────────────────┘
```

Offline/local: `arc-anvil` fork for Blast Radius trials and attack-suite runs against the **real contract + real kernel** (not mocks).

**v2 sandbox (separate deployment, shares nothing with the diagram above):**

```
 anonymous attacker ─► apps/web [NEXT_PUBLIC_PROFILE=challenge, own origin, NO wallet code]
                         │ untrusted text rendered inert (INV-15), strict CSP
                         ▼
                 services/kernel [KERNEL_PROFILE=sandbox]  own Supabase PROJECT, own kernel signer, own relayer,
                         │        own vault(s) + Anthropic key (spend-capped); EVIDENCE_MODE=fixtures; no outbound fetches
                         ▼
                 sandbox vault on Arc TESTNET only  ──►  oracle (O1..O8) scores every attempt  ──►  replay bundle
```
Boot guards (`15` §3) make it impossible for the sandbox to start with a production signer, a mainnet network or any `PROD_*` secret (INV-16).

## 2. Components

| Component | Path | Language | Responsibility | Holds secrets? |
|---|---|---|---|---|
| Web app | `apps/web` | TS / Next.js 15 | UI, uploads, owner/payee signing flows, public verifier, attack lab, blast-radius, `/certificate`, `/challenge`, replay mode; calls extractor. Two build profiles: `app` and `challenge` (the latter has **no wallet/signing code**) | **No** |
| Extractor | `packages/extractor` (imported by web API routes) | TS | LLM extraction + timing + explanation; emits intents | Anthropic key only |
| Kernel service | `services/kernel` | TS / Hono | Decision engine host, signer, Circle adapter, scheduler, reconciler | **Yes** |
| Kernel core | `packages/kernel-core` | TS (pure) | K-01..K-14 pure functions, verdict algebra | No |
| Policy | `packages/policy` | TS | `policy.yaml` schema, load, hash, version | No |
| Receipts | `packages/receipts` | TS | JCS canonicalization, keccak hashing, EIP-712 sign/verify | No (signing key injected) |
| Schemas | `packages/schemas` | TS / Zod | Single source of truth for all data shapes + JSON Schema export + test vectors | No |
| Chain | `packages/chain` | TS / viem | Arc config, ABIs, decimals/`Money` helpers, event decoders | No |
| Attack suite | `packages/attack-suite` | TS | 24 attacks (+ hold-out `ATK-H*`), fixtures, generators, baselines B0/B1/B2, harness, statistics | No |
| Blast Radius | `packages/blast-radius` | TS | Threat models, closed-form bounds (`bounds.ts`), T3 simulator, red-team loop, report, **Loss Bound Certificate** build/verify/CLI (`16`) | No |
| Terms *(v2)* | `packages/terms` | TS (pure) | `amountDue`, discount-window and APR math from signed `PaymentTerms`; bigint only; imported by kernel-core, the AGENT planner and the UI; the deterministic plan evaluator lives in `packages/terms/src/eval/` so the kernel service can compute the fallback plan without importing the extractor | No |
| SEC suite *(v2)* | `packages/sec-suite` | TS | SEC-01..14 platform-security tests, XSS/SSRF corpora, verifier mutation tests, `claims:lint` | No |
| Loss oracle *(v2)* | `packages/oracle` | TS (pure) | `oracle-v1` predicates O1..O8: the only authority on whether an attempt was a loss; imports only `packages/schemas`; used by the attack harness and the challenge service, never by a defender package | No |
| Replay builder *(v2)* | `scripts/build-replay-bundle.ts` | TS | Builds and verifies `ReplayBundle` (`15` §7); consumed by `apps/web` static replay mode | No |
| Contracts | `contracts/` | Solidity / Arc Foundry | `SymbolonVault`, interfaces, tests, deploy scripts | No |
| DB | `supabase/migrations` | SQL | Tables in `05_DATA_MODELS_AND_API.md` | n/a |

## 3. Trust boundaries (the core design claim)

```
TB-1  Internet/Document content  ─►  LLM extractor     (untrusted data → advisory output only)
TB-2  LLM extractor              ─►  Kernel API        (authenticated, schema-validated; intents are PROPOSALS)
TB-3  Kernel                     ─►  Vault contract    (EIP-712 attestation; vault re-checks critical invariants)
TB-4  Owner wallet               ─►  Vault/Kernel      (signatures only owner can produce: approvals, engagements, withdraw, pause)
TB-5  Payee wallet               ─►  Vault/Kernel      (signatures only payee can produce: engagement acceptance, payee change, ack)
TB-6  Anonymous public attacker  ─►  Challenge sandbox (v2; hostile text, high volume; sandbox holds NO authority over production: separate signer, DB, vault, keys, origin)
```

**Design rule:** *no boundary crossing carries authority except cryptographic signatures from the key that owns that authority.* An HTTP request from `apps/web` carries no authority to pay; only the kernel's EIP-712 attestation (checked by the vault against registered engagements and caps) does.

> *(v2)* TB-6 is the reason the sandbox is a **separate deployment** (INV-16). Everything that crosses TB-6 is treated as hostile text (INV-15) and hostile volume (INV-21). The sandbox's signer, if fully compromised, can authorize nothing in production.

## 4. Invariants (tested; referenced in code as `INV-n`)

| ID | Invariant | Enforced by | Verified by |
|---|---|---|---|
| INV-1 | No payment is released unless the vault verifies a valid kernel attestation for that exact `(intentId, engagementId, milestoneId, payee, amount)` | Vault | Foundry fuzz + invariant tests |
| INV-2 | A payee is paid only if registered via owner+payee dual-signed engagement | Vault | Foundry + ATK-13/17 |
| INV-3 | `Σ released(engagement) ≤ cap(engagement)` | Vault | invariant test |
| INV-4 | `intentId` is single-use on-chain (`used[intentId]`) | Vault | ATK-08 |
| INV-5 | Per-tx ≤ `perTxCap`, rolling-24h ≤ `dailyCap` | Vault | fuzz |
| INV-6 | Amount > `humanThreshold` requires valid `OwnerApproval` | Vault | unit + ATK |
| INV-7 | Payee change needs old+new payee + owner signatures and `payeeChangeDelay` | Vault | unit |
| INV-8 | LLM output is never a branch condition in `kernel-core` (no import path from extractor to kernel-core) | ESLint boundary rule + dep-cruiser | CI |
| INV-9 | `kernel-core` is deterministic: no `Date`, `Math.random`, network, fs; all inputs in `KernelContext` | lint rule + property tests (same input → same output) | CI |
| INV-10 | Money is `bigint` base units + decimals; no JS `number` touches amounts | lint rule + type brand | CI |
| INV-11 | `apps/web` environment contains no Circle/signing secrets | secrets-scan test | CI |
| INV-12 | Owner can always `pause()` and `withdraw()` | Vault | unit |
| INV-13 | Every `RELEASE` decision has a receipt whose hash appears in the `Released` event | kernel + vault | e2e + reconciler |
| INV-14 | Any reconciliation mismatch halts releases (breaker) until owner unfreezes | kernel + vault pause | ATK-01/09 |
| INV-15 *(v2)* | **Untrusted text is inert.** Anything originating outside our trust boundary (invoice text, filenames, vendor names, attacker-supplied "explanations", LLM prose) is rendered only as text nodes through `<UntrustedText>` (accepts only the branded `Untrusted<string>` type), never via `dangerouslySetInnerHTML`/`innerHTML`/markdown-to-HTML; strict CSP (no `unsafe-inline`, no `unsafe-eval`, `object-src 'none'`, `frame-ancestors 'none'`); downloads are `attachment` + `nosniff` | ESLint ban list + CSP headers + branded type | SEC-01, SEC-06; XSS corpus ≥ 40 |
| INV-16 *(v2)* | **Sandbox isolation.** The challenge runs as its own service instance, Supabase **project**, kernel signer, relayer wallet, vault(s), Anthropic key and web origin (no wallet code on that origin). `KERNEL_PROFILE=sandbox` refuses mainnet, refuses a signer listed in `PROD_SIGNER_ADDRESSES`, refuses to start if any `PROD_*` secret or production Supabase host is present | boot guards (`15` §3) + CI check on env files | SEC-04, SEC-05 |
| INV-17 *(v2)* | **Attack traffic is never traction.** `tenants.kind ∈ {pilot, demo, challenge}`; every traction/stat view filters `kind='pilot'` by construction; challenge rows can exist only in the sandbox DB | DB view definitions + unit test inserting challenge rows | SEC-04 (+ stats-unchanged test) |
| INV-18 *(v2)* | **Every public claim is computed by script.** Numbers in README, video script, `/judge`, certificate headline and the submission form are produced by `scripts/claims.ts` from committed artifacts (`results/*.json`, certificate, bundle); none is typed by hand. Wording rules (DEC-012) are enforced by `pnpm claims:lint` | `claims.ts`, `claims:lint` in CI | VERIFIER re-run (WP-29) |
| INV-19 *(v2)* | **Payment terms come only from the signed engagement.** `paymentTerms` lives inside the `termsHash`-bound terms; invoice-stated terms are compared, never adopted; the discount clock starts at the **kernel-recorded** `invoiceReceivedAt`; the kernel computes `amountDue` and the feasible `payAt` window itself | `packages/terms` + K-08/K-14 | ATK-21 + property tests |
| INV-20 *(v2)* | **WYSIWYS.** The approval screen renders from the same object that is signed: `buildApprovalTypedData()` → `ApprovalView`; `jcs(renderedModel) == jcs(signedModel)`; the raw typed data and its hash are shown beside the wallet prompt; LLM prose is advisory, collapsed, never adjacent to the Approve button, and explanations are templated from structured fields | one builder function + test | ATK-23, SEC-13 |
| INV-21 *(v2)* | **Paid calls are budgeted.** Every external paid call (LLM, any metered API) goes through the budget ledger (global daily + per-principal), with a content-hash cache; exhaustion fails **closed to replay mode**, never to a weaker pipeline | `llm_budget_ledger` + middleware | SEC-03, SEC-08 |
| INV-22 *(v2)* | **Certificate soundness and staleness.** An LBC binds `{chainId, blockNumber, blockHash, configHash, engagementsDigest, balance, algorithm version}`; verification recomputes at the stated block and at latest, fails closed (`UNVERIFIED`) on any missing input, and reports `STALE` with a diff when a loosening change occurred (`16` §5) | `packages/blast-radius/src/lbc` | WP-34 test matrix + verifier mutation test |
| INV-23 *(v2)* | **The kernel never parses binary formats.** It receives normalized UTF-8 text plus the blob hash; PDF/image extraction happens only in `apps/web` (no payment secrets, INV-11; the public challenge is plain text only, `15` §5) with size/page/time/memory caps | schema (`Document.text` + `blobSha256`) + service validation | SEC-09 |

## 5. Primary sequences

### 5.1 Happy path (clean milestone)

1. Owner + payee sign **EngagementTerms** (EIP-712). Relayer submits `registerEngagement`. Kernel indexes `EngagementRegistered`.
2. Contractor delivers; kernel **evidence collectors** gather proof (e.g., GitHub Actions run success for commit SHA; URL 200 + content hash; artifact hash; or owner ack signature).
3. Contractor invoice arrives (paste/upload). `apps/web` runs **extractor** (two models) → `PaymentIntent` incl. timing proposal and rationale.
4. `POST /v1/intents` to kernel. Kernel builds `KernelContext` (now, vault balance, history, evidence, screening) and runs `evaluate()`.
5. Verdict `RELEASE` with `payAt`. Receipt built, signed, stored. Scheduler waits until `payAt`.
6. At `payAt`, kernel re-runs `evaluate()` against fresh context (**TOCTOU guard**), signs `Attestation`, relayer submits `vault.release(att, kernelSig, approvalRef, ownerApprovalSig)` (`approvalRef`/`ownerApprovalSig` are empty at or below `humanThreshold`; `06` A.4).
7. Vault emits `Released(intentId, engagementId, payee, amount, receiptHash)`. Reconciler matches event ↔ decision (K-15). Payee may sign `ReceiptAck` (P1).
8. UI shows live status; `/audit/<receiptHash>` verifies without trusting us.

### 5.2 Escalation (human gate)

`ESCALATE` → agent explanation (plain language + recommended action) → owner reviews on `/intents/:id` → owner signs `OwnerApproval(intentId, receiptHash, amount, deadline)` in wallet (the amount is inside the signed struct so an approval cannot be reused for a larger payment) → kernel verifies, re-evaluates (context may have changed), then proceeds as 5.1 step 6. Vault independently demands the approval when `amount > humanThreshold`. `receiptHash` inside the approval is the **escalation receipt the owner reviewed**; the later attestation carries the final `RELEASE` receipt's hash, so the relayer passes an `OwnerApprovalRef {receiptHash, deadline}` for the vault to rebuild the signed struct (`06` A.4). The kernel service verifies that the ref's `receiptHash` belongs to the intent's superseded decision chain before it signs the attestation (`04` K-12).

### 5.3 Attack path (prompt-injected invoice)

PDF contains hidden instruction → extractor might comply and emit `payeeAddress = attacker` → kernel K-06 compares to engagement-signed payee → `REJECT`, receipt records the mismatch and K-11 flags instruction-like text; breaker not tripped (nothing moved); alert logged. Even if kernel were bypassed, vault reverts (INV-2).

### 5.4 Kernel-signer compromise (Blast Radius T3)

Attacker holds kernel signing key → can sign attestations only for **registered payees**, within **per-engagement caps**, **per-tx/daily caps**, **human threshold**, **single-use intent IDs**. Max loss over an interval of length `t` = `min(B, d*·⌈t/24h⌉, ΣR)` with `d* = min(D, 64·min(P,H))` (and `hourlyCap·⌈t/1h⌉` when enabled); cannot create a new payee (needs owner+payee sigs). `08_BLAST_RADIUS.md` derives and tests this; `16_LOSS_CERTIFICATE_SPEC.md` publishes it as a recomputable certificate. Availability (not loss): a stolen signer can fill the 64-slot ring with dust to block payments for 24 h (RT-29; mitigated by guardian pause + rotation).

### 5.5 Challenge attempt (v2; `15`)

1. Attacker picks a scenario (S-A/S-B/S-C) → service creates a **fresh scenario instance** (fixture engagement, fixture evidence, sandbox vault state) and returns an `attemptId`.
2. Attacker submits ≤ 4 KiB **plain text** (or uses a canned attack). Rate limit + budget ledger run first (INV-21); content-hash cache is consulted.
3. Extractor (two models) → `PaymentIntent` → kernel `evaluate()` in `EVIDENCE_MODE=fixtures` (no outbound fetch) → verdict + signed receipt. Vault checks run as `eth_call` simulations; real broadcast only for house nightly runs and a limited "prove it on-chain" action.
4. **Oracle `oracle-v1` (O1..O8)** evaluates the *outcome* against the scenario's ground truth; only the oracle can declare a loss event. The attempt feed shows an inert excerpt (INV-15), hash, verdict, checks fired, receipt link.
5. Degrade ladder L0..L3 (`15` §10) on any failure: never skip a check, never fall back to a weaker pipeline.

### 5.6 Treasury plan (v2; `03` §5)

1. Kernel computes the **feasible plan set** from the signed `paymentTerms`, `invoiceReceivedAt`, policy, vault caps and projected liquidity (`PLAN_OUT_OF_ENVELOPE` otherwise).
2. Planner (LLM) selects one feasible plan with structured rationale; it may also *propose* a reading of free-text invoice terms, which the kernel only **compares** to the signed terms (`TERMS_MISMATCH` ⇒ ESCALATE).
3. `packages/terms` + the deterministic evaluator compute `amountDue`, discount value and implied APR; plan is stored with `payAt` strictly inside the window by a safety margin; at `payAt` the TOCTOU re-evaluation may emit `DISCOUNT_WINDOW_CLOSED` ⇒ ESCALATE (default).

### 5.7 Certificate build / verify (v2; `16`)

`pnpm lbc build <vault>` reads chain state at block N, computes bounds with `bounds.ts`, binds digests and publishes JSON. `pnpm lbc verify <vault>` (anyone, own RPC) recomputes at N and at latest and returns VALID (0) / STALE (10) / UNVERIFIED (20) / MISMATCH (30). The kernel service never signs a certificate as authority; an optional publisher signature is a convenience.

## 6. Failure modes and responses

| Failure | Detection | Response |
|---|---|---|
| LLM API down/timeouts | extractor timeout 20 s | intent not created; UI shows "extraction unavailable"; nothing pays |
| Models disagree | K-10 | `ESCALATE` with both extractions side-by-side |
| Kernel exception | try/catch around `evaluate()` | `HOLD` with `KERNEL_ERROR`; page owner; never `RELEASE` |
| Circle API error on relay | non-2xx / webhook failure | retry with same `intentId` (idempotent); after N=3 → `HOLD`, alert |
| Tx submitted, outcome unknown | no event within 2 min | reconciler polls chain by `intentId`; if absent after 10 min → breaker + alert (ATK-01) |
| Chain reorg/finality | Arc deterministic finality (sub-second) | treat tx as pending/final only (two-state model per Arc docs) |
| Payee USDC-blocklisted | transfer revert (gas consumed, no receipt per Arc docs) | decode revert; mark `RELEASE_FAILED`; screen payee; escalate |
| DB loss | Supabase PITR; receipts also re-derivable from chain + stored inputs | restore; breaker engages until reconciler passes |
| Kernel signer key leak | operator alert / anomaly | owner `rotateKernelSigner` (delay) or `pause()`; Blast Radius bound limits loss |

## 7. Key management

| Key | Purpose | Custody (hackathon) | Production note |
|---|---|---|---|
| Owner key | register engagements, approve, pause, withdraw | owner's browser wallet (hardware wallet recommended) | multisig |
| Kernel signer | signs release attestations & receipts | **env-held secp256k1 key in kernel service** (disclosed). If V-02 shows dev-controlled wallets support `signTypedData`, switch to Circle-held key | KMS/HSM or threshold signing |
| Relayer | pays gas, submits txs | Circle dev-controlled EOA wallet (holds small USDC for gas) | same, rotated |
| Payee key | signs engagement, payee change, ack | payee's own wallet | n/a |
| Circle API key + Entity Secret | wallet ops | kernel service secrets only; **never** in repo/web | rotation runbook |

Never commit the Circle recovery file. `.env*` in `.gitignore`; gitleaks in CI.

*(v2)* **Sandbox keys** (kernel signer, relayer, vault owner, house attackers) are throwaway testnet keys, are **never reused** in any other profile, and are generated by script into the sandbox secret store. **Agents (Claude Code lanes) never receive production keys**; `.claude/settings.json` denies reading `.env*` secrets; humans never paste private keys into chats (DEC-017, RT-26).

## 8. Deployment topology

| Env | Chain | Web | Kernel | DB | Notes |
|---|---|---|---|---|---|
| `local` | `arc-anvil` fork of Arc testnet | `pnpm dev` | `pnpm dev:kernel` | local Supabase or SQLite shim | attack suite + Blast Radius trials |
| `testnet` | Arc testnet via `$RPC` from `arc-canteen` (or public RPC) | Vercel preview | Railway | Supabase cloud | most volume, attack lab live |
| `mainnet` | Arc mainnet | Vercel prod | Railway prod | separate Supabase project | pilot payments; vault TVL ≤ $200 each; separate keys |
| `sandbox` *(v2)* | Arc **testnet only** | separate Vercel project, `NEXT_PUBLIC_PROFILE=challenge`, own domain, no wallet code | separate service instance, `KERNEL_PROFILE=sandbox`, `EVIDENCE_MODE=fixtures` | **separate Supabase project** | public challenge; throwaway keys; own spend-capped Anthropic key; guardian kill switch; nightly reset |
| `replay` *(v2)* | none | static export of the recorded bundle (served from the same origin as judge pages) | none | none | `RECORDED` watermark; used when anything above is down (DEC-016) |

Public judge URL = `testnet` web with a clearly labeled **Mainnet pilot** page showing explorer links.

*(v2)* The public **challenge** URL is the `sandbox` web, never the production web. Judge-facing pages (`/judge`, `/challenge`, `/attack-lab`, `/certificate/*`) fall back automatically to `replay` mode. Deploys are frozen after Sat 2026-10-17 22:00 IST.

## 9. Observability and audit

- Structured JSON logs with `intentId`, `decisionId`, `receiptHash` on every line; no PII beyond what the user pastes; invoice raw text stored hashed + object storage, redactable.
- `/healthz` (kernel), `/readyz` (DB, RPC, Circle reachability, breaker state).
- Metrics tables: `traction_events`, `agent_metrics` (agreement rates, latency, cost), `attack_results`; *(v2)* `challenge_attempts`, `llm_budget_ledger`, `certificates`, `replay_bundles`.
- *(v2)* Logs never contain raw attacker text beyond a truncated, escaped excerpt + hash; secrets are scrubbed (SEC-07).
- Public `/pilot` and `/judge` pages read **only** from sanitized views.

## 10. Performance and cost budget

| Stage | p50 | p95 |
|---|---|---|
| Dual extraction | 4 s | 10 s |
| Kernel evaluate | <50 ms | <200 ms (excluding evidence fetch) |
| Evidence fetch (CI/URL) | 1 s | 4 s |
| Relay + finality on Arc | ~1 s | ~3 s |

Per-invoice LLM cost target < $0.03. Arc fee ≈ $0.01 per tx (USDC gas).

## 11. Threat model (STRIDE-lite)

| Threat | Actor | Vector | Primary control | Residual |
|---|---|---|---|---|
| Spoofing payee | malicious vendor/email | altered wallet in PDF/email | K-06, K-11, vault payee binding | owner + payee collusion out of scope |
| Tampering with intent | compromised web/extractor | forged `PaymentIntent` | kernel re-derives checks from signed engagement + collected evidence; HMAC service auth | web→kernel token theft: low blast radius (cannot pay beyond checks) |
| Repudiation | owner/payee dispute | "I never approved/received" | EIP-712 signatures, receipts, ack | none in-scope |
| Info disclosure | public pages | invoice contents leak | sanitized views; hashes only on public pages | user-pasted PII is user's responsibility |
| DoS | spammer | flood intents | rate limits, per-tenant quotas, extraction budget | cost spike (cap LLM spend/day) |
| Elevation | LLM prompt injection | instruction in doc | no tools/keys for LLM; deterministic kernel; vault | extractor can be wrong; cannot be authoritative |
| Insider/key compromise | kernel operator | stolen signer | vault caps + registered payees + human threshold + pause + rotate | bounded by Blast Radius T3 |
| *(v2)* Stored/reflected XSS | anonymous attacker | hostile text in invoice/filename/vendor/explanation shown to judges | INV-15, CSP, lint bans | none known; XSS corpus in CI |
| *(v2)* SSRF | anonymous attacker | evidence URLs / refs in documents | challenge profile has no outbound fetch; production egress via deny-by-default proxy with IP pinning; allowlist from signed engagement | DNS/proxy misconfig (SEC-02) |
| *(v2)* Hostile file parsing | anonymous attacker | crafted PDF/zip | INV-23; extraction only in `apps/web` with caps; challenge accepts text ≤ 4 KiB | parser CVE in web tier (no payment secrets there) |
| *(v2)* Cost exhaustion | script kiddie | flood attempts | INV-21 budgets, rate limits, cache, fail closed to replay | replay mode shown instead of live |
| *(v2)* Sandbox → prod pivot | anonymous attacker | shared keys/DB/process | INV-16 separation + boot guards | operator misconfiguration (guards fail closed) |
| *(v2)* Social engineering of the approver | malicious vendor | persuasive LLM-echoed text next to Approve | INV-20, templated explanations, escalation budget (K-12) | a human can still approve a bad payment knowingly |
| *(v2)* Overclaiming | us | "provable", "guaranteed" | DEC-012, INV-18, `claims:lint`, certificate assumptions/exclusions | reviewer disagreement on assumptions (disclosed) |
| *(v2)* Swarm compromise | prompt-injected coding agent / malicious dependency | fetched content, npm postinstall | DEC-017: no real keys in agent sessions, deny rules, lifecycle scripts off, pinned deps | human error |
