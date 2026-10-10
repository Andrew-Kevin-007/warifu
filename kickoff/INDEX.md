# Kickoff prompts (generated)

Generated from `docs/10_SWARM_PLAN.md` and the routing block in `docs/17_MODEL_AND_EFFORT_ROUTING.md` by `scripts/gen-kickoff.py`. Paste one file per agent into a session launched with the `LAUNCH:` line printed at its top. See `ORCHESTRATOR.md` for order and `V2_RECONCILE.md` if you already have a v1 repo.

| WP | Title | Role | Model/Effort | Wave | P | Deps | Prompt |
|---|---|---|---|---|---|---|---|
| 00 | Repo bootstrap, CI, lint rules, Makefile | ORCH | opus/high | W0 | P0 | none | `WP-00_repo-bootstrap-ci-lint.md` |
| 01 | Schemas + JCS + EIP-712 vectors (+ v2 shapes) | SCHEMAS | opus/xhigh | W0–W1 | P0 | 00 | `WP-01_schemas-jcs-eip-712.md` |
| 02 | Receipts (JCS/hash/sign/verify CLI) | KERNEL-CORE | opus/xhigh | W1 | P0 | 01 | `WP-02_receipts-jcs-hash-sign.md` |
| 03 | Policy loader/hash/consistency (+ treasury/escalation keys) | KERNEL-CORE | opus/xhigh | W1 | P0 | 01 | `WP-03_policy-loader-hash-consistency.md` |
| 04 | Kernel checks K-01..K-08 + algebra + `packages/terms` | KERNEL-CORE | opus/xhigh | W1 | P0 | 01,03 | `WP-04_kernel-checks-k-01.md` |
| 05 | Kernel checks K-09..K-14, K-16 logic, patterns (+ terms binding, feasible plans, escalation budget, profiles) | KERNEL-CORE | opus/xhigh | W2 | P0 | 04 | `WP-05_kernel-checks-k-09.md` |
| 06 | Chain package (Money, ABIs, decoders) | CHAIN | sonnet/high | W1–W2 | P0 | 01,07 | `WP-06_chain-package-money-abis.md` |
| 07 | `SymbolonVault` + tests + deploy (+ certificate surface, reproducible build) | CONTRACTS | opus/xhigh | W1 | P0 | 01 | `WP-07_symbolonvault-tests-deploy-certificate.md` |
| 08 | Vault hardening: invariants, fuzz, hourlyCap, ERC-1271 | CONTRACTS | opus/xhigh | W3–W5 | P0/P1 | 07 | `WP-08_vault-hardening-invariants-fuzz.md` |
| 09 | DB migrations + RLS + views (+ `0002_v2`: kinds, budget, challenge, certificates, replay) | KERNEL-SVC | sonnet/high | W1 | P0 | 01 | `WP-09_db-migrations-rls-views.md` |
| 10 | Kernel service skeleton, auth, context assembler | KERNEL-SVC | sonnet/high | W1–W2 | P0 | 04,09 | `WP-10_kernel-service-skeleton-auth.md` |
| 11 | Circle adapter (relayer, webhooks, wallet gen) | KERNEL-SVC | opus/xhigh | W2 | P0 | 06,10 | `WP-11_circle-adapter-relayer-webhooks.md` |
| 12 | Engagement service (sign flows, on-chain register, indexer) | KERNEL-SVC | opus/high | W2 | P0 | 07,10 | `WP-12_engagement-service-sign-flows.md` |
| 13 | Evidence collectors + hardened SSRF guard + sandbox fixtures mode | KERNEL-SVC | opus/xhigh | W2 | P0 | 10 | `WP-13_evidence-collectors-hardened-ssrf.md` |
| 14 | Scheduler, TOCTOU re-eval (+ discount window), attestation signer, release | KERNEL-SVC | opus/xhigh | W2 | P0 | 05,11,12 | `WP-14_scheduler-toctou-re-eval.md` |
| 15 | Reconciler + breaker + guardian pause | KERNEL-SVC | opus/high | W3 | P0 | 14 | `WP-15_reconciler-breaker-guardian-pause.md` |
| 16 | Extractor + optional Advisory (AI) note validator + normalization/sanitization + eval harness (the templated explanation is built in WP-05) | AGENT | sonnet/high | W1–W3 | P0 | 01 | `WP-16_extractor-optional-advisory-ai.md` |
| 17 | Web shell, wallet sign-in, design system (+ CSP, build profiles, lint bans) | WEB | sonnet/medium | W1 | P0 | 00,01 | `WP-17_web-shell-wallet-sign.md` |
| 18 | Web: engagements + payee signing | WEB | sonnet/medium | W2–W3 | P0 | 12,17 | `WP-18_web-engagements-payee-signing.md` |
| 19 | Web: intents, decision detail, approvals (WYSIWYS) | WEB | sonnet/high | W3 | P0 | 10,16,17 | `WP-19_web-intents-decision-detail.md` |
| 20 | Web: dashboard, `/pilot`, `/audit` verifier | WEB | sonnet/high | W3–W4 | P0 | 02,17 | `WP-20_web-dashboard-pilot-audit.md` |
| 21 | Web: attack lab, blast radius, `/certificate`, `/judge` (5 cards) | WEB | sonnet/medium | W4–W5 | P0 | 23,25,34 | `WP-21_web-attack-lab-blast.md` |
| 22 | Attack fixtures + generators (ATK-01..24) | ATTACK | sonnet/high | W1–W3 | P0 | 01 | `WP-22_attack-fixtures-generators-atk.md` |
| 23 | Baseline B1 + harness + `packages/oracle` (oracle-v1) + oracle-based report | ATTACK | sonnet/high | W2–W4 | P0 | 22,10 | `WP-23_baseline-b1-harness-packages.md` |
| 24 | Honest corpus + eval metrics | ATTACK+AGENT | sonnet/high | W3–W4 | P0 | 16,22 | `WP-24_honest-corpus-eval-metrics.md` |
| 25 | Blast Radius closed form + Lite | BLAST | opus/high | W3–W4 | P0 | 03,07 | `WP-25_blast-radius-closed-form.md` |
| 26 | T3 sim, red-team loop, patch loop | BLAST | opus/high | W4–W5 | P0/P1 | 08,23,25 | `WP-26_t3-sim-red-team.md` |
| 27 | Pilot kit (terms, scripts, tracker) | DOCS | sonnet/medium | W0–W1 | P0 | none | `WP-27_pilot-kit-terms-scripts.md` |
| 28 | README, video script, judge copy, screenshots | DOCS | sonnet/medium | W5–W7 | P0 | all | `WP-28_readme-video-script-judge.md` |
| 29 | Independent verification ×3 | VERIFIER | opus/xhigh | W3,W5,W6 | P0 | varies | `WP-29_independent-verification-3.md` |
| 30 | P1: payee ack, compliance, dispute draft, vendor memory (**frozen until G4**) | mixed | opus/high | W5 | P1 | 14,16 | `WP-30_p1-payee-ack-compliance.md` |
| 31 | P2: ERC-8183 evaluator, ERC-8004, EURC, Memo (**frozen until G4**) | mixed | opus/high | W5+ | P2 | G2 | `WP-31_p2-erc-8183-evaluator.md` |
| 32 | Challenge service: scenarios, oracle wiring (`packages/oracle`, WP-23), budget ledger, rate limits, boot guards, house attackers | KERNEL-SVC | opus/xhigh | W4–W5 | P0 | 14,23 | `WP-32_challenge-service-scenarios-oracle.md` |
| 33 | Challenge web: `/challenge`, safe rendering (`<UntrustedText>`), scoreboard, `/security` | WEB | sonnet/high | W4–W5 | P0 | 32,17 | `WP-33_challenge-web-challenge-safe.md` |
| 34 | Loss Bound Certificate: build/verify/CLI/API (+ UI page via WP-21) | BLAST | opus/high | W4 | P0 | 25,07 | `WP-34_loss-bound-certificate-build.md` |
| 35 | Treasury Planner: planner prompts, `planId` selection validation + fallback, hindsight eval, simulated corpus (consumes `feasiblePlans`/evaluator from WP-05) | AGENT | sonnet/high | W3–W4 | P0 | 05,16 | `WP-35_treasury-planner-planner-prompts.md` |
| 36 | Baselines B0/B2, hold-out set (ATTACK-ADV), statistics, `applicability.json` | ATTACK | opus/high | W3–W4 | P0 | 23 | `WP-36_baselines-b0-b2-hold.md` |
| 37 | SEC hardening + `packages/sec-suite` (SEC-01..14, XSS/SSRF corpora, `claims:lint`, mutation tests) | SEC | opus/xhigh | W3–W5 | P0 | 10,13,19 | `WP-37_sec-hardening-packages-sec.md` |
| 38 | Replay mode: `build-replay`, `verify-bundle`, static fallback for judge pages | WEB | sonnet/medium | W5–W6 | P0 | 23,34,35 | `WP-38_replay-mode-build-replay.md` |
| 39 | Routing config: `.claude/agents/*`, `.claude/settings.json`, kickoff MODEL/EFFORT lines | ORCH | opus/high | W0 | P0 | none | `WP-39_routing-config-claude-agents.md` |
