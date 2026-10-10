# CHANGES_V2 — what changed from the v1 pack, and what to do about it

> Read this once. It tells you (and your Claude Code agents) exactly what moved, what broke compared with v1, and what the SCHEMAS lane must add *now*. Companion: `kickoff/V2_RECONCILE.md` (paste into your existing Claude Code session).

## 1. Why v2 exists (one paragraph)

v1 was a good *product* ("LLM proposes, kernel decides, vault enforces") but a weak *submission*: many teams will build "AI agent + guardrails + USDC", and nothing in v1 let a judge **verify** our claim in under a minute or **attack** it themselves. v2 adds one spine — ***Don't trust the agent. Bound it. Prove it. Invite attack.*** — and four things that serve it: a recomputable **Loss Bound Certificate**, a public testnet **"Break the Treasurer"** challenge, a **Treasury Planner** that does more than arithmetic, and a harder **attack suite** (24 attacks, three baselines, a hold-out set). A red-team pass (`14`) then attacked *our own plan*; the fixes are folded into every doc.

## 2. New files

| File | Purpose |
|---|---|
| `docs/14_RED_TEAM_V2.md` | 33 findings RT-01..33 (security of the public surface, integrity of our claims, delivery risk), fix→WP map, pre-mortem, acceptance checklist, residual risks |
| `docs/15_CHALLENGE_SPEC.md` | "Break the Treasurer": scenarios S-A/S-B/S-C, `oracle-v1` loss predicates O1..O8, isolation + 7 boot guards, abuse/cost controls, safe rendering, replay bundles, degrade ladder |
| `docs/16_LOSS_CERTIFICATE_SPEC.md` | Certificate schema `lbc/1`, `bounds.ts` contract, verification + staleness, language rules (DEC-012), 8 required tests |
| `docs/17_MODEL_AND_EFFORT_ROUTING.md` | Which Claude model and effort for which role/WP (machine-readable JSON block), where `ultracode:` is allowed, escalation + burn guard |
| `docs/CHANGES_V2.md` | this file |
| `kickoff/V2_RECONCILE.md` | one-off prompt to reconcile an existing v1 repo |
| `.claude/` | generated role files (`model:`/`effort:`), `settings.json` (subagent default + secret-read deny rules), README |

## 3. Changed files (what each one gained)

| Doc | v2 change |
|---|---|
| `00_START_HERE` | spine; decisions DEC-011..018; accounts for the sandbox (§6b); gates re-based |
| `01_PRD` | one spine; honest comparison table vs Circle Agent Wallets (§9b); P1/P2 frozen |
| `02_ARCHITECTURE` | TB-6 (public attacker → sandbox); **INV-15..23**; new components; sandbox deployment; sequences 5.5–5.7 |
| `03_AGENT_SPEC` | D2 = **Treasury Planner** (pick a `planId` from a kernel-computed feasible set); templated explanations; guardrails 7–10 |
| `04_KERNEL_SPEC` | K-01 no-binary; K-08 `amountDue`; K-09 evidence profiles; K-12 escalation budget; K-14 terms binding + feasible plans + discount window; 6 new reason codes |
| `05_DATA_MODELS_AND_API` | v2 shapes; **`0002_v2.sql`**; new API + web routes; `ApprovalView` |
| `06_CONTRACTS_AND_CIRCLE` | vault: `configHash`, `ConfigChanged`, engagement list, `RING_SIZE`, **no limit setters**, reproducible build; sandbox env + webhook hardening; B0 vendoring |
| `07_ATTACK_SUITE` | ATK-21..24; hold-out protocol; baselines B0/B1/B2 + `applicability.json`; statistics |
| `08_BLAST_RADIUS` | numbers packaged as a certificate; `bounds.ts` single implementation; language rule; availability caveat |
| `09_TRACTION_AND_PILOTS` | INV-17 (attack traffic ≠ traction), INV-18 (claims computed), challenge as funnel, outreach hours protected |
| `10_SWARM_PLAN` | role **SEC**; **WP-32..39**; v2 scope added to existing briefs; WP-30/31 frozen until G4 |
| `11_DEMO_AND_SUBMISSION` | video re-timed around the spine (hook ≤ 20 s); `/judge` 5 cards; README first screen; replay mode |
| `12_RISKS_AND_GATES` | gates re-based + G6; risks **R29–R41**; re-ordered cut list; runbooks R-SANDBOX / R-BUDGET / R-CERT-STALE |
| `13_TEST_PLAN` | SEC-01..14; certificate, planner, hold-out, replay, claims-lint suites; CI jobs; VERIFIER checklist items 11–20 |
| `AGENTS.md` | prime directives **8–12**; ownership rows; §9 routing; §10 invariants |

## 4. Breaking changes vs v1 (do these in your repo)

