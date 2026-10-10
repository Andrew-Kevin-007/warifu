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

## 2026-10-10 22:00 IST · ALL · KEVIN → ORCH — FINAL ANSWERS + OPERATING MODE (supersedes earlier chat)
- **Plan: Claude Pro, cannot upgrade → "Pro lean routing; revert if upgraded."** Applied in the `docs/17` §4 JSON (generator re-run: 40 kickoffs + 14 agent files; `claude:check` green with `ultracodeWPs: []`) and by hand in `docs/17` §3/§5/§6/§7, `kickoff/ORCHESTRATOR.md` §1 and `AGENTS.md` §9. **Max 2 terminals, at most 1 on Opus.** Never `max`. Opus availability: this ORCH session runs on Opus 5.5, so Opus is available in Claude Code. Kevin checks `/usage` himself.
- **1 Frontend split: YES.** Kevin owns look and layout. Agents own (a) security headers + nonce middleware, (b) `<UntrustedText>`, (c) the no-secrets check [WP-17], (d) the approval screen on `ApprovalView` / `buildApprovalTypedData()` / `renderModel()` [WP-19], (e) the receipt verifier [WP-20]. Template code must pass every existing lint and dependency-cruiser rule; none is relaxed. Hard bans: HTML sinks; inline or external scripts; analytics; remote fonts; wallet code outside `apps/web/src/wallet/**`; any AI-generated text adjacent to Approve. The "Frontend split" entry above is **RESOLVED**.
- **2 Template:** `create-next-app` (App Router, TypeScript, Tailwind) + shadcn/ui, Next 15.x pinned to an exact version, no dashboard kit, 30-minute time-box, hand-roll if not clean. **ORCH note:** create-next-app's default layout uses `next/font/google`, which fetches Google Fonts at build time. Under the remote-fonts ban, use system fonts or `next/font/local`. Adding the template's packages counts as an install: WP-17 lists packages + exact versions for Kevin's OK first.
- **3 Lean routing:** ORCH/BLAST → sonnet high; SEC → opus high; opus xhigh only SCHEMAS, KERNEL-CORE, CONTRACTS, VERIFIER, WP-14; opus high ATTACK-ADV, WP-34, WP-11/13/32/37; WP-12/15/26/36 → sonnet high; subagents sonnet. **Cuts applied** (`docs/12` §4 note): 1, 2, 3 (L1), 5, 7. "Never cut" stands. No further cuts without asking Kevin.
- **4 Arc Foundry:** Kevin installs it into `D:\tools\arc`; agents get no download permission for it. WP-07 drafts Solidity meanwhile. ORCH runs the leak-check after the install and reports; nothing is moved silently. Found: stock Foundry 1.5.1 in `D:\tools\foundry\bin` from an earlier session (not Arc Foundry; V-16).
- **5 Local Postgres:** portable, in `D:\tools\postgres` (data dir inside); bootstrap roles `anon`, `authenticated`, `service_role`; CI's real `supabase db reset` is authoritative. Gap logged as V-15. The install waits for Kevin's OK (proposal below).
- **6 Repo metadata:** LICENSE holder "Kevin Andrew A" (done). `SECURITY.md`: GitHub private vulnerability reporting is the primary channel, the plus-addressed contact the secondary; marked DRAFT until Kevin confirms (done; V-18). No other place carries Kevin's email. Commits now use the GitHub noreply address from `gh api user` (repo-local git config). **Known gap:** the 4 commits pushed before this decision (`2b84f56`, `ca9654a`, `ca2acb5`, `7312645`) carry Kevin's personal Gmail as author email. Removing it needs a history rewrite + force-push of `main`, which ORCH never does. Kevin decides before the repo goes public.
- **7 Line endings:** `.gitattributes` (`* text=auto eol=lf`, `*.sh` and `Makefile` forced LF), `.editorconfig` (`end_of_line = lf`), `core.autocrlf=false`. Done. Also fixed: `scripts/gen-kickoff.py` wrote CRLF on Windows (`Path.write_text` translates `\n`), which breaks `claude:check`'s `\n` regexes; it now passes `newline="\n"`.
- **8 G1:** schemas freeze moves from Sat 23:59 to **Sun 09:00 IST**. WP-01 v0 still merges tonight. **G2/G3 do not slip.**
- **Install rule:** nothing outside `D:\tools\<tool>\`; tell Kevin tool + source URL + target folder and wait for OK before any install; no Docker Desktop / WSL2; scratch `D:\tmp`. `D:\tools\env.sh` created exactly as specified and sourced from a new `~/.bashrc` (Git Bash auto-created a `~/.bash_profile` that loads it). **Repo location:** Kevin's layout puts the repo under `D:\work\symbolon`; the current checkout is `D:\symbolon\symbolon-v2-pack` (same drive as the pnpm store, so hardlinks already work). **Not moved.** Proposal: after PR #1 merges, Kevin OKs `git clone https://github.com/Andrew-Kevin-007/symbolon.git /d/work/symbolon` and deletes the old checkout himself.
- **Usage plan:** weekly reset Sat Oct 17 21:30 IST is reserved for VERIFIER #3, README/video/bundle checks and the final `claims:lint`; no feature work after it (G6 Sat 22:00). Burn guard per `docs/17` §6. On a limit hit mid-WP: commit WIP, update `docs/V2_STATUS.md`, stop.
- **Status:** APPLIED, except the items marked pending (installs, repo move, history email, CI).

