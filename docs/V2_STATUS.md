# V2_STATUS — work-package board (ORCH)

Owner: ORCH. Updated: **2026-10-10 22:00 IST**. Every ~3 h and at every gate: update this table, `docs/CHANGELOG_SWARM.md` and post the 10-line status (`docs/10` §7). If a usage limit hits mid-WP: commit WIP to the branch, write the state here, stop.
**LEAN MODE (Claude Pro):** max **2 terminals, at most 1 on Opus**. Routing = `docs/17` §4 JSON (lean), launch lines below copied from the regenerated `kickoff/INDEX.md` (if they disagree, INDEX wins). Spawn order: `docs/SPAWN_PLAN_W0_W1.md`. Decisions: `docs/QUESTIONS.md` ("FINAL ANSWERS").

**Sessions:** standing terminals are **T1 Opus xhigh: WP-01 (now)** and **T2 Sonnet medium: WP-27 (now)**, then WP-22, WP-16, WP-09 after WP-01 v0 merges. ORCH is an on-demand Sonnet session at gate checkpoints, never a standing third terminal.

**Calibration run = WP-01 (Kevin, 2026-10-10).** Fill in from `/usage` before and after; no re-baseline tonight.

| Field | Value |
|---|---|
| WP-01 estimate (`docs/10` §4) | 5 agent-hours |
| WP-01 actual wall-clock (start → v0 merged) | _start: ___ · v0 merged: ___ · = ___ h_ |
| Plan usage before WP-01 (session % / weekly %) | ___ / ___ |
| Plan usage after WP-01 v0 (session % / weekly %) | ___ / ___ |
| **Projected weekly %** = (weekly % WP-01 used ÷ 5 h) × remaining estimate hours | ___ |
| Capacity to G2 | **~16 productive hours** (Kevin sleeps), × terminals, not 26 |

**If the projection is over ~70 % of the weekly allowance or over 16 h × terminals**, pull levers in this order and tell Kevin which: (a) `xhigh` → `high` on G2-path WPs whose acceptance is fully gated by golden/property tests (keep `xhigh` for WP-01, the kernel severity/ordering core and the vault release path WP-14); (b) a second Opus terminal, only after WP-01 v0 has merged and only with Kevin's approval; (c) move non-safety deliverables from G2 to G3; (d) slip G2 by ≤ 12 h with G3 fixed (Kevin's explicit OK). Never trade away the never-cut list, INV/RT coverage or the SEC set.

**Status legend:** `DONE` merged on `main` · `READY` deps met · `NEXT` queued for the named slot · `WAIT` starts when the named dep merges · `BLOCKED` deps not merged · `HOLD` waiting on Kevin · `FROZEN` not to be started (DEC-018) · `IN PROGRESS` / `IN REVIEW` set by ORCH.

**Gate clock (IST):** G0 Sat 20:00 (missed; see QUESTIONS) · **WP-01 v0 merges tonight** · **G1 schemas freeze Sun 09:00** (moved from Sat 23:59, Kevin) · G2 Sun 23:59 (no slip) · G3 Mon 23:59 (no slip) · G3.5 Tue 23:59 · G4 Wed 23:59 · G5 Thu 18:00 · G6 deploy freeze Sat Oct 17 22:00. Deadline confirmed Sep 27 – Oct 17 (official Tameion page).

**Cuts pre-applied (Kevin, `docs/12` §4):** 1 P1/P2 (WP-30/31 frozen) · 2 no house-attacker LLM loop · 3 challenge launches at **L1** (one-click + benign; free-form only if budget allows) · 5 drop hold-out **H1**, keep H2 · 7 no Blast Radius LLM red-team loop. The "Never cut" list stands. No further cuts without asking Kevin.

**Frontend:** Kevin owns look and layout. Agents own exactly 5 safety components: (a) security headers + nonce middleware, (b) `<UntrustedText>`, (c) the no-secrets check → WP-17; (d) approval screen on `ApprovalView` / `buildApprovalTypedData()` / `renderModel()` → WP-19; (e) receipt verifier → WP-20. Template = `create-next-app` (App Router, TS, Tailwind) + shadcn/ui, Next 15.x pinned exact, 30-minute time-box, hand-roll if not clean.