1. **Baseline names.** `naive` → **B1**; `arc-escrow` → **B0** (vendored decision path at a pinned commit; fallback to B1 if vendoring exceeds 3 h); new **B2** (hardened). `0002_v2.sql` renames the stored `attack_runs` targets.
2. **Attack count 20 → 24**, plus hold-out `ATK-H*`. The G4 floor is now "B1 loses on ≥ 12 **applicable** attacks; Symbolon 0 on all applicable" (not "naive ≥ 12/20").
3. **`termsHash` preimage** now explicitly includes `paymentTerms` and `milestones[].evidenceSpec`. No EIP-712 struct change, but any engagement signed under v1 has a different hash: re-sign (testnet only, so cheap).
4. **Vault changes (additive):** `engagementIds` / `engagementCount()` / `engagementIdAt()`, `RING_SIZE`, `configHash()` (excludes `paused` and `pendingSigner*`), `ConfigChanged`, **no limit setters** (changing P/D/H/hourlyCap means a new vault), `foundry.toml` `bytecode_hash = "none"` and `cbor_metadata = false`. A vault already deployed from v1 cannot get a certificate; redeploy on testnet.
5. **Database:** run the **append-only** migration `0002_v2.sql` (see `05` §3b). Never edit `0001_init.sql`. `is_internal` is replaced by `tenants.kind ∈ {pilot, demo, challenge}`; `public_pilot_stats` is rebuilt to filter `kind='pilot'`.
6. **Kernel:** six new reason codes (`TERMS_NOT_SIGNED`, `TERMS_MISMATCH`, `DISCOUNT_WINDOW_CLOSED`, `EVIDENCE_SOURCE_DENIED`, `ESCALATION_BUDGET_EXCEEDED`, `PLAN_OUT_OF_ENVELOPE`). K-14 ignores invoice-printed due dates when signed terms exist. The kernel never parses binary files.
7. **Web:** two build profiles (`app`, `challenge`); wallet/signing code only under `apps/web/src/wallet/**`; challenge/replay code (`src/challenge/**`, `src/replay/**`) may import none of it (lint + dependency-cruiser). All attacker-derived strings go through `<UntrustedText>`.
8. **Gates and dates** re-based (`12`); G6 deploy freeze Sat Oct 17 22:00 IST. Reminder: confirm the real deadline in Discord (Luma shows Oct 10; the official page says Oct 17).
9. **Agent rules:** AGENTS.md prime directives 8–12 apply to every lane; every kickoff prompt now starts with `MODEL / EFFORT / LAUNCH`.
10. **Bug in the v1 scaffold zip:** `.github/workflows/ci.yml` had an unquoted `run:` containing `: ` and would not parse on GitHub. Fixed in the v2 pack; if you used the v1 scaffold, take the new file.
11. **`release()` signature (found in review).** v1 text: `release(a, kernelSig, ownerApprovalSig)`. v2: `release(a, kernelSig, OwnerApprovalRef ref, ownerApprovalSig)`. Reason: the owner signs `OwnerApproval` over the *escalation* receipt hash, but the attestation carries the *final* receipt hash, so the vault could not rebuild the signed struct. `POST /approvals` now also takes `receiptHash`. Any vault deployed from the v1 text must be redeployed (testnet only). See `06` A.4.

## 5. Placement decisions made while cross-checking the docs

