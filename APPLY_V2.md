# APPLY_V2 — how to use this pack (2 minutes)

This folder is a **complete, working scaffold** (`make verify` is green) plus the v2 doc set and Claude Code agent config.

## A. Fresh repo
```bash
cd symbolon-v2-pack
git init -b main && git add -A && git commit -m "chore: v2 scaffold"
corepack enable && pnpm install && make verify
```
Then follow `kickoff/ORCHESTRATOR.md`. Every `kickoff/WP-nn_*.md` starts with the exact `claude --model … --effort …` line to launch it with.

## B. You already fed v1 to Claude Code / already have a repo
1. Unzip this folder **next to** your repo as `../symbolon-v2-pack/`.
2. In your repo, run `claude --model opus --effort high` and paste the contents of `kickoff/V2_RECONCILE.md`.
3. Read its 20-line report; launch the WPs it recommends using the `LAUNCH:` lines.

## Which Claude for what (short; full rules in `docs/17_MODEL_AND_EFFORT_ROUTING.md`)
| Work | Launch |
|---|---|
| Money- and trust-critical: schemas, kernel-core, contracts, SEC, VERIFIER, Circle adapter, evidence/SSRF, release path, challenge service | `claude --model opus --effort xhigh` |
| Orchestrator, Blast Radius/certificate, hold-out adversary, reconciler, engagement flows | `claude --model opus --effort high` |
| Scoped, well-specified services: chain, kernel service, agent/planner, attack fixtures, approval + audit UIs | `claude --model sonnet --effort high` |
| Everything UI/docs-shaped | `claude --model sonnet --effort medium` |

Not `max`, ever. `ultracode:` only for the named verification passes (WP-29 ×3, WP-37 final sweep, consistency audits). Do not set `CLAUDE_CODE_EFFORT_LEVEL` globally.

## Read first
`docs/CHANGES_V2.md` → `docs/14_RED_TEAM_V2.md` §0 → `docs/00_START_HERE.md`.
