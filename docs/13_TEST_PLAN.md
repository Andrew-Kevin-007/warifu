# 13 — TEST PLAN & VERIFICATION PROTOCOL

> Principle: **the claims in the README are test results.** Every number we publish is produced by a committed command and a committed result file.

> **v2 delta.** New suites: **SEC-01..14** platform security (§4.6), **hold-out + statistics** (§4.9), **Loss Bound Certificate** (§4.7), **Treasury Planner evaluation** (§4.8), **replay + claims lint** (§4.10), **swarm hygiene** (§4.11). The attack suite grows to ATK-01..24 against three baselines. VERIFIER now walks the acceptance checklist in `14` §4 (§6, items 11–20). Every number that reaches a public surface comes from `scripts/claims.ts` (INV-18); a hand-typed number is a test failure.

## 1. Test pyramid

| Layer | Scope | Tooling | Runs | Gate |
|---|---|---|---|---|
| **Unit** | kernel checks, `parseMoney`, receipts, policy, bounds math, schema/consensus | Vitest | every commit | CI |
| **Property** | determinism, monotonicity, no-LLM influence, parsing round-trips, caps over sequences, fail-closed, *(v2)* terms math (floor, APR, window edges), feasible-plan set closure, certificate-bound monotonicity | fast-check (≥ 1,000 runs in CI; 10,000 pre-release) | every commit / nightly | CI |
| **Contract** | vault unit, fuzz, invariants, EIP-712 vectors, ERC-1271, Arc decimals, *(v2)* engagement list, `configHash`, ring size, ABI-surface check | `arc-forge test` (Arc Foundry) | every commit touching `contracts/` | CI |
| **Integration** | kernel service ↔ real Postgres ↔ anvil vault ↔ mocked Circle HTTP | Vitest + testcontainers/local Supabase | every PR | CI |
| **E2E (local)** | full flow on `arc-anvil` with real kernel + web (Playwright) | Playwright | nightly + pre-demo | G-gates |
| **E2E (testnet)** | real Circle relayer + Arc testnet | scripts + Playwright | before each gate; demo | G2+ |
| **Attack suite** | ATK-01..24 × {B0, B1, B2, symbolon} with `applicability.json` + honest corpus + hold-out `ATK-H*` | `packages/attack-suite` | `unit` in CI; `e2e-local` nightly; hold-out H1 at G3, H2 at G5 | G3/G4/G5 |
| **Blast Radius validation** | T3 simulator vs bound; T1 red-team | `packages/blast-radius` | nightly from Mon | G3/G4 |
| **Security** | secrets scan, boundary lint, dependency audit; *(v2)* **SEC-01..14** (XSS, SSRF, isolation, budget, boot guards, CSP, supply chain, WYSIWYS, tokens) | gitleaks, dependency-cruiser, `packages/sec-suite`, `pnpm audit` | CI (local profile); SEC-01..10 and SEC-14 again against the **deployed sandbox** before G4/G5 | CI, G4, G5 |
| **LLM evals** | extraction accuracy, injection recall, cost/latency | `packages/extractor/eval` | on prompt/model change | G1/G4 |
| **Certificate** *(v2)* | `bounds.ts` goldens/properties/differential, anvil staleness matrix, tamper, verifier mutation | Vitest + anvil + `reference.py` | every commit touching `blast-radius`; nightly | G3/G4 |
| **Planner eval** *(v2)* | simulated corpus ≥ 120 incl. traps; regret vs oracle and baselines; faithfulness | `packages/extractor/eval/planner` | on prompt/model change; nightly | G4 |
| **Challenge oracle** *(v2)* | `oracle-v1` O1..O8 ground truth per scenario; house attackers | `services/kernel/src/challenge` + `packages/attack-suite` | nightly (house); per PR (unit) | G3/G4 |
| **Replay / claims** *(v2)* | `verify-bundle`; `claims:lint`; `claims.ts` determinism | `scripts/*` + `packages/sec-suite` | CI | G4/G5/G6 |

