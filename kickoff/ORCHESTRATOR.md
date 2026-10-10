# ORCHESTRATOR run-sheet (v2) — you, or your ORCH agent

Clock (IST): it is **Sat Oct 10**. Gates are in `docs/12` (G0 Sat 20:00 → G5 feature freeze **Thu Oct 15 18:00** → G6 deploy freeze **Sat Oct 17 22:00**). Official deadline is **Sat Oct 17 11:59 PM ET = Sun Oct 18 09:29 IST**; the Luma page says Oct 10, so **ask in Discord which is real** (`docs/00`). Judging is async: public repo + video < 3 min + live link + traction answers.

**The spine (say it exactly like this, everywhere):** *Don't trust the agent. Bound it. Prove it. Invite attack.*

## 0. Before any agent runs (≈ 30 min, Kevin)
1. **Existing v1 repo?** Run `kickoff/V2_RECONCILE.md` first (one ORCH session, `claude --model opus --effort high`). Starting fresh? Skip to 2.
2. `git init -b main && git add -A && git commit -m "chore: scaffold (WP-00)"`, push to a **private** GitHub repo (public at submission, after a secrets scan).
3. `corepack enable && pnpm install && make verify` — green locally and in CI. (`make verify` also runs `claude:check` and `claims:lint`.)
4. Branch protection on `main`: PR + CI required, squash-merge only.
5. Wave 0 checklist in `docs/00` **including §6b (sandbox accounts)**. Agents cannot do these.
6. Confirm the LICENSE holder; fill the contact in `SECURITY.md`.
7. Read `docs/CHANGES_V2.md` (5 min).

## 1. Which Claude for which lane (full rules: `docs/17`)
One terminal per worktree. **Each `kickoff/WP-nn_*.md` prints its own `LAUNCH:` line — use that.** Summary:

**LEAN MODE (Claude Pro, 2026-10-10): max 2 terminals, at most 1 on Opus.** Revert if the plan is upgraded (`docs/QUESTIONS.md`, "Pro lean routing").

| Lane | Launch |
|---|---|
| SCHEMAS · KERNEL-CORE · CONTRACTS · VERIFIER · WP-14 | `claude --model opus --effort xhigh` |
| SEC · ATTACK-ADV · WP-11/13/32/34/37 | `claude --model opus --effort high` |
| ORCH · BLAST · CHAIN · KERNEL-SVC · AGENT · ATTACK · WP-12/15/19/20/24/26/33/35/36 | `claude --model sonnet --effort high` |
| WEB · DOCS · WP-21/38 | `claude --model sonnet --effort medium` |

- **Never `max`.** Never set `CLAUDE_CODE_EFFORT_LEVEL` globally.
- **`ultracode:` only if Kevin types it** (lean mode: `ultracodeWPs` is empty). The named passes are WP-29 V-1/V-2/V-3, the WP-37 final sweep and the docs↔code↔tests audits at G2/G4/G5. It burns usage.
- **Escalate one WP, not the team:** a Sonnet WP that fails VERIFIER twice, or loops > 3 times on one test, is re-run on `opus`/`xhigh`.
- **Burn guard:** at each wave boundary check usage. If > 70 % of the weekly allowance is gone before Wed Oct 14, lower efforts per `docs/17` §6 and stop non-gate `ultracode`.
- Edit routing only in the JSON block in `docs/17`, then `make kickoff` (regenerates prompts + `.claude/agents/*`); CI fails if generated files drift.

## 2. Spawn order
Spawn all *unblocked* WPs of a wave in **one message**, one worktree each (`scripts/spawn-worktree.sh <wp>`), paste the matching `kickoff/` file. Waves, dependencies and gate criteria: `docs/10` §2–§4 and `docs/12`.

**First hour:** WP-39 (routing config; if you ran V2_RECONCILE it is already done) · **WP-01 SCHEMAS** (the one serial bottleneck: usable v0 in ≤ 3 h, freeze at G1) · WP-07 CONTRACTS · WP-17 WEB shell · WP-27 DOCS pilot kit.
**As soon as WP-01 v0 merges:** WP-02, 03, 04, 09, 16, 22. Then 05, 06, 10 → 11/12/13 → 14. Later waves per the table (planner WP-35, B0/B2 + hold-out WP-36 from W3; challenge WP-32/33, certificate WP-34, SEC WP-37, replay WP-38 from W4).
**Hold-out (WP-36):** the ATTACK-ADV session is a *separate* fresh context (`.claude/agents/attack-adv.md`) that never reads `packages/kernel-core`; it commits `holdout/ROOT` before any defender runs.
**Frozen:** WP-30/31 until Gate G4.

