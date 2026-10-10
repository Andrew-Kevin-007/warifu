# VERIFY_LOG — Circle/Arc behavior verified against live docs/MCP/testnet
Append only. One entry per `// VERIFY(V-xx):` in code. Format:
`## V-xx — <question>` · **Source**: URL / MCP / testnet tx · **Result**: <what is true> · **Date**: <IST> · **Impact on code**: <file:line>
Seed list of open items: `docs/00_START_HERE.md` (V-01..V-09) and `docs/12_RISKS_AND_GATES.md` assumptions register (to V-12).

## V-15 — Does the local portable Postgres behave like Supabase for RLS tests?
**Source**: Kevin's decision 2026-10-10 (portable Postgres in `D:\tools\postgres`, roles `anon`, `authenticated`, `service_role` bootstrapped by hand) · **Result**: **UNKNOWN; local != Supabase.** The local instance has no Supabase `auth` schema / `auth.uid()` / `auth.jwt()`, no PostgREST, none of Supabase's default grants or extensions, and may run a different major version. A local RLS pass is a smoke test only. **CI's real `supabase db reset` is authoritative.** · **Date**: 2026-10-10 22:00 IST · **Impact on code**: `supabase/migrations/**` (WP-09); any local RLS test must say "local" in its name.

## V-16 — Does Arc's Foundry installer honour `FOUNDRY_DIR` (target `D:\tools\arc`)?
**Source**: none yet · **Result**: **UNKNOWN.** Kevin confirms when he installs. The stock Foundry 1.5.1 binaries already in `D:\tools\foundry\bin` (installed 2026-10-10 00:41, earlier session) are **not** Arc Foundry. After install, ORCH runs the leak-check (`~/.foundry`, `~/.svm` may land on C:). · **Date**: 2026-10-10 22:00 IST · **Impact on code**: `contracts/` (WP-07), CI contracts job.

## V-17 — Why does GitHub Actions not run on `Andrew-Kevin-007/symbolon`?
**Source**: `gh api` (Actions `enabled: true`, `allowed_actions: all`; workflow `ci` active), `gh pr checks 1` · **Result**: **UNKNOWN.** 0 workflow runs and 0 check runs after the push to `main` and after PR #1 opened. Kevin to check the Actions tab and account billing. · **Date**: 2026-10-10 22:00 IST · **Impact on code**: none; blocks CI-gated merges and branch protection.

## V-18 — Is GitHub private vulnerability reporting available while the repo is private?
**Source**: not checked against GitHub docs this session · **Result**: **UNKNOWN** (ORCH's understanding: GitHub offers it for public repositories only). `SECURITY.md` names it as the primary channel with a DRAFT note; Kevin enables it when the repo goes public. · **Date**: 2026-10-10 22:00 IST · **Impact on code**: `SECURITY.md`.

