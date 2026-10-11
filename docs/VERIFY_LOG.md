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

## V-17 (update) — PR #1 merged with no CI run
**Source**: `gh pr checks 1` (no checks), `gh api .../actions/runs` (0) · **Result**: PR #1 was squash-merged (`0b02ff9`) on a green **local** `pnpm verify` only. **CI had not run. No CI-green claim is made anywhere.** Diagnosis in Kevin's order: (1) `.github/workflows/ci.yml` is at the repo root ✔ · (2) Actions enabled, `allowed_actions: all` ✔ · (3) `on: push: [main]` + `pull_request` match PR #1's base `main` ✔ · (4) `gh workflow list` shows `ci active` (GitHub parsed the YAML name) ✔ · (5) billing: **UNKNOWN**, since the token lacks the `user` scope (`gh auth refresh -h github.com -s user`, or github.com/settings/billing). · **Date**: 2026-10-10 22:30 IST · **Impact on code**: none.

## V-19 — Stock Foundry vs Arc Foundry
**Source**: Kevin, from docs.arc.io (2026-10-10) · **Result**: Arc Foundry (`arc-forge`, `arc-cast`, `arc-anvil`) is a fork distributed as `circlefin/arc-foundry` release archives; the docs list Linux/macOS binaries, Windows via WSL only. **Stock `forge` 1.5.1 (`D:\tools\foundry\bin`) != `arc-forge`**: dev loop only. Plan (WP-07): a CI job that downloads a pinned Linux `arc-foundry` release (version + checksum) and runs `arc-forge test` against Arc (`--network arc` per Kevin; flag UNVERIFIED). · **Date**: 2026-10-10 22:30 IST · **Impact on code**: `.github/workflows/ci.yml` contracts job, `contracts/` (WP-07).

## V-20 — Arc constants in the repo vs docs.arc.io/integrate/deploy-on-arc
**Source**: values relayed by Kevin from the page (RPC `https://rpc.testnet.arc.io` · chain ID `5042002` · explorer `https://explorer.testnet.arc.io` · faucet `https://faucet.circle.com` · gas in USDC · `maxFeePerGas` ≥ 20 gwei); repo grep 2026-10-10 · **Result**: chain ID `5042002` (`docs/06` B.4, hex `0x4cef52` = same) **matches**; faucet (`docs/00` §6) **matches**; 20 Gwei floor (`AGENTS.md` §3, `docs/00` §4, `docs/06` B.2) **matches**; USDC gas **matches**. RPC is not hardcoded (`ARC_RPC_URL` = Canteen RPC via `arc-canteen rpc`; the public RPC above is an alternative). Explorer is not referenced anywhere. The repo's doc links use `docs.arc.io/arc/...` paths: whether those paths still resolve after the docs move is **UNKNOWN** (not fetched). The CHAIN lane must set `maxFeePerGas` ≥ 20 gwei. · **Date**: 2026-10-10 22:30 IST · **Impact on code**: `packages/chain` (WP-06), `docs/06` B.4.

## V-21 — EVM version / solc vs Arc's Osaka baseline
**Source**: `contracts/foundry.toml`; Arc's stated Osaka EVM baseline (relayed by Kevin) · **Result**: **UNKNOWN, possible mismatch.** `foundry.toml` pins `solc_version = "0.8.28"` and leaves `evm_version` unset (commented `VERIFY`). Whether solc 0.8.28 can target Osaka, and which `evm_version` arc-forge expects, is unverified. WP-07 decides; no change made by ORCH (CONTRACTS owns `contracts/`). · **Date**: 2026-10-10 22:30 IST · **Impact on code**: `contracts/foundry.toml`.


## V-ATK-1 — Shape of the GitHub "list workflow runs" response used by the local evidence stub
**Source**: `packages/attack-suite/src/evidence-stubs.ts`; written from memory of the public GitHub REST API, no web access in this session · **Result**: **UNKNOWN (unverified).** The mock serves `GET /repos/{owner}/{repo}/actions/workflows/{workflow}/runs?head_sha=` as `{total_count, workflow_runs:[{id,name,head_branch,head_sha,status,conclusion,created_at,updated_at}]}`. Whether these are exactly the fields and the route the WP-13 collector reads is not checked. WP-13 owns the real collector and K-09; the stub follows it, not the other way round. · **Date**: 2026-10-11 · **Impact on code**: `packages/attack-suite/src/evidence-stubs.ts` (local profile only; the sandbox uses fixtures and never fetches).