## 3. Merge order and cadence
`schemas → contracts / kernel-core (+terms, receipts/approval) → chain → kernel-service → web → challenge`. Squash-merge only; CI required.
Every ~3 h: merge green PRs, `make verify`, update `docs/CHANGELOG_SWARM.md`, post a 10-line status.
Every wave end: gate report (criteria met / not, new risks, decisions needed) + usage check. Gates and fail actions: `docs/12`.

## 4. Rules that save the project
- **Do not let anyone relax a lint or boundary rule to get green.** `eslint.config.js` and `.dependency-cruiser.cjs` *are* INV-8/9/10/11/15/16. A change needs a `docs/QUESTIONS.md` entry and your sign-off.
- **Sandbox ≠ production (INV-16).** Separate service, DB project, signer, relayer, vault, LLM key and origin. No exceptions, no shared secrets, no wallet code on the challenge origin.
- **No real keys in any agent session (DEC-017).** Throwaway testnet keys only; `.claude/settings.json` denies secret reads (best effort). Kevin never pastes a key into a chat.
- **Numbers are computed (INV-18).** Anything on a public surface comes from `scripts/claims.ts`; `pnpm claims:lint` stays green. Planner figures say SIMULATED; replay says RECORDED. Attack traffic is never traction (INV-17).
- **Hold-out fixtures are never edited to turn a result green** and never read by defender lanes.
- Schema changes after G1 = RFC + version bump + migration notes. Chain redeploy after G3 needs VERIFIER sign-off.
- Anything touching `kernel-core` or `terms`: property tests green on 1,000 runs locally.
- A red SEC test blocks deploying any public surface; the challenge degrades (L1/L2) instead of shipping with an open P0/P1 (`docs/12` §4, `docs/15` §10).
- Mainnet only after G3 and only per the rule in `docs/12` §1 (TVL ≤ $200). Never use a personal main wallet for the owner key.
- Agents never fabricate traction, tx hashes or test results. Demo data is `tenants.kind='demo'`.
- ≥ 3 h/day of Kevin's time stays on outreach (RT-33); the challenge is a funnel, not traction.

## 5. Known scaffold limits (fix in the named WP)
| Gap | Owner |
|---|---|
| CI `contracts` job fails until the documented Arc Foundry install is added (it self-skips while there are no `.sol` files) | WP-07 |
| `foundry.toml` has `bytecode_hash`/`cbor_metadata` for byte-reproducible builds; confirm `arc-forge` accepts them | WP-07 |
| `pnpm test:web-env` is a static floor; add the runtime check (build with scrubbed env; assert none of `CIRCLE_*`/`KERNEL_*`/`GUARDIAN_*` readable) | WP-17 |
| `packages/*/test/smoke.test.ts` are wiring placeholders — delete when real tests land | each owner |
| No Next.js app yet — `apps/web` is a typed placeholder (build profiles, CSP, `<UntrustedText>`) | WP-17 / WP-33 |
| `packages/sec-suite` implements only the static SEC-06 (lint) and SEC-11 checks; the other 12 are `todo` | WP-37 |
| `scripts/claims.ts` (numbers) does not exist yet; only `claims-lint.mjs` (wording) does | WP-28 |
| `packages/terms` is a stub; the contract is in its `index.ts` header and `docs/04` K-14 | WP-04 |
| `packages/oracle` is a stub (`oracle-v1` O1..O8 per `docs/15` §2); only `packages/schemas` may be imported; defenders may not import it | WP-23 |
| `pnpm sec:sandbox` is a stub that exits 3 (never 0) until the deployed-sandbox runner exists; the set is SEC-01..10 + SEC-14 | WP-37 |
| Bash deny rules in `.claude/settings.json` are pattern matches (best effort); the real control is "no real keys in agent sessions" | SEC / Kevin |
| Coverage gate (100 % branches on kernel-core) is configured but only enforced via `pnpm test --coverage` | WP-04/05 |
| No custom lint rule for `number` arithmetic on amounts; current guard bans `Number()`, `parseFloat`, `toFixed` in money/pure code. Add branded `Amount` type in WP-01 | SCHEMAS |
