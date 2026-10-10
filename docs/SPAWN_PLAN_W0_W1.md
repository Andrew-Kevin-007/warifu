# SPAWN PLAN — Wave 0 / Wave 1 (ORCH, 2026-10-10 21:00 IST)

Sources: `kickoff/ORCHESTRATOR.md` §2–§3, `docs/10` §2–§4, `docs/12` §1, `docs/17` §4. Board: `docs/V2_STATUS.md`. Open items: `docs/QUESTIONS.md`.
W1 runs on mocks and local tooling. Nothing below waits on Kevin's accounts, **except** that local `arc-anvil`/`arc-forge` needs the Arc Foundry install (KEVIN-2). Until then WP-07 can write code but cannot run its tests.

## 0. Before the first spawn (once)

1. Merge `wp-00/orch-setup` into `main` first (Windows fix for `test/v2-guards.test.ts`, this plan, the status board). `spawn-worktree.sh` branches from local `main`, so every lane then starts from a `main` where the gate is green on Windows.
2. This machine has no `make`. **`pnpm verify` runs exactly the `make verify` stages** (lint, typecheck, test, web-env, claude:check, claims:lint). Lanes use `pnpm verify` as their local gate. Until the GitHub remote and CI exist, a green `pnpm verify` in the lane's worktree is the merge gate.
3. Line endings: this repo's local git config has `core.autocrlf=false` and `core.eol=lf`. All worktrees share it, so scripts check out with LF.

## 1. How to spawn one lane (PowerShell, from `D:\symbolon\symbolon-v2-pack`)

```powershell
& "C:\Program Files\Git\bin\bash.exe" scripts/spawn-worktree.sh 01   # -> ..\symbolon-wt\wp-01 on branch wp-01/schemas-jcs-eip-712
cd ..\symbolon-wt\wp-01; pnpm install
claude --model opus --effort xhigh         # the LAUNCH line printed at the top of the kickoff file
# then paste the whole kickoff file (kickoff/WP-01_schemas-jcs-eip-712.md) as the first prompt
```
**Use Git Bash by full path, not a bare `bash`.** On this machine PowerShell's `bash` resolves to the WSL alias in `WindowsApps`, and a WSL `git worktree add` writes Linux paths into `.git/worktrees`. Below, `spawn 01` is short for the first line above.
One terminal per worktree. Use the LAUNCH line exactly. Never `max`, never `/effort ultracode`, never `CLAUDE_CODE_EFFORT_LEVEL`.

## 2. Start now (3 lanes, spawn together; WP-17 held for Kevin's template)

| WP | Role | LAUNCH | Kickoff file | Worktree | Can do before WP-01 v0 | Watch |
|---|---|---|---|---|---|---|
| **01** | SCHEMAS | `claude --model opus --effort xhigh` | `kickoff/WP-01_schemas-jcs-eip-712.md` | `spawn 01` | everything; it *is* the bottleneck | **v0 merged ≤ 3 h after start.** Second implementation of the vectors: no Foundry here, so use an ethers script (pin the dep, log it in CHANGELOG_SWARM) or WP-07's Foundry test after KEVIN-2 |
| **07** | CONTRACTS | `claude --model opus --effort xhigh` | `kickoff/WP-07_symbolonvault-tests-deploy-certificate.md` | `spawn 07` | `SymbolonVault.sol` per `docs/06` Part A, tests written, `foundry.toml` keys | cannot run `arc-forge test` until KEVIN-2. EIP-712 digest test must equal WP-01 vectors before merge. Adds the Arc Foundry install step to CI (`ORCHESTRATOR` §5) |
| **17** | WEB | `claude --model sonnet --effort medium` | `kickoff/WP-17_web-shell-wallet-sign.md` | `spawn 17` | **HELD.** Kevin supplies the UI from a cloned template. Once it sits in `apps/web`, this lane adds only the non-visual layer (CSP, build profiles, `<UntrustedText>`, runtime web-env test), pending the "Frontend split" answer in QUESTIONS | do not spawn until the template is in `apps/web` |
| **27** | DOCS | `claude --model sonnet --effort medium` | `kickoff/WP-27_pilot-kit-terms-scripts.md` | `spawn 27` | all of it (no deps) | docs-only; any number it writes must come from `claims.ts` later (INV-18) |

## 3. Spawn the moment WP-01 v0 merges (6 lanes, together)

**"v0" means:** the WP-01 PR is merged on `main` with the Zod shapes for `docs/05` §2 plus the v2 shapes, `jcs()`, reason codes (incl. the 6 new ones), `Untrusted<T>`, `formatBaseUnits`, and `pnpm verify` green. Vectors may still be partial. It is **not** the freeze. The freeze is the tag `schemas-v1.0` at G1.