| Decision | Where | Why |
|---|---|---|
| `buildApprovalTypedData()` and `renderModel()` live in `packages/receipts/src/approval/` (built in WP-02; the WP-19 screen consumes them) | `05`, `07`, `10` | packages may not import `apps/web`, yet ATK-22/23 and SEC-13 must test the same function the UI uses |
| `formatBaseUnits()` lives in `packages/schemas` (chain re-exports) | `10` WP-01 | receipts needs a bigint→string formatter without depending on `chain` |
| The explanation templater lives in `kernel-core/src/explain/` and is built in WP-05 (the kernel renders `humanExplanation`; WP-16 keeps only the optional Advisory (AI) note validator) | `03` §6, `07`, `10` | INV-20: prose is derived from structured facts by the kernel, not by an LLM |
| Planner simulated corpus: `packages/extractor/eval/planner/` | `03` §5.5 | the planner lives with the extractor (AGENT) |
| `services/kernel/src/challenge/**` is the only services path allowed to import `packages/extractor` | `.dependency-cruiser.cjs` | the sandbox hosts the challenge orchestrator; `kernel-core` still never imports it |
| ATTACK-ADV is its own role file (opus/high, no `kernel-core` access) | `17` | hold-out independence (RT-07) |
| The deterministic plan evaluator lives in `packages/terms/src/eval/` (KERNEL-CORE, WP-05); AGENT (WP-35) adds only the hindsight oracle, corpus and metrics in `packages/extractor/eval/planner/` | `03` §5.5, `10` | `services/kernel` may not import the extractor, yet needs the fallback plan |
| `oracle-v1` is the pure package `packages/oracle` (ATTACK, WP-23; imports only `schemas`); the attack harness and the challenge service use it, no defender package may | `07`, `15` §2, `10` | one authority on "loss" that cannot be tuned against `kernel-core`; services may not import `attack-suite` |
| `packages/blast-radius/test/reference.py` is owned by VERIFIER (BLAST must not edit it) | `AGENTS.md` §1, `16` §10 | a second implementation is only independent if BLAST did not write it |
| The sandbox SEC set is SEC-01..10 + SEC-14; SEC-11/12/13 are local-only gates | `13` §4.6, `12` G4 | SEC-12/13 need the production relayer / wallet code that the sandbox deliberately lacks |
| Rate limits are keyed on the salted IP hash only (5/h, 30/day); no browser fingerprinting | `15` §4, `14` RT-04, `13` SEC-08 | privacy cost, and a fingerprint is trivially evaded |
| Rule-of-three `N` = distinct human (text, scenario) attempts; one-click replays, cache hits and house runs excluded | `15` §8, `09`, `11` | cached or scripted repeats are not independent trials |
| Challenge CSP uses a per-request nonce with `'strict-dynamic'` (no `unsafe-inline`) | `15` §6, `13` SEC-06 | Next.js emits inline bootstrap scripts; plain `script-src 'self'` would break the page |
| Certificate horizons are half-open `[T, T+t)` | `16` §2.2, `08` | the vault's rolling window excludes a release exactly 24 h old |

## 6. Schemas delta (SCHEMAS lane: do this before the G1 freeze)

Add to `packages/schemas` (Zod + JSON Schema + vectors where marked **V**):

- `PaymentTerms` (**V**: with and without `earlyPay`) inside the `termsHash` preimage; `milestones[].evidenceSpec`
- Extended `Engagement`, `Document` (text + blob hash), `PaymentIntent`, `Decision`, `Receipt` (fields per `05` §2/§3b)
- `ExtractedInvoice.statedTerms` (compared, never adopted)
- `FeasiblePlan`, `PlanEvaluation`, `PlanSelection`
- `ApprovalView` + `OwnerApproval` typed data (**V**: JCS vector)
- `LossBoundCertificate` `lbc/1` (**V**: canonicalization vector)
- `ChallengeScenario`, `ChallengeAttempt`, `ChallengeStats`, `ReplayBundle`
- The 6 new reason codes
- `Untrusted<T>` brand, `normalizeUntrusted()` (**V**: zero-width, bidi, control chars, counts), `sanitizeLlmText()`
- `formatBaseUnits(units, decimals)`

If the freeze tag (`schemas v1.0`) already exists in your repo: file an RFC in `docs/QUESTIONS.md` and ship these as `v1.1`.

## 7. New identifiers (so you can grep)

DEC-011..018 · INV-15..23 · RT-01..33 · ATK-21..24 (+ hold-out `ATK-H*`) · SEC-01..14 · R29..R41 · WP-32..39 · reason codes (6) · gate G6 (new; G0–G5 extended) · runbooks R-SANDBOX, R-BUDGET, R-CERT-STALE · assumptions A-TOKEN, A-CHAIN, A-MODEL.

## 8. What Kevin still has to do (agents cannot)

1. Ask in Discord which date is real (Oct 10 vs Oct 17) and `arc-canteen update product` / `update traction` (baseline entries).
2. Create the **sandbox** accounts: second Supabase project, second Vercel project, second Railway service, a separate Anthropic key with a provider-side spend cap, throwaway testnet keys, a domain/subdomain (`00` §6b).
3. Fill the contact email in `SECURITY.md` and read the safe-harbor wording once (it states intent, not a legal guarantee).
4. Keep ≥ 3 h/day for outreach. The challenge is a funnel, not traction by itself (RT-33).
5. Decide mainnet GO/NO-GO at G3 (default NO-GO unless the rule in `12` §1 is met).
6. Never paste a real private key into any agent session (AGENTS.md §0.10).

## 9. Honest caveats

- Model benchmark statements in `17` are Anthropic's published numbers as relayed by third parties: **directional**, not verified on this codebase. The routing is deliberately conservative where a mistake is irreversible.
- B0 vendoring (the real `arc-escrow` decision path) may not be clean; the fallback is stated in `07` and `10`.
- Planner results are **simulated**, and are labelled that way everywhere. Real savings are reported separately as `realizedDiscount` (what actually moved).
- The certificate is a **calculation from on-chain state under stated assumptions** plus empirical tests, not a proof of safety, and not an audit.
- This pack is specs, tooling and agent configuration. The product code (kernel, vault, certificate, challenge) still has to be built by the lanes; nothing here claims it exists.
