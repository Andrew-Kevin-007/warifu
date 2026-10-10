# QUESTIONS — blockers, spec ambiguities, RFCs
Append only. Format: `## YYYY-MM-DD HH:MM IST · WP-xx · ROLE — <title>` then: what you need, what you tried, who should answer (KEVIN | ORCH | <ROLE>), and status.
Spec ambiguities that affect money are never guessed: write the entry and switch tasks.


## 2026-10-10 21:00 IST · WP-00 · ORCH — GitHub repo is PUBLIC; push held (irreversible)
- **Need:** Kevin asked to push to `github.com/Andrew-Kevin-007/symbolon`. `gh repo view` says it is **PUBLIC** and empty. `docs/00` §6, `ORCHESTRATOR` §0.2 and G0 say private until submission, public only after a secrets scan. A public push publishes the full plan (red-team findings, attack design) and cannot be undone.
- **Tried:** local commit only (`main` = `2b84f56` scaffold; ORCH work on `wp-00/orch-setup`). gitleaks is not installed locally, so no scan has run.
- **Who:** KEVIN. Either make the repo private (`gh repo edit Andrew-Kevin-007/symbolon --visibility private --accept-visibility-change-consequences`), or confirm the public push in writing. **Status:** OPEN.

## 2026-10-10 21:00 IST · WP-00 · ORCH — Windows: depcruise negative tests never ran (fixed, no rule relaxed)
- **What:** `test/v2-guards.test.ts` spawned `node_modules/.bin/depcruise`, a shell shim that `spawnSync` cannot exec on Windows (ENOENT). stdout/stderr were `null`, so 4 tests threw, and `expect(r.status).not.toBe(0)` was passing vacuously on `null`.
- **Fix (branch `wp-00/orch-setup`):** run `node node_modules/dependency-cruiser/bin/dependency-cruiser.mjs`, the same `node <script>` idiom the other tests use, and assert that the spawn succeeded (`r.error` undefined, numeric status). This is stricter than before. The rule config is untouched.
- **Watch:** the first cold run after the fix had 1 failure I did not capture (most likely the 20 s per-test timeout). The next 3 runs were 40/40 and the full suite was green. If it recurs, capture the test name before touching `testTimeout`. **Who:** ORCH. **Status:** FIXED / WATCHING.

## 2026-10-10 21:00 IST · WP-00 · ORCH — Local tooling gaps on Kevin's Windows machine
- No `make`: use `pnpm verify` (identical stages to `make verify`). The Makefile is unchanged.
- No `python3` (only `python`): `make kickoff` / the drift regen needs `python3`. CI (Linux) is unaffected.
- No Arc Foundry, Docker or Supabase CLI: blocks WP-07 tests and WP-09 RLS tests (KEVIN-2, KEVIN-5 in `docs/SPAWN_PLAN_W0_W1.md`). No gitleaks locally (CI runs it).
- PowerShell's `bash` resolves to the WSL alias (`WindowsApps\bash.exe`); run `spawn-worktree.sh` with `"C:\Program Files\Git\bin\bash.exe"`. A WSL `git worktree add` would write Linux paths into `.git/worktrees`.
- Global `core.autocrlf=true`: I set repo-local `core.autocrlf=false`, `core.eol=lf` (shared by all worktrees). **Proposal (needs ORCH/Kevin sign-off, root config):** add `.gitattributes` with `* text=auto eol=lf` so any other Windows clone behaves the same. **Who:** KEVIN. **Status:** OPEN (proposal).

## 2026-10-10 21:00 IST · WP-01/07 · ORCH — Second implementation of the EIP-712/JCS vectors without Foundry
- WP-01 acceptance: "vectors reproduced by a second independent implementation (a tiny Foundry test or `ethers` script)". Foundry is not installed (KEVIN-2), and whether Arc Foundry runs natively on Windows or needs WSL is unverified (VERIFY).
- **ORCH call (reversible):** WP-01 uses an `ethers` script (pinned devDependency, logged in CHANGELOG_SWARM). WP-07's Foundry digest test is the second cross-check once Foundry exists. **Who:** SCHEMAS, CONTRACTS. **Status:** DECIDED (ORCH).