## 2. Coverage and quality targets

- `kernel-core`: **100% branch** on K-01..K-14 and the pure parts of K-16 (K-15 is service-side, §4.3); *(v2)* the same bar for `packages/terms`, `blast-radius/src/bounds.ts` and `blast-radius/src/lbc/verify.ts`; mutation spot-check (Stryker on `checks/` if time) ≥ 80% on K-02, K-06, K-08, K-12, *(v2)* K-14 terms binding, `bounds.ts` and `lbc/verify.ts` (the verifier mutation test in `16` §10 reports its kill rate).
- Contracts: ≥ 95% line, **100% of revert paths**, invariants INV-1..7, 12 hold at ≥ 10k runs. *(v2)* plus: the engagement list is append-only and `engagementCount()` never decreases; `configHash()` is invariant under `pause()` and `release()` and changes under every mutation of a hashed field (`kernelSigner`, `guardian`); the ring buffer is exactly `RING_SIZE` (64) slots; the ABI exposes **no** limit/cap setter (test fails if one appears); *(review fix)* an owner approval for amount X never releases X + 1, never works on another `intentId`, and a stale `ref.deadline` reverts `ApprovalExpired`.
- Web: Playwright happy path + 3 attack scenarios; Lighthouse a11y ≥ 90.
- *(v2)* Web: Playwright adds the approval-screen WYSIWYS flow, the `/challenge` one-click attack flow, and the **backend-killed replay** flow; XSS corpus runs against every public route.
- *(v2)* `scripts/claims.ts` and `build-replay-bundle.ts` are unit-tested (same inputs ⇒ byte-identical outputs).
- No test may assert only against mocks of the unit under test. Mock **only** network edges (LLM, Circle HTTP, GitHub).

## 3. Determinism and reproducibility

- Seeds recorded in every result file; LLM at `temperature: 0`; recorded outputs (`*.recorded.json`) used in CI; `--live-llm` re-records.
- `evaluate()` is run twice per test case in `P-DET`; `receiptHash` must match.
- Result files committed: `results/attack-matrix.json|md`, `results/honest-corpus.json`, `results/extractor-eval.json`, `results/blast-latest.json`, each with `{gitSha, seed, models, promptHashes, anvilForkBlock}`. *(v2)* Also: `results/holdout-H1.json`, `results/holdout-H2.json` (n, k, upper bound, `holdoutRoot`), `results/planner-eval.json` (every figure labelled `SIMULATED`), `results/lbc-validation.json`, `results/sec-suite.json`, `results/claims.json` (the single source for every public number), and `deployments/*.json`; the replay bundle and its hash are built from these.
- *(v2)* **Hold-out fixtures live outside the repo** (`../symbolon-holdout/`); only `holdout/ROOT` and the runner are committed. A hold-out fixture is **never edited to make a test pass** — if a fixture is wrong, it is retired in the manifest with a reason, and the report says so.

## 4. Specific test suites (must exist)