| WP | Role | LAUNCH | Kickoff file | Worktree | Note |
|---|---|---|---|---|---|
| **02** | KERNEL-CORE | `claude --model opus --effort xhigh` | `kickoff/WP-02_receipts-jcs-hash-sign.md` | `spawn 02` | `packages/receipts` incl. `src/approval/` (`buildApprovalTypedData`, `renderModel`) |
| **03** | KERNEL-CORE | `claude --model opus --effort xhigh` | `kickoff/WP-03_policy-loader-hash-consistency.md` | `spawn 03` | `packages/policy`; WP-04 depends on it |
| **04** | KERNEL-CORE | `claude --model opus --effort xhigh` | `kickoff/WP-04_kernel-checks-k-01.md` | `spawn 04` | deps are 01 **and 03**: spawn with 03, code against the schemas `Policy` type, **merge after WP-03**. 100 % branch coverage + property tests on 1,000 runs |
| **09** | KERNEL-SVC | `claude --model sonnet --effort high` | `kickoff/WP-09_db-migrations-rls-views.md` | `spawn 09` | can write `0001`/`0002_v2.sql` now. RLS acceptance needs a real local Postgres (KEVIN-5). No pg-mem substitute, and no "passes" claim without it |
| **16** | AGENT | `claude --model sonnet --effort high` | `kickoff/WP-16_extractor-optional-advisory-ai.md` | `spawn 16` | LLM calls mocked or recorded in W1. No Anthropic key needed yet. Budget wrapper per INV-21 |
| **22** | ATTACK | `claude --model sonnet --effort high` | `kickoff/WP-22_attack-fixtures-generators-atk.md` | `spawn 22` | fixtures + seeded generators. Never reads or writes `holdout/` fixtures |

**Load check:** at peak this is up to 5 Opus-xhigh lanes (01/02/03/04/07) plus 4 Sonnet lanes. Check usage against the burn guard (`docs/17` §6) at the W1→W2 boundary.

**Next after these (W1→W2), for reference:** WP-06 when 07 merges · WP-10 when 04 + 09 merge · WP-25 when 03 + 07 merge · WP-05 when 04 merges.

## 4. Merge order (W0/W1)

Rule (`ORCHESTRATOR` §3): `schemas → contracts / kernel-core (+terms, receipts/approval) → chain → kernel-service → web → challenge`. Squash-merge only. Rebase on `main` before merging. `pnpm verify` green (CI too once the remote exists).

1. `wp-00/orch-setup` (ORCH: Windows test fix + these docs)
2. WP-27 pilot kit (docs-only; can go any time, conflicts with nothing)
3. **WP-01 v0** → then spawn §3; WP-07 and WP-17 rebase onto it
4. WP-07 vault (digest test = WP-01 vectors)
5. WP-03 policy → WP-02 receipts → WP-04 checks + terms (04 strictly after 03)
6. WP-09 DB migrations
7. WP-16 extractor, WP-22 attack fixtures
8. Kevin's template lands in `apps/web`; then WP-17 adds the safety layer inside it (web merges after core; blocks nobody in W1)
9. **G1: tag `schemas-v1.0`** on the merge commit once 02/03/04/07 compile against it. After that, schema changes need an RFC in `QUESTIONS.md` + `v1.1`.

## 5. What only Kevin can do, ordered by what blocks the first wave

| # | Action | Blocks | When |
|---|---|---|---|
| KEVIN-1 | ~~Confirm the deadline~~ **DONE 2026-10-10:** the official Tameion page says Sep 27 – Oct 17 (Kevin's screenshot). Emergency scope is off | n/a | done |
| KEVIN-2 | **Install Arc Foundry** (`arc-forge`, `arc-cast`, `arc-anvil`) per `https://docs.arc.io/arc/tutorials/install-arc-foundry.md`. Agents may not run `curl \| sh` (§0.10). On Windows, check whether it needs WSL (VERIFY) | WP-07 tests, local anvil, WP-01's Foundry cross-check | tonight |
| KEVIN-3 | **GitHub:** ~~make private~~ (done 2026-10-10) · ORCH pushes `main` + `wp-00/orch-setup` · **you turn on branch protection** (PR + CI required, squash only) | CI-gated merges (lanes still work locally) | tonight |
| KEVIN-4 | In Claude Code: `/plugin marketplace add circlefin/skills`, `/plugin install circle-skills@circle`, and add the Circle MCP `https://api.circle.com/v1/codegen/mcp` | WP-07 (Arc facts), WP-06/11 later (§0.5: no invented APIs) | tonight |
| KEVIN-5 | Docker Desktop + Supabase CLI (or a local Postgres 15+) | WP-09 RLS acceptance (real Postgres required) | before WP-09 merges |
| KEVIN-6 | `arc-canteen login` → `wallet` → `update product` + `update traction` baseline entries (`docs/00` §6; CLI already installed) | G0 criteria, not code | today |
| KEVIN-7 | Confirm the LICENSE holder; fill the contact in `SECURITY.md` | going public | before any public push |
| KEVIN-8 | Circle Console: testnet API key + entity secret; faucet. Keys go only into `.env.local`, never into a chat | WP-11 (W2) | by Sun 12:00 (G0 fail action) |
| KEVIN-9 | Supabase cloud project, Vercel, Railway, Anthropic key, Loom | W2+ deploys; WP-16 live runs | by Sun 12:00 |
| KEVIN-10 | Sandbox accounts (`docs/00` §6b): 2nd Supabase project, 2nd Vercel project/domain, 2nd service, spend-capped Anthropic key, throwaway testnet keys | WP-32 challenge (W4) | by Mon |
| KEVIN-11 | Outreach: ≥ 10 DMs, ≥ 2 S1 payees (G0); ≥ 3 h/day after that (RT-33) | traction (G3/G4) | daily |
| KEVIN-12 | Optional: `gitleaks` locally (CI runs it anyway); `choco install make` (or keep using `pnpm verify`); a `python3` alias for `make kickoff` | nothing in W1 | any time |