## 2026-10-10 22:00 IST · WP-00 · ORCH — Install proposals awaiting Kevin's OK (nothing installed)
| Tool | Source | Target | Why |
|---|---|---|---|
| gitleaks (latest v8 release at least 2 weeks old, `windows_x64` zip, checked against the release checksums file) | `https://github.com/gitleaks/gitleaks/releases` | `D:\tools\gitleaks` | local secrets scan before pushes (CI runs it too) |
| PostgreSQL portable binaries (major version to match the Supabase project, VERIFY) | `https://www.enterprisedb.com/download-postgresql-binaries` | `D:\tools\postgres` (data `D:\tools\postgres\data`) | WP-09 local RLS smoke tests (V-15) |
| One-time config | `pnpm config set store-dir D:\tools\pnpm\store` · `npm config set prefix D:\tools\npm\prefix` · `npm config set cache D:\tools\npm\cache` | — | the npm cache is still on C: (`AppData\Local\npm-cache`); the pnpm store is already on D: at `D:\tools\pnpm-store` (moving it re-downloads on the next install; delete the old folder afterwards) |
**Who:** KEVIN. **Status:** OPEN.

## 2026-10-10 22:00 IST · W1/W2 · ORCH — G2 capacity with one Opus slot
- By the `docs/10` §4 estimates, the Opus-only queue to G2 (WP-01, 07, 03, 04, 02, 05, 11, 13, 14) is **≈ 53 agent-hours**, against **≈ 26 h** to Sun 23:59.
- Options (ORCH does not pick): (a) WP-02 receipts + WP-03 policy on Sonnet high with an Opus VERIFIER spot-check (≈ 5 Opus-hours saved); (b) the documented G2 relayer fallback (viem EOA, disclosed), so WP-11 leaves the G2 path (≈ 6 saved); (c) a second Opus terminal on Sunday only; (d) accept G2 landing Monday, with G3 compressed. (a)+(b) alone still leave ≈ 42 Opus-hours. **Who:** KEVIN. **Status:** OPEN.

