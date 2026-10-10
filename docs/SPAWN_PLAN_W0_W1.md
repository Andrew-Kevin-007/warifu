# SPAWN PLAN — Wave 0 / Wave 1, LEAN MODE (ORCH, 2026-10-10 22:00 IST)

Sources: `kickoff/ORCHESTRATOR.md` §2–§3, `docs/10` §2–§4, `docs/12` §1, `docs/17` §4 (lean). Board: `docs/V2_STATUS.md`. Decisions: `docs/QUESTIONS.md` ("FINAL ANSWERS").
**Rules:** Claude Pro. **Max 2 terminals, at most 1 on Opus.** Never `max`. No ultracode unless Kevin types it. **Git Bash is the only shell.** One WP per session, short sessions, commit small and often, reference file paths instead of pasting docs. If a limit hits mid-WP: commit WIP to the branch, update `docs/V2_STATUS.md`, stop (no retry loops).

## 0. Before the first spawn (once, Git Bash)

```bash
gh pr merge 1 --repo Andrew-Kevin-007/symbolon --squash   # Windows test fix + lean routing + this plan; CI has not run yet (see QUESTIONS)
cd /d/symbolon/symbolon-v2-pack && git pull --ff-only     # local main must contain PR #1: spawn-worktree.sh branches from local main
```
Local gate in every lane: `pnpm verify` (identical to `make verify`; there is no `make` on this machine).

## 1. Spawn one lane (Git Bash, from the repo root)

```bash
scripts/spawn-worktree.sh 01                 # -> ../symbolon-wt/wp-01 on branch wp-01/schemas-jcs-eip-712
cd ../symbolon-wt/wp-01 && pnpm install
claude --model opus --effort xhigh           # = the LAUNCH line at the top of the kickoff file
# first prompt: "Read kickoff/WP-01_schemas-jcs-eip-712.md and do it." (reference the path; don't paste)
```

## 2. Tonight

| Slot | Now | Then (in order) |
|---|---|---|
| **Terminal 1: Opus** | **WP-01 SCHEMAS** · `claude --model opus --effort xhigh` · `kickoff/WP-01_schemas-jcs-eip-712.md` · `scripts/spawn-worktree.sh 01`. **v0 merges tonight** (= Zod shapes for `docs/05` §2 + v2 shapes, `jcs()`, reason codes, `Untrusted<T>`, `formatBaseUnits`, `pnpm verify` green; vectors may be partial). Freeze tag `schemas-v1.0` at **G1, Sun 09:00** | WP-07 (drafts Solidity until Arc Foundry exists) → WP-03 → WP-04 → WP-02 → WP-05 → WP-11 / WP-13 (opus high) → WP-14 |
| **Terminal 2: Sonnet** | **WP-27 DOCS pilot kit** · `claude --model sonnet --effort medium` · `kickoff/WP-27_pilot-kit-terms-scripts.md` · `scripts/spawn-worktree.sh 27` (no deps) | after WP-01 v0: WP-22 → WP-16 → WP-09 (after the Postgres OK) · WP-17 as soon as Kevin's template is in `apps/web` |

ORCH runs on `claude --model sonnet --effort high` and only at merge points / gates. While it runs it takes the Sonnet slot.
**WP-01's second vector implementation:** an `ethers` script (pinned, logged) or a Foundry test. Stock Foundry 1.5.1 already sits in `D:\tools\foundry\bin` (not on PATH, not Arc Foundry). Using it as a stopgap is Kevin's call (QUESTIONS).

## 3. G2 capacity warning (decision for Kevin)

By the `docs/10` §4 estimates, the Opus-only queue to G2 is WP-01 5 + 07 9 + 03 2 + 04 8 + 02 3 + 05 8 + 11 6 + 13 6 + 14 6 ≈ **53 agent-hours on one Opus slot**, with **≈ 26 h** left until G2 (Sun 23:59). G2 cannot hold with one Opus terminal unless something changes. Options are in QUESTIONS ("G2 capacity"). ORCH does not cut or re-route without Kevin.

## 4. Merge order (W0/W1)

`schemas → contracts / kernel-core (+terms, receipts/approval) → chain → kernel-service → web → challenge`. Squash-merge, rebase on `main` first, `pnpm verify` green (CI too once it runs).
1. PR #1 `wp-00/orch-setup` · 2. WP-27 · 3. **WP-01 v0** · 4. WP-07 (digest test = WP-01 vectors) · 5. WP-03 → WP-04 (strictly after 03) → WP-02 · 6. WP-22, WP-16, WP-09 · 7. WP-17 inside Kevin's template · 8. **G1 Sun 09:00: tag `schemas-v1.0`**; after that, schema changes need an RFC + `v1.1`.

## 5. Kevin-only, ordered by what blocks tonight

| # | Action | Blocks |
|---|---|---|
| KEVIN-1 | ~~Confirm deadline~~ **done:** Sep 27 – Oct 17 (official page) | — |
| KEVIN-2 | Merge PR #1 and pull `main` (§0). Check why GitHub Actions has not run (Actions tab / billing) | every lane's branch point; CI-gated merges |
| KEVIN-3 | Answer "G2 capacity" (QUESTIONS) | the Opus queue order |
| KEVIN-4 | OK (or not) for the install proposals in QUESTIONS (gitleaks, portable Postgres) and the one-time pnpm/npm config | WP-09 RLS tests; local secrets scan |
| KEVIN-5 | Install Arc Foundry into `D:\tools\arc` (you, not an agent); then ORCH runs the leak-check | WP-07 tests, local `arc-anvil` |
| KEVIN-6 | Branch protection on `main` (PR + CI, squash only) once CI has run once | — |
| KEVIN-7 | `/plugin marketplace add circlefin/skills`, `/plugin install circle-skills@circle`, Circle MCP (`https://api.circle.com/v1/codegen/mcp`) | WP-06/07/11 Arc/Circle facts (§0.5) |
| KEVIN-8 | `arc-canteen` baselines (`update product`, `update traction`); Circle testnet key + entity secret (in `.env.local` only); Supabase/Vercel/Railway/Anthropic | G0 items; WP-11 by Sun 12:00 |
| KEVIN-9 | Sandbox accounts (`docs/00` §6b) | WP-32 (W4), by Mon |
| KEVIN-10 | Outreach ≥ 3 h/day | traction (G3/G4) |
