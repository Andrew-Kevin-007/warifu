ROLE: ORCH   TASK: v1 → v2 reconcile (one-off; run ONCE, in your existing Claude Code session or a fresh one in the repo root)
MODEL: opus   EFFORT LEVEL: high   (docs/17: ORCH)
LAUNCH: claude --model opus --effort high
OPTIONAL: prefix ONLY step 8 with `ultracode:` (typed prompt; it burns usage). Do not run the whole reconcile in ultracode.

CONTEXT
This repo was bootstrapped from the v1 pack (docs 00–13, scaffold, kickoff prompts). The v2 pack is unpacked at `../symbolon-v2-pack/` (it is a complete scaffold tree: docs 00–17 + CHANGES_V2.md, AGENTS.md, .claude/, kickoff/, scripts/, lint and CI configs, test/, packages/terms, packages/sec-suite). Paths below are relative to that folder. v2 keeps the v1 architecture (LLM proposes → deterministic kernel decides → on-chain vault enforces → signed receipts). It adds a spine, "Don't trust the agent. Bound it. Prove it. Invite attack.", and: Loss Bound Certificate, public "Break the Treasurer" testnet challenge, Treasury Planner, 24 attacks vs 3 baselines + hold-out, replay mode, SEC hardening, model/effort routing. Read `docs/CHANGES_V2.md` first (5 minutes). DO NOT rewrite working code; extend it.

GUARDRAILS (non-negotiable)
- No secrets, ever. Do not read `.env*`. Do not paste or print keys.
- Work on branch `chore/v2-reconcile`; small commits; no force-push; no deleting files without listing them first.
- Never relax an existing lint, boundary or test rule to get green (a change needs a `docs/QUESTIONS.md` entry).
- Migrations are append-only: add `0002_v2.sql`, never edit `0001`.
- Do not touch deployed contracts. If a vault is already deployed, record that it needs a redeploy for certificate support (docs/16 §2.4) and stop there.
- Do not start WP-30/31 (frozen until Gate G4). Do not use `max` effort.

STEPS
0. INVENTORY. `git status`, `git log --oneline | head -30`, list packages/apps/services that exist, run `make verify` and record the baseline (pass/fail per stage) in `docs/V2_STATUS.md`. Create the branch.
1. DOCS. Copy `../symbolon-v2-pack/docs/00..17_*.md` and `CHANGES_V2.md` over `docs/`. KEEP (append only, never overwrite): `docs/CHANGELOG_SWARM.md`, `docs/QUESTIONS.md`, `docs/VERIFIER_FINDINGS.md`, `docs/VERIFY_LOG.md`. Copy `AGENTS.md`; ensure `CLAUDE.md` contains exactly `@AGENTS.md`. If you had edited any v1 doc by hand, diff first and carry the edit forward into the v2 text instead of losing it.
2. CLAUDE CODE CONFIG. Copy `.claude/` and `scripts/gen-kickoff.py`, `scripts/check-claude-config.mjs`. Run `python3 scripts/gen-kickoff.py` (regenerates `kickoff/WP-*.md`, `kickoff/INDEX.md` and `.claude/agents/*.md` with MODEL/EFFORT/LAUNCH lines), then `node scripts/check-claude-config.mjs` (must print OK). Add `.claude/settings.local.json` to `.gitignore`.
3. TOOLING. Bring over these files, merging by hand wherever your repo diverged (keep the stricter rule): `eslint.config.js` (HTML-sink bans for apps/web, terms purity, no-wallet-in-challenge), `.dependency-cruiser.cjs` (terms-is-pure, services-do-not-import-extractor with the `services/kernel/src/challenge/**` exception, challenge-and-replay-never-import-wallet, sec-suite-is-test-only, oracle-is-pure, oracle-is-independent), `scripts/web-env-check.mjs` (adds a NEXT_PUBLIC_* secret-name guard), `scripts/claims-lint.mjs`, `scripts/check-claude-config.mjs`, `test/boundaries.test.ts` and `test/v2-guards.test.ts`, `packages/terms/`, `packages/oracle/` and `packages/sec-suite/` (add only if absent), the v2 scripts and targets in `package.json` and `Makefile` (`claude:check`, `claims:lint`, `sec:local`, `sec:sandbox` (stub), `kickoff`; `verify` now includes `claude:check` and `claims:lint`), `.github/workflows/ci.yml` (the v1 scaffold's `contracts` job had a YAML syntax error; take the fixed file), `contracts/foundry.toml` (`bytecode_hash = "none"`, `cbor_metadata = false`), `SECURITY.md` (draft), and the `.gitignore` line `.claude/settings.local.json`. Run `pnpm install` then `make verify`; fix only what the merge broke.
4. MIGRATE (only for things that already exist in the repo; otherwise skip and let the WP do it):
   a. Attack suite: rename target `naive` → `b1`, `arc-escrow` → `b0`; add `b2`; 20 → 24 attacks (fixtures for ATK-21..24 are WP-22 scope).
   b. DB: add `supabase/migrations/0002_v2.sql` exactly as in docs/05 §3b; update any code reading `is_internal` to use `tenants.kind`.
   c. Schemas: if `schemas v1.0` is NOT yet tagged, add the v2 shapes now (list in docs/CHANGES_V2.md §6). If it IS tagged: write an RFC in `docs/QUESTIONS.md` and plan `v1.1`.
   d. Receipts/approval: plan `packages/receipts/src/approval/` (buildApprovalTypedData, renderModel) per docs/10 WP-02; `formatBaseUnits` in schemas.
   e. Contracts (only if source exists): list the diff needed for docs/16 §2.4 (engagementIds/count/At, RING_SIZE, configHash, ConfigChanged, no limit setters, foundry.toml) **and the `release(a, kernelSig, OwnerApprovalRef, ownerApprovalSig)` signature change (docs/06 A.4; breaking vs v1)** as a task for the CONTRACTS lane. Do not edit deployed addresses.
   f. Web: if `apps/web` exists, plan the `src/wallet/**` split and the `challenge` build profile (WP-17 v2 scope).
5. STATUS TABLE. In `docs/V2_STATUS.md`, one row per WP-00..39: `done | partial | not started | blocked`, what v2 adds to the finished ones, and the launch line from `kickoff/INDEX.md`. Mark WP-30/31 FROZEN.
6. GATES. Re-base the dates in `docs/12_RISKS_AND_GATES.md` only if they are already stale relative to today; note that the real deadline is still unconfirmed (Discord).
7. KICKOFF. Confirm every `kickoff/WP-nn_*.md` begins with `MODEL: … EFFORT LEVEL: …` and `LAUNCH: …`.
8. CONSISTENCY AUDIT (may be run with `ultracode:`). For every INV-n, K-xx, ATK-xx, SEC-xx, RT-xx, R-nn, WP-nn and reason code referenced anywhere in `docs/` and `AGENTS.md`: (a) is it defined once? (b) does it have a WP that builds it and a test that proves it? List gaps and contradictions in `docs/QUESTIONS.md` with file:line. Do not "fix" specs silently.
9. REPORT to Kevin, ≤ 20 lines: baseline vs now (`make verify`), what changed, what is blocked, decisions needed from Kevin, and the next 3–5 WPs to launch with their LAUNCH lines. Open a PR `chore: v2 reconcile`.

DONE WHEN: `make verify` is green; `node scripts/check-claude-config.mjs` prints OK; `docs/V2_STATUS.md` exists; the PR is open; Kevin has the report.