### 4.1 Kernel
- **K-02 vectors:** every row in `04_KERNEL_SPEC.md` §4 (K-02) plus 200 generated locale-format cases; assertion: never a *different* value, only exact or `AMBIGUOUS`.
- **K-04:** duplicate, near-duplicate, same-doc-different-number, same-milestone-new-invoice.
- **K-06:** name collisions, EIP-55 vs lowercase, address-change claims, pending payee change.
- **K-07:** 6↔18 scaling vectors; absurd-scale rejection.
- **K-09:** SSRF suite, evidence from untrusted sources ignored, stale evidence, hash mismatch.
- **K-11:** ≥ 40 positive injections (incl. zero-width/homoglyph/base64/HTML-comment) and ≥ 40 benign invoices with ≤ 5% false positives.
- **K-12:** boundary at caps ±1 base unit; velocity edges; first-payment human gate. *(v2)* **Escalation budget:** the (maxPerDay+1)-th would-be `ESCALATE` becomes `HOLD ESCALATION_BUDGET_EXCEEDED`; `REJECT` does not consume budget; the digest ranks deterministically; no code path approves more than one intent per signature.
- **K-14:** timing clamp matrix; liquidity floor. *(v2)* **Terms binding (INV-19):** stated terms with no signed terms ⇒ `TERMS_NOT_SIGNED`; any difference (either direction) ⇒ `TERMS_MISMATCH`; ambiguous terms ⇒ `TERMS_MISMATCH`; the invoice's printed due date never moves `payAt` when signed terms exist; the discount window is measured from the kernel-recorded `invoiceReceivedAt` and `payAt ≤ invoiceReceivedAt + withinDays` is inclusive at the boundary (test ±1 s); `windowSafetyMarginMinutes` respected; window closed at `payAt` ⇒ `ESCALATE DISCOUNT_WINDOW_CLOSED`, never a silent switch.
- **TOCTOU:** evidence revoked / breaker tripped / payee change proposed between decision and `payAt`.
- **Fail-closed:** inject a throw into each required check; the verdict must not be `RELEASE` and `KERNEL_ERROR` must be in the reasons (it is `HOLD` when nothing else fails at a higher severity).
- *(v2)* **`packages/terms` (property + goldens):** `discountValue = floor(gross·bps/10000)`; `impliedAprBps` golden table (hand-computed, incl. `bps → 0`, `netDays = withinDays + 1`); the discounted attestation amount is `gross − discountValue` while `intentId` stays on the gross; `feasiblePlans()` is deterministic, its `planId`s are stable and unique, every plan satisfies the reserve floor and evidence precondition, and the set is closed (a `PlanSelection` naming a `planId` outside it ⇒ `PLAN_OUT_OF_ENVELOPE`, fallback to the evaluator's top safe plan).
- *(v2)* **INV-23:** the kernel service rejects any non-UTF-8 / binary / > 4 KiB-in-challenge body *before* any parser runs; static check that `services/kernel` and `kernel-core` import no PDF/image/zip library.
- *(v2)* **No-LLM-influence extended:** mutating `statedTerms`, `humanExplanation`, `agentRecommendation`, planner `rationale` or `confidence` never changes `amountDue`, `payAt` bounds or the verdict class (property test over generated contexts).

### 4.2 Contracts (see `06` A.5)
Plus **cross-language digest tests**: TS vectors (`packages/schemas/vectors`) vs Solidity `hashTypedData` for all structs; **chain-id/domain separation** (signature for chain A fails on chain B); **signature malleability** (high-s rejected via OZ ECDSA); **ERC-1271** owner/payee.
*(v2 additions, WP-07/08):* `engagementIds` / `engagementCount()` / `engagementIdAt()` are append-only and match `EngagementRegistered` events; `configHash()` excludes `paused` and `pendingSigner*` and includes everything the bound depends on (`16` §2.4); `ConfigChanged` is emitted by every config mutation; `RING_SIZE == 64`; attestation of a **discounted** amount releases exactly that amount while `used[intentId]` is keyed on the gross-amount `intentId`; `foundry.toml` sets `bytecode_hash = "none"` and `cbor_metadata = false`, and the build artifact exposes `immutableReferences` (needed by the certificate's code-match check).

### 4.3 Service
- Idempotency: same `Idempotency-Key` and same `intentId` → one release.
- Webhook signature verification: bad/missing signature rejected; replayed webhook idempotent.
- Reconciler: missing tx, extra event, balance drift → correct finding and breaker.
- Auth: expired/forged service token rejected; tenant isolation (token for A cannot read B).
- RLS: anon cannot read base tables; views sanitized.
- *(v2)* Budget ledger (INV-21): concurrent attempts cannot overspend the global or per-principal budget (race test with 50 parallel calls); cache hits do not bill; exhaustion returns the replay banner and runs **every** deterministic check on cached/recorded data only.
- *(v2)* Challenge oracle: for each scenario S-A/S-B/S-C, `oracle-v1` predicates O1..O8 are unit-tested with synthetic chain states (a loss is counted only when the oracle says so; oracle and receipt disagreement ⇒ test failure and a `QUESTIONS.md` entry).
- *(v2)* `deployment_profile` DB trigger: inserting `tenants.kind='challenge'` in a non-sandbox DB fails; inserting `kind='pilot'` in the sandbox DB fails.
- *(v2)* Replay (DEC-016): re-running recorded attempts reproduces `receiptHash` byte-for-byte.

### 4.4 Web
- Secrets: `pnpm test:web-env` asserts no `CIRCLE_*|KERNEL_*|GUARDIAN_*` available to web runtime or bundle.
- XSS/markdown: LLM text with `<script>`, `![](javascript:)`, HTML entities rendered inert.
- `/audit` client-side verification: valid receipt passes; one flipped byte fails; wrong signer fails.
- Wallet flows: engagement signing, approval signing (typed data shown to the user matches the on-chain struct).
- *(v2)* Untrusted text: every user-controlled string reaches the DOM only through `<UntrustedText>`; lint fixture proves the ban rules fire; CSP header test on every route (SEC-06).
- *(v2)* `ApprovalView` (INV-20): rendered model and signed typed data are byte-equal under JCS; LLM prose is collapsed and labelled "Advisory (AI) — not verified" and is never inside the Approve button's container.
- *(v2)* Planner and certificate pages render the `SIMULATED` / `RECORDED` / `STALE` labels from data, not from copy.

### 4.5 Attack suite & Blast Radius
Per `07` §7 and `08` §5: **24/24** implemented; negative controls pass; for every attack × baseline the `applicability.json` row exists (N/A rows carry a reason and appear in the report; B1's headline reads "loses on x of y **applicable**"); B0 is pinned to a commit (or the fallback to B1 is stated); ≥ 500 T3 simulator trials and ≥ 200 T1 red-team plans with 0 violations; tightness reported (or demoted per `08` §11).

### 4.6 Platform-security suite SEC-01..14 *(v2; owner SEC; `packages/sec-suite`; `results/sec-suite.json`)*

Payment-integrity attacks are ATK-xx (`07`). These are **platform** tests: the public surface and the swarm itself. Each runs in the `local` profile in CI; those marked ◆ **also run against the deployed sandbox** (G4 and G5) and are required there. **The sandbox set is exactly SEC-01..SEC-10 and SEC-14.** SEC-11 (swarm hygiene), SEC-12 (Circle webhook: production relayer only) and SEC-13 (approval screen: wallet code exists only in the production app, and the challenge origin has none, INV-16) are local-profile checks by design; they are still release gates.

| ID | Maps to | Asserts |
|---|---|---|
| **SEC-01** ◆ | RT-01 | XSS corpus (≥ 40: tag/attribute/event-handler, `javascript:` and `data:` URLs, markdown-embedded HTML, SVG, CSS injection, bidi/zero-width, entity tricks) placed in invoice text, filename, vendor name, payee label, explanation and LLM prose renders **inert** on every public route (`/challenge`, attempt feed, `/judge`, `/attack-lab`, decision detail, `/certificate/*`); Playwright asserts no script execution and no unexpected element creation. |
| **SEC-02** ◆ | RT-02 | SSRF corpus (≥ 40: metadata IP, loopback, RFC1918, link-local, IPv6 forms and IPv4-mapped, decimal/octal/hex IPs, userinfo tricks, odd ports, `file:`/`gopher:`, DNS rebinding with a stub resolver, redirect chains) is denied under the production profile; under the challenge profile the egress logger records **zero** outbound evidence requests (`EVIDENCE_SOURCE_DENIED`). |
| **SEC-03** ◆ | RT-04 | Budget exhaustion ⇒ replay banner (L2), every check still runs, no silent single-model degrade, cache hits do not bill, ledger sums match provider-reported spend within tolerance. |
| **SEC-04** ◆ | RT-05, RT-09 | **Two tests.** (a) *View test* in a scratch DB with the `deployment_profile` trigger disabled for this test only: inserting `challenge`/`demo` tenants and rows leaves `public_pilot_stats`, `public_traction_summary` and every traction view byte-identical. (b) *Trigger test* with the profile set: on a production DB, inserting a `kind='challenge'` tenant or a `challenge_attempts` row is refused, and on a sandbox DB inserting a `kind='pilot'` tenant is refused; `deployments/*.json` share no signer, relayer or vault address across profiles. |
| **SEC-05** ◆ | RT-05 | For each of the 7 boot-guard conditions (`15` §3): start the sandbox kernel violating exactly that one condition; it must exit non-zero **before** it listens (also: `NETWORK=mainnet`, a production signer address, any `PROD_*` secret). |
| **SEC-06** ◆ | RT-01 | CSP matches the specified policy template on every route, with a fresh per-request nonce (≥ 128 bits, different on every request, present on every inline script the framework emits; a page with a nonce-less inline script fails) (no `unsafe-inline`/`unsafe-eval`; `frame-ancestors 'none'`; `base-uri 'none'`); `X-Content-Type-Options: nosniff`; downloads are `Content-Disposition: attachment`; the lint fixture containing `dangerouslySetInnerHTML` fails lint. |
| **SEC-07** ◆ | RT-26 | Canary secrets planted in the service env never appear in any HTTP response, error page, web bundle or log line; no `CIRCLE_*`, `KERNEL_*`, `GUARDIAN_*` in the web runtime or bundle, and no `ANTHROPIC_*` or `NEXT_PUBLIC_*KEY/SECRET/TOKEN/PRIVATE*` in the client bundle, responses or logs; log scrubber test; gitleaks clean. |
| **SEC-08** ◆ | RT-04 | Rate limits hold (5/h/IP, 30/day/IP, ≤ 3 concurrent global, ≤ 4 KiB input) with `429` + `Retry-After`; 4 KiB + 1 rejected before any LLM call; limits keyed on salted hashes, never raw IPs. |
| **SEC-09** ◆ | RT-03 | Non-text and hostile inputs (binary, NUL bytes, invalid UTF-8, oversized, deeply nested JSON, 100k combining marks, repeated-text bombs) are rejected or bounded within a fixed time and memory limit **without** invoking a parser (INV-23). |
| **SEC-10** ◆ | RT-11, RT-32 | `verify-bundle` passes on a fresh bundle and **fails** after flipping one byte in a receipt, the certificate, a tx hash or the manifest; with the backend killed, `/judge`, `/challenge`, `/attack-lab`, `/certificate/*` render from the bundle with the RECORDED label. |
| **SEC-11** | RT-26 | Static swarm checks: `.claude/settings.json` denies reading `.env*` secrets (and permits `.env.example`); `onlyBuiltDependencies` allow-list present; every dependency added since v0 appears in `CHANGELOG_SWARM.md`; no `^`/`latest` on new dependencies; `.env.example` contains placeholders only. |
| **SEC-12** | RT-30 | Webhook: bad/missing signature rejected; timestamp outside the window rejected; replay is idempotent; a webhook alone never marks a release confirmed (a chain event is required). |
| **SEC-13** | RT-12, RT-13 | `jcs(renderedModel) == jcs(signedModel)` for 200 generated approvals; mutating the rendered amount makes the test fail; no LLM prose inside the Approve container; explanation strings are template-only (property test: output ⊆ allow-listed tokens + formatted facts; imperative/urgency language stripped). |
| **SEC-14** ◆ | RT-31 | Service tokens: expired, wrong audience, wrong tenant, replayed nonce, bit-flipped MAC, `alg` confusion ⇒ rejected; constant-time compare; separate secrets per profile (boot guard). |

A red SEC test **blocks deployment of any public surface** (cut list §4 item 3 in `12`): the challenge degrades to L1/L2, it does not ship with an open P0/P1.

### 4.7 Loss Bound Certificate *(v2; WP-34; details in `16` §10)*
The eight tests in `16` §10 are the contract: goldens (≥ 12), properties, digest tests, **anvil staleness matrix**, tamper ⇒ `MISMATCH`, **verifier mutation test** (every flipped comparison/`min` must be killed), `claims:lint`, and 500-config differential agreement with the VERIFIER-authored `reference.py`. CI additionally runs `pnpm lbc verify` against a fresh anvil vault (exit 0), mutates its config, and expects exit 10; fail-closed on RPC errors (exit 20) is exercised with a stub RPC returning empty/zero/garbage. Nothing in this suite may depend on a live testnet; the testnet check is part of the G4 manual gate.

### 4.8 Treasury Planner evaluation *(v2; WP-35; `results/planner-eval.json`)*
- **Corpus:** ≥ 120 simulated scenarios (terms variants, liquidity pressure, evidence timing, window edges) including **trap** cases (ATK-21 style: invoice claims a discount or net days the signed engagement does not contain).
- **Hard gates:** 0 trap mispayments; 0 reserve-floor breaches; 100 % of selected `planId`s ∈ the kernel's feasible set; no invoice-stated term ever changes `amountDue`; explanation faithfulness 100 % (every figure in the rationale equals a field of the chosen plan); an injected out-of-set `planId` yields `PLAN_OUT_OF_ENVELOPE` and the fallback plan.
- **Soft metrics (reported, not gated):** mean net benefit vs `PAY_IMMEDIATELY` and `PAY_ON_DUE_MINUS_BUFFER`; regret vs the exhaustive-search oracle; how often the planner deviates from the evaluator's top plan and whether deviations helped.
- **Labelling test:** every figure in the output carries `SIMULATED`; the string "realized" / "saved" never appears next to a planner number (enforced by `claims:lint`).

### 4.9 Hold-out and statistics *(v2; WP-36; `07` §3.3)*
- `stats.ts` is tested against reference vectors: rule of three (`3/n` when `k = 0`), Clopper–Pearson and Wilson intervals at 95 % for a grid of `(n, k)` including `k = n` and `n = 1`.
- `holdout/ROOT = keccak256(JCS(manifest))` is committed **before** the first defender run; CI job `holdout-verify` recomputes the root from the fixtures when they are present (VERIFIER's machine, Kevin's machine) and fails on mismatch; in the public repo CI it only checks that `ROOT` exists and its commit predates the first `results/holdout-*.json`.
- H1 (G3) is a **first look**: results are published as found, with failures, and the defender lane may fix the *class* of bug but must not read the fixtures. H2 (G5) uses a fresh root and fresh fixtures from ATTACK-ADV.
- The report always contains: `n`, `k`, the 95 % upper bound, the applicability exclusions, and a **known-limits** table. "0 losses" is rendered as "0 in n (upper bound ≈ 3/n)", never "unbreakable".

### 4.10 Replay, claims and wording *(v2)*
- `pnpm build-replay` is deterministic (same inputs ⇒ same bundle hash); `pnpm verify-bundle` re-derives `receiptHash` by re-running the kernel on recorded inputs, checks signatures, tx hashes against the explorer (when online), the certificate's `lbc verify` digest fields and the manifest.
- `pnpm claims` generates `results/claims.json`; `pnpm claims:lint` fails on (a) forbidden words (`proven`, `provably`, `guaranteed`, `audited`, `unhackable`, `unbreakable`, `100 % secure`, `risk-free`/`zero risk`; full rule and scope in `16` §4.3; implemented by `scripts/claims-lint.mjs`), (b) any number in README / `/judge` / video script / submission form that is not present in `claims.json`, (c) a planner figure without `SIMULATED`, (d) a traction figure whose source view is not `kind='pilot'`. A seeded forbidden word must fail the lint (self-test).

### 4.11 Swarm hygiene *(v2; DEC-017)*
SEC-11 plus: a CI step prints the dependency diff against the previous tag and fails on any new package that is not logged in `CHANGELOG_SWARM.md`; a scripted check proves `claude`-launched sessions in the repo cannot read `.env.local` (deny rule test via `claude` settings parse, not by running a model); gitleaks runs on every PR **and** on the final tag.

## 5. CI pipeline (GitHub Actions)

```
jobs:
  lint-typecheck:  pnpm lint && pnpm typecheck && depcruise (boundary rules)
  unit-property:   pnpm test --coverage (kernel-core 100% branch gate)
  contracts:       arc-forge build && arc-forge test --fuzz-runs 5000 && invariants
  integration:     services up (Postgres, anvil) -> pnpm test:integration
  security:        gitleaks && pnpm audit --prod && pnpm test:web-env && pnpm sec:local   # SEC-01..14 (local profile)
  claims:          pnpm claims && pnpm claims:lint          # INV-18, DEC-012
  lbc:             anvil -> deploy vault -> pnpm lbc build && pnpm lbc verify (expect 0) -> mutate config -> verify (expect 10)
  attack-unit:     pnpm attack:unit  (recorded LLM outputs, < 3 min)
  e2e-nightly:     anvil + kernel + web -> playwright; attack e2e-local; blast validation; planner eval; house attackers (≤ 200)
  sandbox-gate:    (manual, before G4/G5/G6) pnpm sec:sandbox (SEC-01..10, 14; needs SANDBOX_URL) against the deployed sandbox; verify-bundle; lbc verify with an independent RPC
  holdout-verify:  checks holdout/ROOT presence and ordering (full recompute where fixtures exist)
artifacts: results/*.json, coverage, gas snapshot, replay bundle (+ hash)
```
`make verify` runs: lint, typecheck, unit/property, contracts, integration, security (incl. `sec:local`), claims + claims:lint, lbc (anvil), attack-unit, and prints a summary table; it exits non-zero on any failure. VERIFIER uses only this (plus the sandbox-gate steps above, which need the deployed sandbox).

## 6. Independent verification protocol (WP-29)

**Pass #1 (Mon Oct 12, before mainnet decision): contracts (incl. v2 additions) + kernel core + `packages/terms`; ATTACK-ADV's hold-out round H1 is run in parallel (it is not a VERIFIER task).**
**Pass #2 (Thu Oct 15, before freeze): whole system + README claims + certificate + SEC suite (all 14 local; SEC-01..10 and SEC-14 on the deployed sandbox) + hold-out H2 results.**
**Pass #3 (Fri Oct 16, pre-submission): smoke + live URL + video claims + replay mode with the backend killed + bundle hash in README.**

VERIFIER rules (*v2:* run on `opus`/`xhigh`; the three passes use the `ultracode:` prompts in `17` §5; the VERIFIER authors `reference.py` itself and never edits implementation code); fresh context; may read `docs/` and run `make verify`; may read source *after* forming attack hypotheses; must not be coached by implementers; reports in `docs/VERIFIER_FINDINGS.md` as:

```
ID | Severity (P0 blocks gate, P1 blocks gate, P2 fix if time, P3 note) | Area | Repro steps | Expected vs actual | Suggested fix
```

**Checklist (non-exhaustive):**
1. Prompt-inject every free-text input (invoice, payee label, milestone description, evidence URL, document filename).
2. Re-run the attack suite with 3 new seeds; try 10 novel attacks not in the corpus.
3. Contract review: reentrancy, signature replay across chains/contracts, malleability, signer rotation delay, guardian powers, `address(0)` handling, decimals, ring-buffer wraparound, `used[]` ordering.
4. Try to make `release` succeed with: wrong payee, above `perTxCap`, above `H` without approval, expired deadline, reused `intentId`, paused vault, outside window, above engagement cap.
5. Confirm LLM output cannot change a verdict (mutate `confidence`, `humanExplanation`, `agentRecommendation`).
6. Extract secrets from web bundle/network tab/logs/error pages.
7. SSRF attempts through every URL-accepting field.
8. Verify each README number against `results/*.json` and live pages; verify each "uses X" claim.
9. Check explorer links in `/pilot` resolve and amounts match.
10. Run the 5-minute `/judge` path on mobile and a clean desktop profile.
11. *(v2)* Walk the acceptance checklist in `14` §4 line by line; a box is ticked only with a link to a test or artifact.
12. *(v2)* `pnpm lbc verify` with your **own** RPC ⇒ 0; change the vault config on anvil ⇒ 10 with a diff; edit one bound in the JSON ⇒ 30; stub RPC returning zeros ⇒ 20.
13. *(v2)* Public-surface abuse: XSS/SSRF/oversize/binary payloads through the challenge; confirm zero outbound requests (egress log) and inert rendering.
14. *(v2)* Boot the sandbox with a production secret present, then with `NETWORK=mainnet`, then with a production signer: each must refuse to start.
15. *(v2)* Approval screen: capture the rendered model and the signed typed data; compare JCS bytes; try to put LLM prose next to Approve.
16. *(v2)* Terms injection: invoice claims "2/10 net 30" (or a different `netDays`) with no matching signed terms ⇒ `amountDue` unchanged and `ESCALATE TERMS_*`.
17. *(v2)* Kill the backend; `/judge`, `/challenge`, `/attack-lab`, `/certificate/*` still render from the bundle; tamper the bundle; `verify-bundle` fails.
18. *(v2)* `pnpm claims:lint`; grep the repo and video script for forbidden words; every number must be present in `results/claims.json`.
19. *(v2)* Swarm hygiene: `.claude/settings.json` deny rules present; no real key in any session env or repo history (gitleaks full history); lifecycle scripts blocked.
20. *(v2)* Baselines: B0 commit pin present (or fallback stated); every `applicability.json` N/A row has a reason you agree with; hold-out `ROOT` commit precedes the first hold-out result.

## 7. Manual exploratory scripts (Kevin, 30 min, Thu Oct 15)
Do the demo end-to-end as if you were a judge who has never seen it: wrong-wallet attempt, duplicate invoice, ambiguous amount, big payment needing approval, pause/unpause, receipt verification, `/challenge` free-form with a weird invoice. *(v2)* Then, from a phone on mobile data: open `/challenge`, fire three one-click attacks, write one of your own, read the certificate headline aloud and check every assumption and exclusion is visible without scrolling past the number; run `pnpm lbc verify` from a clean machine; open the README on a laptop and confirm the first screen shows the scoreboard + certificate.

## 8. Flake and failure policy
- A flaky test is a bug in the test or the code; **quarantine for ≤ 24 h with a ticket, then fix or delete**.
- A failing property test **seed is committed as a regression fixture**.
- A failing differential Blast Radius trial **blocks the gate** until the bound or the contract is fixed.
- *(v2)* A failing certificate test (staleness, tamper, mutation kill) blocks the gate exactly like a failing contract invariant.
- *(v2)* A red SEC test blocks **deployment of any public surface** (degrade per `12` §4 item 3). SEC tests are never quarantined.
- *(v2)* Hold-out fixtures and oracle predicates are never edited to turn a result green; a fixture is retired with a written reason or not at all.

## 9. Evidence we ship with the submission
CI badge; `results/*` with git SHA; coverage summary; contract gas/invariant report; VERIFIER findings summary with resolutions; list of `VERIFY_LOG` resolutions (shows we read the docs, not guessed). *(v2)* Also: `results/claims.json`; hold-out roots + H1/H2 reports; SEC suite result (local and sandbox); the Loss Bound Certificate JSON with its `lbc verify` output; the replay bundle and its hash; `docs/14` §4 checklist with links.