| WP | Title | Role | Wave | Deps | Status | Launch | Kickoff |
|---|---|---|---|---|---|---|---|
| 00 | Repo bootstrap, CI, lint rules, Makefile | ORCH | W0 | none | DONE on `main` (scaffold); Windows fix + plan in PR #1 | `claude --model sonnet --effort high` | `kickoff/WP-00_repo-bootstrap-ci-lint.md` |
| 01 | Schemas + JCS + EIP-712 vectors (+ v2 shapes) | SCHEMAS | W0–W1 | 00 | READY: **Opus slot, now**. v0 must merge tonight | `claude --model opus --effort xhigh` | `kickoff/WP-01_schemas-jcs-eip-712.md` |
| 02 | Receipts (JCS/hash/sign/verify CLI) | KERNEL-CORE | W1 | 01 | WAIT: WP-01 v0 (Opus queue) | `claude --model opus --effort xhigh` | `kickoff/WP-02_receipts-jcs-hash-sign.md` |
| 03 | Policy loader/hash/consistency (+ treasury/escalation keys) | KERNEL-CORE | W1 | 01 | WAIT: WP-01 v0 (Opus queue) | `claude --model opus --effort xhigh` | `kickoff/WP-03_policy-loader-hash-consistency.md` |
| 04 | Kernel checks K-01..K-08 + algebra + `packages/terms` | KERNEL-CORE | W1 | 01,03 | WAIT: WP-01 v0 + WP-03 (Opus queue) | `claude --model opus --effort xhigh` | `kickoff/WP-04_kernel-checks-k-01.md` |
| 05 | Kernel checks K-09..K-14, K-16 logic, patterns (+ terms binding, feasible plans, escalation budget, profiles) | KERNEL-CORE | W2 | 04 | BLOCKED: deps 04 | `claude --model opus --effort xhigh` | `kickoff/WP-05_kernel-checks-k-09.md` |
| 06 | Chain package (Money, ABIs, decoders) | CHAIN | W1–W2 | 01,07 | BLOCKED: deps 01,07 | `claude --model sonnet --effort high` | `kickoff/WP-06_chain-package-money-abis.md` |
| 07 | `SymbolonVault` + tests + deploy (+ certificate surface, reproducible build) | CONTRACTS | W1 | 01 | NEXT: Opus slot after WP-01 v0 (drafts Solidity; tests need Arc Foundry, Kevin installs) | `claude --model opus --effort xhigh` | `kickoff/WP-07_symbolonvault-tests-deploy-certificate.md` |
| 08 | Vault hardening: invariants, fuzz, hourlyCap, ERC-1271 | CONTRACTS | W3–W5 | 07 | BLOCKED: deps 07 | `claude --model opus --effort xhigh` | `kickoff/WP-08_vault-hardening-invariants-fuzz.md` |
| 09 | DB migrations + RLS + views (+ `0002_v2`: kinds, budget, challenge, certificates, replay) | KERNEL-SVC | W1 | 01 | WAIT: WP-01 v0 (Sonnet queue; portable Postgres pending Kevin's OK) | `claude --model sonnet --effort high` | `kickoff/WP-09_db-migrations-rls-views.md` |
| 10 | Kernel service skeleton, auth, context assembler | KERNEL-SVC | W1–W2 | 04,09 | BLOCKED: deps 04,09 | `claude --model sonnet --effort high` | `kickoff/WP-10_kernel-service-skeleton-auth.md` |
| 11 | Circle adapter (relayer, webhooks, wallet gen) | KERNEL-SVC | W2 | 06,10 | BLOCKED: deps 06,10 | `claude --model opus --effort high` | `kickoff/WP-11_circle-adapter-relayer-webhooks.md` |
| 12 | Engagement service (sign flows, on-chain register, indexer) | KERNEL-SVC | W2 | 07,10 | BLOCKED: deps 07,10 | `claude --model sonnet --effort high` | `kickoff/WP-12_engagement-service-sign-flows.md` |
| 13 | Evidence collectors + hardened SSRF guard + sandbox fixtures mode | KERNEL-SVC | W2 | 10 | BLOCKED: deps 10 | `claude --model opus --effort high` | `kickoff/WP-13_evidence-collectors-hardened-ssrf.md` |
| 14 | Scheduler, TOCTOU re-eval (+ discount window), attestation signer, release | KERNEL-SVC | W2 | 05,11,12 | BLOCKED: deps 05,11,12 | `claude --model opus --effort xhigh` | `kickoff/WP-14_scheduler-toctou-re-eval.md` |
| 15 | Reconciler + breaker + guardian pause | KERNEL-SVC | W3 | 14 | BLOCKED: deps 14 | `claude --model sonnet --effort high` | `kickoff/WP-15_reconciler-breaker-guardian-pause.md` |
| 16 | Extractor + optional Advisory (AI) note validator + normalization/sanitization + eval harness (the templated explanation is built in WP-05) | AGENT | W1–W3 | 01 | WAIT: WP-01 v0 (Sonnet queue) | `claude --model sonnet --effort high` | `kickoff/WP-16_extractor-optional-advisory-ai.md` |
| 17 | Web shell, wallet sign-in, design system (+ CSP, build profiles, lint bans) | WEB | W1 | 00,01 | HOLD: Kevin's template; then safety components (a)(b)(c) | `claude --model sonnet --effort medium` | `kickoff/WP-17_web-shell-wallet-sign.md` |
| 18 | Web: engagements + payee signing | WEB | W2–W3 | 12,17 | BLOCKED: deps 12,17 | `claude --model sonnet --effort medium` | `kickoff/WP-18_web-engagements-payee-signing.md` |
| 19 | Web: intents, decision detail, approvals (WYSIWYS) | WEB | W3 | 10,16,17 | BLOCKED: deps 10,16,17 · owns safety component (d) approval screen | `claude --model sonnet --effort high` | `kickoff/WP-19_web-intents-decision-detail.md` |
| 20 | Web: dashboard, `/pilot`, `/audit` verifier | WEB | W3–W4 | 02,17 | BLOCKED: deps 02,17 · owns safety component (e) receipt verifier | `claude --model sonnet --effort high` | `kickoff/WP-20_web-dashboard-pilot-audit.md` |
| 21 | Web: attack lab, blast radius, `/certificate`, `/judge` (5 cards) | WEB | W4–W5 | 23,25,34 | BLOCKED: deps 23,25,34 | `claude --model sonnet --effort medium` | `kickoff/WP-21_web-attack-lab-blast.md` |
| 22 | Attack fixtures + generators (ATK-01..24) | ATTACK | W1–W3 | 01 | WAIT: WP-01 v0 (Sonnet queue) | `claude --model sonnet --effort high` | `kickoff/WP-22_attack-fixtures-generators-atk.md` |
| 23 | Baseline B1 + harness + `packages/oracle` (oracle-v1) + oracle-based report | ATTACK | W2–W4 | 22,10 | BLOCKED: deps 22,10 | `claude --model sonnet --effort high` | `kickoff/WP-23_baseline-b1-harness-packages.md` |
| 24 | Honest corpus + eval metrics | ATTACK+AGENT | W3–W4 | 16,22 | BLOCKED: deps 16,22 | `claude --model sonnet --effort high` | `kickoff/WP-24_honest-corpus-eval-metrics.md` |
| 25 | Blast Radius closed form + Lite | BLAST | W3–W4 | 03,07 | BLOCKED: deps 03,07 | `claude --model sonnet --effort high` | `kickoff/WP-25_blast-radius-closed-form.md` |
| 26 | T3 sim, red-team loop, patch loop | BLAST | W4–W5 | 08,23,25 | BLOCKED: deps 08,23,25 · cut 7 applied (no LLM red-team loop) | `claude --model sonnet --effort high` | `kickoff/WP-26_t3-sim-red-team.md` |
| 27 | Pilot kit (terms, scripts, tracker) | DOCS | W0–W1 | none | READY: **Sonnet slot, now** | `claude --model sonnet --effort medium` | `kickoff/WP-27_pilot-kit-terms-scripts.md` |
| 28 | README, video script, judge copy, screenshots | DOCS | W5–W7 | all | BLOCKED: deps all | `claude --model sonnet --effort medium` | `kickoff/WP-28_readme-video-script-judge.md` |
| 29 | Independent verification ×3 | VERIFIER | W3,W5,W6 | varies | BLOCKED: deps varies | `claude --model opus --effort xhigh` | `kickoff/WP-29_independent-verification-3.md` |
| 30 | P1: payee ack, compliance, dispute draft, vendor memory (**frozen until G4**) | mixed | W5 | 14,16 | FROZEN until Gate G4 (DEC-018, cut 1) | `claude --model sonnet --effort high` | `kickoff/WP-30_p1-payee-ack-compliance.md` |
| 31 | P2: ERC-8183 evaluator, ERC-8004, EURC, Memo (**frozen until G4**) | mixed | W5+ | G2 | FROZEN until Gate G4 (DEC-018, cut 1) | `claude --model sonnet --effort high` | `kickoff/WP-31_p2-erc-8183-evaluator.md` |
| 32 | Challenge service: scenarios, oracle wiring (`packages/oracle`, WP-23), budget ledger, rate limits, boot guards, house attackers | KERNEL-SVC | W4–W5 | 14,23 | BLOCKED: deps 14,23 · cuts 2+3 applied (no house LLM loop; L1 launch) | `claude --model opus --effort high` | `kickoff/WP-32_challenge-service-scenarios-oracle.md` |
| 33 | Challenge web: `/challenge`, safe rendering (`<UntrustedText>`), scoreboard, `/security` | WEB | W4–W5 | 32,17 | BLOCKED: deps 32,17 · cut 3 applied (L1: one-click + benign) | `claude --model sonnet --effort high` | `kickoff/WP-33_challenge-web-challenge-safe.md` |
| 34 | Loss Bound Certificate: build/verify/CLI/API (+ UI page via WP-21) | BLAST | W4 | 25,07 | BLOCKED: deps 25,07 | `claude --model opus --effort high` | `kickoff/WP-34_loss-bound-certificate-build.md` |
| 35 | Treasury Planner: planner prompts, `planId` selection validation + fallback, hindsight eval, simulated corpus (consumes `feasiblePlans`/evaluator from WP-05) | AGENT | W3–W4 | 05,16 | BLOCKED: deps 05,16 | `claude --model sonnet --effort high` | `kickoff/WP-35_treasury-planner-planner-prompts.md` |
| 36 | Baselines B0/B2, hold-out set (ATTACK-ADV), statistics, `applicability.json` | ATTACK | W3–W4 | 23 | BLOCKED: deps 23 · cut 5 applied (H1 dropped, H2 kept) | `claude --model sonnet --effort high` | `kickoff/WP-36_baselines-b0-b2-hold.md` |
| 37 | SEC hardening + `packages/sec-suite` (SEC-01..14, XSS/SSRF corpora, `claims:lint`, mutation tests) | SEC | W3–W5 | 10,13,19 | BLOCKED: deps 10,13,19 | `claude --model opus --effort high` | `kickoff/WP-37_sec-hardening-packages-sec.md` |
| 38 | Replay mode: `build-replay`, `verify-bundle`, static fallback for judge pages | WEB | W5–W6 | 23,34,35 | BLOCKED: deps 23,34,35 | `claude --model sonnet --effort medium` | `kickoff/WP-38_replay-mode-build-replay.md` |
| 39 | Routing config: `.claude/agents/*`, `.claude/settings.json`, kickoff MODEL/EFFORT lines | ORCH | W0 | none | DONE (lean routing regenerated; `claude:check` green) | `claude --model sonnet --effort high` | `kickoff/WP-39_routing-config-claude-agents.md` |
