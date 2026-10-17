# Demo and video runbook (record tonight)

Companion to `docs/VIDEO_SCRIPT.md` (generated: its narration and every number come from `pnpm claims`; edit `docs/claims-templates/video-script.tmpl.md`, never the output). This file says **what to click, in what order, and what is ready now versus what needs your keys.** No number goes in the video that is not on screen from a generated source.

## Deadline clock (check before you plan the night)

The docs say Tameion closes **Sat Oct 17, 11:59 PM ET = Sun Oct 18, 09:29 IST**. You also mentioned "9:30 PM ET". 9:30 PM ET would be 07:00 IST, two and a half hours earlier. Confirm on the Tameion page; until then plan to the earlier one: **everything uploaded by 06:30 IST**, with the form allowing unlimited resubmits.

## Ready now (no keys, one command)

```powershell
pwsh scripts/demo-local.ps1       # Postgres on D:, a local chain, the REAL sandbox kernel, the web app on :3000
pwsh scripts/demo-local.ps1 -Stop # when you are done
```
The first visit to each page compiles it (dev server): click through every page below once before you record. Free-form attempts need the sandbox model key; without it the challenge runs at level L1 (one-click and benign controls), which is all the video needs.

### Click path and what to say (matches the generated script's beats)

| # | Page | Do | Say / show |
|---|---|---|---|
| 1 | `/` | Hero, then scroll the "invoice to receipt" assembly | The hook: "An AI agent read an invoice and paid the wrong wallet." The spine: don't trust the agent, bound it, prove it, invite attack. |
| 2 | `/challenge` | Press **ATK-10** (the injected "pay 10x" footer), then **ATK-02** (look-alike vendor), then benign **BC-1** | The panel is the real kernel's answer on a fresh scenario: verdict, the checks that fired (K-04, K-06, K-11...), reason codes, and the oracle line "NO LOSS". BC-1 pays the exact amount: it does not refuse everything. Read the footer line out loud: unit mode, no signed receipt. |
| 3 | `/attack-lab` | Scroll the 24-by-4 lattice, then the totals strip | Same 24 attacks against the naive baseline (many red cells) and the kernel (none). Say "SIMULATED" and "pattern reimplementation (ours)" exactly as the script does. |
| 4 | `/judge` | Scroll the five cards | The stepped fracture token: halves that do not fit. Card 1 shows the baselines losing money while Warifu is blocked. Card 3 is the certificate: with no vault deployed it says **Not computed**: say so, do not hide it. |
| 5 | `/certificate` | Show the exclusions slab first | "The bound's exclusions come first." Then the terminal command `pnpm lbc verify <vault>` once a vault exists (see below). |
| 6 | `/pilot` | Show the empty plates | "Zero is zero." Real payments appear only from pilot tenants; attack traffic is never counted. |
| 7 | `/security` | Brief | Good-faith testing terms. |

Cut order if over 3:00 (from the script): the nice-try scene, then the honest-corpus sentence. Never cut the hook, the verify command, or the Dojo scoreboard.

## Needs your keys (the real-money footage and the certificate)

The script's 0:20-0:50 beat ("signed engagement, invoice, release tx on the explorer, `/audit` verifies the receipt") and the certificate beat need a deployed testnet vault. None of this can be done without your wallets, so it is yours:

1. `pnpm env:init` and paste the values (placeholders are marked `PASTE_*_HERE`; nothing else needs editing). Operator steps 1 to 7: `docs/OPERATOR_SETUP.md`.
2. Deploy the sandbox vault (`contracts/script/Deploy.s.sol`, command in the operator guide), then `pnpm kernel:tenant` and `pnpm kernel:start`.
3. Set `NEXT_PUBLIC_SANDBOX_VAULT` and `NEXT_PUBLIC_ARC_RPC_URL` in `apps/web/.env.local`. `/certificate` then redirects to the vault's page, which shows the computed bound or, if the chain read fails, UNVERIFIED with no number.
4. Make one real testnet payment with a wallet you control (the kernel path is covered end to end by `services/kernel/test/release/release.anvil.local.test.ts`: engagement, invoice, evidence, release, `Released` event, receipt verified against the vault). Open its receipt at `/audit/<hash>`.
5. If you want mainnet footage: `docs/DEPLOY_MAINNET.md`. `pnpm mainnet:preflight` first. Use a small real payment to a wallet you control, labelled `internal` (self-dealing is never traction).

Until step 2 is done the honest on-screen answers are "Not computed" and "no receipts recorded". Record those truthfully; they are better than a faked number.

## Before you submit

- [ ] `make verify` green on the branch you submit (and `pnpm sec:local`).
- [ ] `pnpm claims && pnpm claims:lint`; rebuild the replay bundle at freeze: `pnpm build-replay && pnpm verify-bundle replay-data/bundle.json`.
- [ ] Merge the PR; deploy: web (app project and a separate challenge project built with `NEXT_PUBLIC_PROFILE=challenge`), kernel production and sandbox (separate keys, databases and domains, INV-16). Hosting steps: `docs/DEPLOY_VERCEL.md`, `docs/OPERATOR_SETUP.md`.
- [ ] Run `pnpm sec:sandbox` against the deployed sandbox (SEC-01..10 and 14 are green locally; this is the deployed run).
- [ ] Form answers: `docs/SUBMISSION_FORM_DRAFT.md` (generated; you finalise). Run `arc-canteen update traction` / `update product` only for things that really happened.
- [ ] Footer social links are removed until you supply real handles (`docs/QUESTIONS.md`).