## 2026-10-10 22:00 IST · WP-00 · ORCH — find-skills (Kevin asked)
- The Skills CLI (`npx skills find/add`) downloads a package and installs into `~/.claude` on C:. That conflicts with the install rule and §0.10, so **it was not run**. Candidates (install counts and stars not checked; nothing fetched): `circlefin/skills` (official; already KEVIN-7; named in AGENTS.md §3) and `vercel-labs/agent-skills` (Next.js/React practices, useful for the template).
- Proposal: Circle via Claude Code `/plugin`; any other skill vendored into the repo's `.claude/skills/` at a pinned commit after review, logged in CHANGELOG_SWARM. Already available without any install: superpowers (TDD, systematic debugging, verification-before-completion), `security-review`, `code-review`. **Who:** KEVIN. **Status:** OPEN.

## 2026-10-11 00:50 IST · WP-01 · SCHEMAS — Interpretations fixed in schemas v0 (review before the G1 freeze)
`docs/05` says "if code and doc disagree, fix the doc in the same PR", but `docs/` belongs to DOCS, so they are listed here instead. Each one is a reversible v0 choice; changing one after G1 is an RFC (`schemas-v1.1`).
1. **ISODateTime = whole-second UTC** `YYYY-MM-DDTHH:MM:SSZ` (`05` §1 says only "RFC 3339 UTC, 'Z'"). Reason: one spelling per instant inside hashes; contracts are second-granular. `Date#toISOString()` (`.000Z`) does not parse; use `isoFromEpochSeconds`.
2. **Text hashes** `Receipt.humanExplanationHash` and `Document.normalizedHash` = keccak256 of the text's UTF-8 bytes, not keccak256(JCS(string)). The docs say only "hash". **WP-02 to confirm.**
3. **termsHash preimage** uses the key `cap` (the `05` field list) carrying `capBaseUnits`; milestones enter without their mutable `status`.
4. **Engagement `ownerSig`/`payeeSig` are nullable** (null until signed; the `05` §3 columns are nullable). `05` §2 shows `Hex`.
5. **ConsensusDiff `a`/`b`** hold the JCS text of each value, so `null` and the string `"null"` differ.
6. **ReplayBundle.receipts are `SignedReceipt`** (receipt, hash, signature, signer) so `verify-bundle` can check signatures (`15` §7). `05` shows `Receipt[]`. `certificate` is nullable.
7. **Shapes the docs name but do not spell out**, defined by SCHEMAS: `EvidenceFixture` (`15` §2) and `TimingProposal` (`05` §2 → `03`, which has no definition).
8. **normalizeUntrusted removes more than the guardrail-7 list:** also U+061C, U+2060–U+2064, U+00AD, U+034F, U+180E, tag characters U+E0000–U+E007F, and lone surrogates (counted as `invalid`). It returns per-category `counts` next to `{normalized, removedCount}`.
9. **RESOLVED (ORCH, 2026-10-11 01:06 IST): milestoneId collisions → keep the uuid rule.** `05` §1 derives `milestoneId = keccak256(JCS({tenantId, slug|uuid}))`, but slugs are unique only per engagement, so two engagements of one tenant with a "design" milestone would get the same id. **Rule:** milestone ids are derived from a `uuid` (`deriveEntityId({tenantId, uuid})`); the preimage stays as `05` §1 has it (no `engagementId` added). Engagements may keep using a slug. KERNEL-CORE (K-05/K-06) and CONTRACTS take milestone ids as given.
10. **sanitizeLlmText placeholders are `{link}` / `{removed}`.** With `[removed]`, a later pass read `[removed]:` as a markdown link definition and deleted the rest of the line ("URGENT: …" became empty). `javascript:`/`vbscript:`/`data:` and `scheme://` are now stripped even when glued to a word (`tjavascript:`, `0https://`). All three were found by the idempotence property test.
11. **ChallengeStats.upper95LossRate is `null` while `distinctHuman = 0`** (`15` §8 types it `number`): 3/0 is not a number, and any stand-in would be a fabricated claim.
12. EIP-712 vectors use chain id 31337 (anvil). They test encoding, not a network; WP-07 adds the Arc-deployment digests.
**Who:** ORCH (accept or change), DOCS (`05` text). **Status:** OPEN.