## 2026-10-10 21:00 IST · WP-01 · ORCH — G1 timing and freeze tag name
- G1 is Sat 23:59. With WP-01 starting around 21:30 and v0 due ≤ 3 h later, a tested freeze tonight is not realistic. `docs/12` allows a slip to **Sun 09:00**; ORCH plans for that. Kevin may override at the gate.
- `docs/CHANGES_V2` §6 names the freeze tag "`schemas v1.0`". Git tags cannot contain spaces, so the tag is **`schemas-v1.0`** (post-freeze: `schemas-v1.1`, …). **Who:** ORCH. **Status:** DECIDED (ORCH, reversible).

## 2026-10-10 21:00 IST · WP-04 · ORCH — WP-04 depends on WP-03 but spawns with it
- `docs/10` §4 lists WP-04 deps as `01,03`. `ORCHESTRATOR` §2 spawns 02/03/04 together after WP-01 v0. **Resolution:** spawn together. WP-04 codes against the schemas `Policy` type and **merges strictly after WP-03**. **Who:** ORCH. **Status:** DECIDED.

## 2026-10-10 21:00 IST · G0 · ORCH — G0 (Sat 20:00) missed
- Met: CI-equivalent green locally (`pnpm verify` on `wp-00/orch-setup`), boundary lint proven (depcruise negative tests now actually run on Windows), WP-39 routing in place.
- Not met / unknown to ORCH: remote repo + CI, Circle key, Supabase/Vercel/Railway/Anthropic, `arc-canteen` baselines, Discord date question, outreach ≥ 10 DMs, ≥ 2 S1 payees, sandbox accounts, schemas v0.
- **G0 fail action (`docs/12`):** W1 proceeds on local tooling + mocks; resolve keys by Sun 12:00. If the Discord answer is "Oct 10", switch to emergency scope (`docs/12` §5). **Who:** KEVIN. **Status:** OPEN.

## 2026-10-10 21:20 IST · WP-00 · ORCH — UPDATE: repo is private; deadline confirmed
- Kevin made `Andrew-Kevin-007/symbolon` private (`gh repo view` reads `PRIVATE`). ORCH pushes `main` + `wp-00/orch-setup`. The "public repo" entry above is **RESOLVED**.
- Deadline: Kevin's screenshot of the official Tameion page reads "Dates: Sep 27 – Oct 17". R1 is retired and emergency scope is off. The working deadline (Sat Oct 17 22:00 IST) is unchanged. **Status:** RESOLVED.
- Kevin authorised installing tools on D: (no C: installs). ORCH installs dev tooling under `D:\tools\` and logs each tool with version + checksum in CHANGELOG_SWARM.

## 2026-10-10 21:20 IST · WP-17..21/33/38 · ORCH — Frontend split (Kevin brings the UI from a template)
- **Kevin's decision:** he picks a site template, clones it locally and does the visual layer himself. Agents do not design UI. WP-17 is HELD until the template sits in `apps/web`.
- **Need from Kevin:** OK for agents to own only the non-visual layer inside his template? That layer is: CSP + `app`/`challenge` build profiles (INV-16), `<UntrustedText>` for every attacker-derived string (INV-15), runtime web-env check (INV-11), approval screen rendered from `renderModel()` (INV-20), client-side `/audit` verification, replay fallback (DEC-016). These carry SEC tests and gate G4.
- **Constraint to pass on:** the lint/boundary rules already target **Next.js 15 App Router** under `apps/web`: wallet code only in `src/wallet/**`, no HTML sinks, challenge/replay code may not import wallet code. A non-Next template means re-wiring those rules (RFC here, Kevin sign-off). **Who:** KEVIN. **Status:** OPEN.
