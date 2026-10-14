# Symbolon web page plan (v1, 2026-10-14)

**Status:** Kevin's `/` and `/about` exist (Next 16, SiteShell/Header/Footer/FooterFigures). Nothing else exists in `apps/web/src/app` as of commit `e23c363`. The WEB lane is building the rest now: **the lane builds functionality; Kevin may restyle** (except the safety surfaces below).
**Clock:** today Wed 10-14. Pilot counts freeze Thu 10-15 18:00 IST. v1 submission Fri 10-16 evening IST. Deploy freeze Sat 10-17 22:00 IST.
**Design rule:** Kevin's landing site is the design language. New pages reuse SiteShell/Header/Footer and its tokens; no second design system.

## 1. Sitemap

Design column: **KEVIN** = visual design is Kevin's (lane supplies functional skeleton first). **LANE** = lane builds functionally; Kevin may restyle later. **SAFETY** = lane only; skin tokens allowed, structure/ordering/labels fixed.

| Route | Page | Audience | Auth | Data source | Pri | WP | Exists? | Who designs |
|---|---|---|---|---|---|---|---|---|
| `/` | Home / pitch | public | none | static + `/api/public/attack/latest`, `/api/public/pilot-stats` (bundle fallback) | P0 | WP-17, WP-21 wiring | yes (design); data blocks not wired | KEVIN |
| `/about` | About | public | none | static | P2 | WP-17 hardening | yes | KEVIN (done) |
| `/judge` | Guided 5-minute review | judge | none | replay bundle + live `/api/public/*` | P0 | WP-21, WP-38 | no | KEVIN (layout) + SAFETY (card order, labels) |
| `/audit` | Receipt verifier entry | judge/public | none | static, Hex32 input | P0 | WP-20 | no | LANE |
| `/audit/[receiptHash]` | Client-side receipt verifier | judge | none | `/api/public/receipt/:hash` + public RPC; bundle | P0 | WP-20 | no | SAFETY |
| `/certificate/[vault]` | Loss Bound Certificate | judge/public | none | `/api/public/certificate/:vault`; bundle | P0 | WP-21 (data WP-34) | no | KEVIN (chrome) + SAFETY (section order, chip, exclusions) |
| `/attack-lab` | ATK-01..24 x B0/B1/B2/Symbolon | judge | none | `/api/public/attack/latest`; `results/*.json`; bundle | P0 | WP-21, WP-38 | no | KEVIN |
| `/blast-radius` | Blast Radius report + what-if | judge/public | none | `/api/public/blast/latest`; `bounds.ts` | P0 | WP-21/25 | no | LANE (Kevin optional) |
| `/blast-radius/audit` | Blast Radius Lite (free check) | public | none | closed-form `bounds.ts`, consent flag | P1 | WP-25 | no | LANE |
| `/challenge` | Break the Treasurer | attacker/judge | none, no cookies, no wallet | sandbox kernel `/v1/challenge/*`; `/api/public/challenge/stats`; bundle | P0 | WP-33 (svc WP-32, replay WP-38) | no | KEVIN (chrome/scoreboard) + SAFETY (attempt output panel, UntrustedText) |
| `/replay/[bundle]` | Recorded run viewer / fallback target | judge | none | static ReplayBundle | P0 | WP-38 | no | SAFETY (RECORDED watermark fixed) |
| `/security` | SECURITY.md + good-faith terms | attacker/public | none | static, build-time render | P0 | WP-33/37 | no | KEVIN (typography only) |
| `/pilot` | Real users and payments | judge | none | `/api/public/pilot-stats` (kind='pilot' views) | P0 | WP-20 | no | KEVIN |
| `/docs` | Docs / how it works (index + README links) | judge/dev | none | static | P1 | WEB lane (not in spec table) | no | LANE |
| `/dashboard` | Owner dashboard | owner | wallet sign-in (SIWE, UI session only) | kernel `GET /v1/state` via server route + vault read | P0 | WP-20 | no | LANE |
| `/engagements/new` | Create engagement + sign terms | owner | wallet | `POST /v1/engagements`, `/sign` | P0 | WP-18 | no | LANE; signing panel SAFETY |
| `/engagements/[id]` | Engagement status, evidence, payee change | owner | wallet | kernel engagement read, `/sign`, `/payee-change`, `/evidence/*` | P0 | WP-18 | no | LANE; signature stepper SAFETY |
| `/sign/[token]` | Payee signing link | payee | signed link token + payee EIP-712 | server-resolved token -> typedData | P0 | WP-18 | no | SAFETY |
| `/intents/new` | Submit invoice | owner | wallet | `POST /v1/documents`, `/api/extract`, `POST /v1/intents` | P0 | WP-19 | no | LANE |
| `/intents/[id]` | Decision detail + WYSIWYS approval | owner | wallet (+ OwnerApproval sig) | `/v1/intents/:id`, `/decisions`, `/plans`, `/approval-view`, `POST /v1/approvals` | P0 | WP-19 | no | SAFETY |
| `/intents` | Intents index + ranked escalation digest | owner | wallet | kernel list endpoint (gap: not in docs/05 §4) | P1 | WP-19 | no | LANE; no bulk-approve |

Not counted as pages: `/certificate` and `/replay` bare index (redirect to default sandbox vault / latest bundle), global 404, the challenge-origin variant of `/` (profile gating only, no new design).

**Spec conflicts to resolve, not guess:** (a) `/blast-radius` and `/pilot` are not in the docs/05 challenge allow-list; on the challenge origin they cross-link to the app origin. (b) `/judge` is on the challenge allow-list but card 1 must stay recorded-data only. (c) No list endpoint for decisions/intents/engagements is in docs/05 §4; `/dashboard` and `/intents` need one (flag to KERNEL-SVC). Log in `docs/QUESTIONS.md`.

## 2. Build order, remaining 3 days

Principle: **build every judge page against the replay bundle first, live data second.** Fallback is then the default path and live is an upgrade, so a judge can click around with nobody in the room even if backend, RPC, LLM or budget is down.

**Wed 10-14 (foundation + judge surface on recorded data)**
1. Nav repoint + dead-link removal in Header/Footer/home (section 6).
2. `UntrustedText`, `ClaimsNumber`, `RecordedBanner`/watermark, `useReplayFallback` loader, nonce CSP middleware, build profiles (`app`/`challenge`).
3. `/security` (static, trivial), `/replay/[bundle]`, `/attack-lab` (reads `results/attack-matrix.json`), `/audit` + `/audit/[receiptHash]` against fixture receipt, `/certificate/[vault]` from bundle.
4. `/judge` shell with 5 cards bound to bundle data. **This is the first thing a judge opens; it must be clickable end to end by tonight.**
5. Owner lane (second terminal): kernel server client, wallet provider, `/dashboard`, `/engagements/new`.

**Thu 10-15 (live wiring, pilot, challenge)**
1. Kevin's design drop for `/judge`, `/attack-lab`, `/certificate`, `/pilot`, `/challenge`, `/security` by Thu 12:00 IST so the lane integrates the same afternoon.
2. `/api/public/*` live reads + `/api/health`; auto-switch to RECORDED.
3. `/pilot` against views; **counts freeze 18:00 IST**, snapshot taken then.
4. `/blast-radius` + what-if sliders (`bounds.ts`).
5. `/challenge`: if sandbox service (WP-32) is not up and green by Thu noon, ship degrade level L2 (replay-only) and keep the page; do not delay.
6. Owner lane: `/engagements/[id]`, `/sign/[token]`, `/intents/new`, `/intents/[id]` (WYSIWYS), end-to-end on testnet.

**Fri 10-16 (hardening, submission evening)**
1. SEC-01 (XSS corpus inert on every public route), SEC-06 (CSP/nosniff), SEC-10 (kill backend: four pages render RECORDED), `pnpm claims && pnpm claims:lint`, `pnpm test:web-env`.
2. Link check over built site (every header/footer/card link resolves; every explorer link resolves).
3. Mobile pass on `/judge` (360 px) and clean-browser 5-minute path.
4. Rebuild replay bundle, print bundle hash in README, `pnpm verify-bundle`.
5. Submit evening. Sat 10-17 = buffer only: bundle rebuild + fixes, deploy before 22:00 IST, no features.

**Cut order if slipping (first to go):** `/intents` index, `/blast-radius/audit`, `/docs`, what-if sliders, payee-change panel, free-form Card C on `/challenge` (drop to L1), owner pages ship demo-tenant only. **Never cut:** `/judge`, `/replay`, `/audit/[hash]`, `/certificate`, `/attack-lab`, `/security`, RECORDED labelling.

## 3. P0 page briefs

Global bans on every page: *proven, provably, guaranteed, audited, unhackable, unbreakable, 100 % secure, risk-free* (note: "unaudited" is required wording for the contracts; confirm `claims:lint` allows it). No hand-typed number: every figure from `claims.json`/results/chain reads via `ClaimsNumber`. Planner figures labelled **SIMULATED**, replay content **RECORDED**, demo data `demo`. Route params (`[vault]`, `[receiptHash]`, `[token]`, `[bundle]`) are untrusted: regex-validate, 404 on failure, never echo.

- **`/` Home.** Pitch and spine ("Don't trust the agent. Bound it. Prove it. Invite attack."), attack-matrix summary and pilot stats pointing to `/judge`, repo, video, challenge. Must show only generated numbers; delete template placeholder stats; empty pilot state shows honest zeros. Must not link to template routes that do not exist. Works with data blocks in RECORDED mode.
- **`/judge`.** Five numbered cards, each with a no-login action: (1) ATK-10 fixed recorded run: extractor fooled, kernel REJECT with K-ids, B1/B0 loss, "vault would revert"; (2) verify a real receipt via `/audit/<hash>`; (3) certificate card: exclusions first, generated headline, VALID/STALE/UNVERIFIED chip, horizon table, copyable `pnpm lbc verify <vault>`, what-if sliders; (4) "Try to break it" opens the challenge origin with "0 losses in N distinct human attempts (95 % upper bound ~3/N)"; (5) `/pilot` with explorer links. Then a "What this does not do" block (work quality, owner-key compromise, availability, unaudited code, simulated planner results). Must NOT accept any free-form input; extractor/attacker strings only through `UntrustedText`; B1 labelled "pattern reimplementation (ours)", B0 "vendored Circle sample path at commit <hash>". Health banner "kernel offline; showing recorded run". Works on a phone.
- **`/audit`.** One Hex32 input and a few example hashes; explains what is verified client-side. Invalid input is rejected inline, never routed. Do not label the nav item "Audit" in marketing copy (see section 6); use "Verify a receipt".
- **`/audit/[receiptHash]`.** In-browser: recompute keccak256(JCS(receipt)), recover EIP-712 signer, compare with kernel signer read from the vault, check the `Released` event anchor, show policy hash, check IDs, tx and explorer link. Each step PASS/FAIL/UNVERIFIED. Any RPC or lookup error shows NOT VERIFIED, never green. One flipped byte must fail. Receipt strings via `UntrustedText`. No wallet code.
- **`/certificate/[vault]`.** Fixed order: exclusions, generated headline, status chip, horizon table with `binding`, alarmed variant (never the headline), assumptions, validation block ("not validated for this deployment" when absent), copyable verify command, STALE diff. RPC down means UNVERIFIED, never 0 or VALID. Wording "calculated from on-chain state and empirically tested". RECORDED watermark from bundle. Exclusions must not move below the number.
- **`/attack-lab`.** 24 rows x Symbolon/B0/B1/B2 with outcome, loss, checks fired, vault revert; N/A rows shown with applicability reasons and excluded from denominators; "loses on x of y applicable"; hold-out (root hash, n, k, upper bound 3/n when k=0); honest-corpus stats; reproducibility block (git SHA, seed, model IDs). Report attacks where B0/B2 also hold. Payload text via `UntrustedText`. Read-only; one-click running lives on `/challenge`.
- **`/blast-radius`.** Headline card, threat-model table (T1/T2/T3c; T4/T5 out of scope), evidence-strength table, always-visible assumptions and limits panel, recommendations, what-if sliders using the same `bounds.ts` (bigint). Sliders never mutate or look like a published certificate. Demoted mode shows "not empirically validated". Link to `/certificate`.
- **`/challenge`** (challenge origin only). Scoreboard first with rule-of-three line and one-sentence loss rule; Card A 24 one-click attacks with plain-English captions; Card B 6 benign controls with would-broadcast simulation; Card C write-your-own (<= 4 KiB plain text, scenario picker S-A/S-B/S-C, optional CAPTCHA); Card D certificate. Output panel: verdict, reason codes, K-01..K-16 fired, extraction A/B inert, oracle NO_LOSS/LOSS, receipt link. Footer "Attack traffic is not customer traffic", `/security` link, LIVE/RECORDED badge, "Synthetic data only". Must NOT contain wallet/signing code, cookies, analytics, "unbreakable", any prize language, or any traction counting. Human vs house vs one-click shown separately; `distinctHuman` excludes one-click and cache hits. Degrade ladder L0..L3 with budget-80 % banner and 429 Retry-After message. Attacker text only via `<UntrustedText value max>`; URLs in it never fetched or linked.
- **`/replay/[bundle]`.** Static, backend-free rendering of the hash-checked bundle with permanent RECORDED watermark and reason banner; shows bundle hash, builtAt, gitSha, matrix, hold-out, scenarios, publishable attempts (human attempts as hash + excerpt + verdict + receipt), receipts, certificate, testnet tx hashes, planner report (SIMULATED), `pnpm verify-bundle` command. Tamper or unknown bundle shows a hash-mismatch state. No wallet imports. Downloads as `Content-Disposition: attachment` + nosniff.
- **`/security`.** SECURITY.md rendered at build time from the trusted file: scope, good-faith terms, rules, contact, response time, "what we claim / do not claim", testnet only, no prize, data minimisation (salted IP hash 7-day TTL, no cookies). Must not say "cannot be broken". Not published until Kevin approves the wording and contact. Exists on both profiles.
- **`/pilot`.** Pilot tenants only (`kind='pilot'`): businesses, real payments, value, distinct payees, testnet and mainnet never blended, explorer link per payment, "at Tameion start: spec only, 0 users, 0 USDC" baseline, a note that challenge attempts, house attackers and demo tenants are never traction. Audit runs shown separately. Targets never rendered as results. Names and quotes only with recorded consent. Empty state: honest zeros, no placeholder numbers. Every explorer link must resolve. Needs RECORDED snapshot at Thu 18:00 IST freeze.
- **`/dashboard`.** Vault balance (on-chain), 14-day obligations, decisions feed, breaker state, owner-signed unfreeze with required reason, agent-metrics strip from computed data. States: signed-out, no tenant/vault, kernel unreachable (fail closed, never stale-as-live), breaker halted. Money via `formatBaseUnits` only. Kernel called server-side with short-lived HMAC token, never `NEXT_PUBLIC_*`.
- **`/engagements/new`.** Payee address and label, cap, window, sequential flag, milestones with evidenceSpec (OWNER_ACK, CI_PASS, URL_HEALTH, ARTIFACT_HASH), payment terms inside the signed terms (INV-19). Shows terms preview, typedData hash and implied APR from `packages/terms` before the wallet prompt. Amounts bigint + decimals. Free text re-displayed via `UntrustedText`.
- **`/engagements/[id]`.** Signature stepper (owner, payee, on-chain `EngagementRegistered`); ACTIVE only after the indexer sees the event; copyable `/sign/[token]` link; cap vs released; milestone and evidence state (kernel-collected only); artifact upload as opaque blob + hash; payee-change panel (3 signatures + delay countdown). States: DRAFT, AWAITING_PAYEE, REGISTERING, ACTIVE, CLOSED, CANCELLED.
- **`/sign/[token]`.** Payee reviews exact terms and signs (engagement; payee-change as old/new payee). Link token is not authority; the signature is. Raw typedData + hash shown beside the wallet prompt; rendered model byte-equal to signed model. States: invalid/expired, already signed, wrong wallet, signed-and-registered. Network label (testnet/mainnet) explicit. ReceiptAck variant is P1, frozen until G4.
- **`/intents/new`.** Paste or upload invoice; text extracted in apps/web with caps, only text + opaque blob hash reach the kernel (INV-23); dual-model extraction through the budget ledger; "extraction unavailable, nothing was paid" on LLM down or budget exhausted. Never implies payment. Filename and extracted text via `UntrustedText`. Production owner-only; hostile input belongs on the challenge origin.
- **`/intents/[id]`.** Mandated order: checks table K-01..K-16 first; agent vs kernel; templated explanation; plan summary (SIMULATED where applicable); approval area from `ApprovalView` via `renderModel()` with `checkWysiwys` passing before Sign enables; raw typedData + typedDataHash beside the wallet prompt. LLM prose collapsed, "Advisory (AI), not verified", never adjacent to Approve. No bulk-approve. REJECT has no approve action; REPLAY shows original decision; expired approval and breaker halted disable Approve. Payee label from the signed engagement, never from the invoice. Invoice-stated terms shown as "stated, not applied".

## 4. Shared components and web API routes

**Components** (single source, all new pages reuse):
- Safety: `UntrustedText` (+ `Untrusted<string>` type, `toExcerpt`/`toLogSafe`), `ApprovalScreen` (ApprovalView, `renderModel`, `buildApprovalTypedData`, `checkWysiwys`), `RawTypedDataPanel`, `AdvisoryAI` (collapsed), `ReceiptVerifier` (reuses `@symbolon/receipts`), `ChecksTable`, `VerdictBadge`/`ReasonCode`, `StatusChip` (VALID/STALE/UNVERIFIED), `MoneyAmount` (`formatBaseUnits`).
- Mode and labels: `RecordedBanner`/`RecordedWatermark`, `LiveRecordedBadge`, `useReplayFallback` + `BackendHealthGate`, `LabelBadge` (SIMULATED, RECORDED, demo, STALE, baseline labels, testnet/mainnet), `ClaimsNumber`, `EmptyState`/`ErrorState`/`FailClosedNotice`.
- Judge/data: `JudgeCard`, `AttackMatrixTable`, `HoldoutSummary`, `CertificateView` (+ `ExclusionsBanner`, `HorizonTable`, `ValidationBlock`, `StaleDiffPanel`), `WhatIfSliders` (`bounds.ts`), `CopyCommand`, `ExplorerLink`, `LimitationsPanel`, `PilotStatsPanel`, `StaticMarkdownPage`.
- Challenge: `ChallengeScoreboard`, `OneClickAttackGrid`, `BenignControls`, `WriteYourOwnForm`, `AttemptResultPanel`, `DegradeLadderBanner`, `TrafficDisclaimerFooter`.
- Owner: `WalletGate` + SIWE sign-in (only `src/wallet/**`), `EngagementTermsView`, `MilestoneList`, `SignatureStatusStepper`, `PayeeSignPanel`, `InvoiceUploadForm`, `EscalationDigest`, `BreakerBanner`/`UnfreezeDialog`.
- Shell: existing `SiteShell`/`Header`/`Footer`, repointed.

**Public web routes (no auth, rate-limited, sanitized):** `GET /api/public/receipt/:hash`, `/api/public/pilot-stats`, `/api/public/attack/latest`, `/api/public/blast/latest`, `/api/public/certificate/:vault`, `/api/public/challenge/stats`, `GET /api/health` (drives live-to-RECORDED), static `/replay/<bundleHash>/`.
**Owner/app-profile only:** `POST /api/extract`; server-only kernel proxies (`/api/state`, `/api/engagements*`, `/api/documents`, `/api/intents*`, `/api/approvals`, `/api/evidence/*`, `/api/breaker/unfreeze`); `/api/auth/{nonce,verify,logout}`; `/api/sign-token/[token]`. HMAC service token never reaches the browser.
**Challenge-profile only:** same-origin proxy to sandbox `GET /v1/challenge/scenarios`, `POST /v1/challenge/attempts`, `GET /v1/challenge/attempts/:id`, `POST /v1/challenge/prove-onchain` (keeps CSP `connect-src 'self'`).
**Static, not routes:** `/api/judge/atk-10` is unnecessary; card 1 reads the bundle/results directly.

## 5. What Kevin should hand-design (7 pages)

Chosen by judge impact: judges spend 5 minutes, mostly on these.

1. **`/judge`**: first thing opened; the card flow and "What this does not do" tone decide the impression. Lane fixes card order and labels only.
2. **`/attack-lab`**: the most persuasive evidence; a dense 24 x 4 matrix is where design clarity pays most.
3. **`/challenge`**: public face of "Invite attack"; scoreboard and card grid. Output panel stays SAFETY.
4. **`/certificate/[vault]`**: the headline artifact and the video's "Prove it" scene. Kevin owns chrome and typography; section order, exclusions-above-number and status-chip semantics are fixed.
5. **`/pilot`**: traction page and video end card; honest-empty-state design matters.
6. **`/` data blocks**: Kevin's own page; he decides how the live matrix and pilot stats sit in it and which template sections to cut.
7. **`/security`**: typography only; trust signal for attackers, cheap to design.

**Leave to the lane (and why):** `/audit*` and `/replay` (verifier correctness and RECORDED labelling outrank looks; Kevin only supplies tokens); `/blast-radius`, `/blast-radius/audit`, `/docs` (lower judge impact, lane output acceptable); all owner pages (`/dashboard`, `/engagements/*`, `/intents*`) and `/sign/[token]` (WYSIWYS/INV-20: the screen must be rendered from the signed model, restyling risks breaking byte-equality and the Advisory-not-adjacent rule; also the 3-day clock). **Hands-off for restyling regardless:** `UntrustedText`, `ApprovalScreen`, `RawTypedDataPanel`, `ReceiptVerifier` result states, `StatusChip` semantics, `RecordedWatermark`.

Handoff protocol: lane delivers unstyled functional page + fixed data-testid hooks; Kevin restyles via tokens/classes only; any change touching a SAFETY component goes through SEC review and re-runs SEC-01/06 and the WYSIWYS test.

## 6. Cross-cutting requirements

**Nav IA (no dead links; CI link-check).**
- Header (app origin): Judge path `/judge` · Attack lab `/attack-lab` · Certificate `/certificate/<sandbox vault>` · Blast radius `/blast-radius` · Challenge (cross-origin link) · Pilot `/pilot` · Docs `/docs` · Verify a receipt `/audit` · right side: Sign in (wallet, app profile only) -> `/dashboard`.
- Footer: Security `/security` · Replay `/replay` · About `/about` · GitHub repo · Demo video · "Attack traffic is not customer traffic".
- Challenge-origin header: Challenge · Attack lab · Certificate · Judge · Security; no Sign in, no `/about`, no `/pilot` (cross-link to app origin instead).
- Remove or repoint every template link to non-existent routes: `/console`, `/research`, `/staking`, `/tokenomics`, `/sona`, `/ai-market`, `/partners`, `/careers`, `/brand`, `/manifesto`, `/search`, `/ecosystem`, `/acceleration-program`, `/privacy-policy`, and external discord/telegram/x unless Kevin has real handles. Cross-origin links go through `CrossOriginLink`.
- Wording: "audit" collides with the banned "audited"; use "Verify a receipt" and "free check" in copy; keep `/audit` as the route only if `claims:lint` passes it.

**Build profiles (INV-16).** `NEXT_PUBLIC_PROFILE=app|challenge`. Challenge build excludes `src/wallet/**`, sets no cookies, loads no analytics, has no prod secrets or `MAINNET_*`, 404s everything outside `/`, `/challenge`, `/attack-lab`, `/certificate/*`, `/judge`, `/replay/*`, `/security`. `src/challenge/**` and `src/replay/**` may not import wallet code (dependency-cruiser). Separate Vercel project, DB, kernel signer, relayer, LLM key. Any change touching both profiles stops and asks ORCH.

**CSP / headers.** Per-request nonce (>= 128 bit) + `strict-dynamic`; no `unsafe-inline`/`unsafe-eval`; no inline `style=`; `frame-ancestors 'none'`, `base-uri 'none'`, `Referrer-Policy: no-referrer`, `COOP: same-origin`, nosniff. Self-host fonts and assets, no remote CDN. **Check the template's 3D stack** (r3f/drei/rapier per commit `e901f63`): rapier needs WASM, so CSP may need `'wasm-unsafe-eval'` (not `unsafe-eval`); keep 3D on `/` only, lazy-load, and respect `prefers-reduced-motion`; judge pages must not depend on WebGL.

**Replay mode.** Every judge page (`/judge`, `/attack-lab`, `/certificate/*`, `/challenge`, `/pilot`, `/audit/*`) renders from the verified bundle when `/api/health` fails, with RECORDED watermark and reason banner; never conflate with LIVE. Bundle rebuilt nightly and at freeze; hash in README. SEC-10 is the acceptance test.

**SEO/OG.** Per-page title/description; OG image for `/`, `/judge`, `/challenge`, `/certificate` (static, generated at build, no hand-typed numbers; certificate OG shows no bound figure). `robots`: index `/`, `/judge`, `/attack-lab`, `/security`; `noindex` on owner pages, `/sign/*`, `/replay/*`, `/audit/<hash>`. Challenge origin: `noindex` except `/challenge`.

**Accessibility minimums.** Semantic landmarks and headings, keyboard-reachable cards and tables, visible focus, WCAG AA contrast, status never colour-only (text label with chip), `aria-live` for attempt results and RECORDED banners, `prefers-reduced-motion`, tables with proper headers, copy buttons with text fallback.

**Mobile.** `/judge`, `/challenge`, `/certificate`, `/audit/[hash]`, `/sign/[token]` usable at 360 px; matrix and horizon tables scroll horizontally with sticky first column; no hover-only interactions; touch targets >= 44 px. Submission checklist already requires the 5-minute path on mobile and a clean profile.

**Gates before any public deploy.** `pnpm lint && typecheck && test`, `pnpm claims && claims:lint`, `pnpm test:web-env`, `pnpm sec:local` (SEC-01..14), dependency-cruiser, gitleaks, link check. A red SEC test ships the page at L1/L2, not with free-form input.

## 7. Open questions for Kevin

1. **Challenge origin:** are you OK with a separate Vercel project and subdomain (`challenge.<domain>`) by Thu noon? Without it `/challenge` ships replay-only (L2) and "Try to break it" has nothing live to open.
2. **Owner pages on the public origin:** for v1, should `/dashboard`, `/engagements/*`, `/intents/*` be reachable by judges (demo tenant, labelled `demo`) or only by you and pilots? This decides how much polish they need versus hiding them.
3. **Real pilot payments:** will at least one real payment (testnet or mainnet) land before Thu 18:00 IST freeze? If not, `/pilot` ships with honest zeros and the baseline, and the video must not imply otherwise.
4. **SECURITY.md:** approve the safe-harbor wording and confirm the contact is your own address (`kevinandrew.27it@licet.ac.in`, never the Claude-login address) and that GitHub private vulnerability reporting will be on.
5. **Handoff deadline:** can your six hand-designed pages be back by Thu 12:00 IST? If not, the lane's functional version ships as is and you restyle after submission.
6. **Template socials:** do you have real Discord/Telegram/X links for the footer, or should they be removed?
7. **Lite audit and `/docs`:** confirm both are cut-first (P1) so the lane spends Thu on the judge surface and WYSIWYS flow.


---

## Appendix: completeness critic

**Verdict:** The plan covers the spec route table (docs/05 §5), the judge path, the certificate order and the payee-sign flow. The challenge-origin allow-list is mostly right. The gaps are not new pages but unspecified states and profile-aware data sources. Fix before the lane builds: (1) challenge-origin links and data to /audit, /pilot and pilot-stats, plus the challenge-origin `/` 3D/CSP problem; (2) decide the no-LLM extraction default, the L1 launch level for Card C and the RECORDED vs SIMULATED label; (3) never describe a fixture as a real receipt; (4) treat the cut list as asking Kevin, and keep what-if sliders and the real-pilot owner flow; (5) add states for MilestoneAck, prove-on-chain, scoreboard N=0 and losses>0, receipt not public, and certificate history/codeMatch; (6) log Next 16 and the new template dependencies and settle the inline style= and wasm CSP issues with SEC. Wrong-wording items (the 'audit' collision, the personal email on /security) are easy fixes. Nothing else the specs require is missing; the optional extras are the pilot terms/privacy page and the Lighthouse >= 90 target.

### Missing
- `/challenge (output panel receipt link) and /judge card 2 on the challenge origin`: Challenge output panel must link each receipt to `/audit`, and /judge card 2 links to `/audit/<hash>`. `/audit*`, `/pilot` and `/blast-radius` are not on the challenge-origin allow-list. The plan lists conflicts (a)-(c) but not this one. Needs a decision: cross-origin link to the app origin, or a verifier inside the replay bundle. Same for /judge card 5 (/pilot). (docs/15 §1 item 2; docs/05 §5 final paragraph; PROJECT_BRIEF §6.2 item 3)
- `challenge-origin `/` and `/judge` (live pilot stats)`: The plan lists `/api/public/pilot-stats`, `/blast/latest` and `/receipt/:hash` as data sources for `/` and `/judge` without profile gating. The challenge origin has its own DB project and no prod secrets, and boot guard 4 requires SUPABASE_URL != prod. It cannot read `public_pilot_stats`. On that origin these blocks must come from the baked bundle or be cross-origin links. Conversely, `public_challenge_stats` exists only in the sandbox DB, so the app-origin `/judge` card 4 scoreboard needs a stated source (bundle or sandbox fetch). The plan's CSP change to same-origin proxies also differs from the spec's `connect-src 'self' <kernel-sandbox-origin>`. (docs/15 §3 conditions 3-4, §6 CSP; docs/05 §3b/§5; docs/12 R29)
- `/challenge (Card B)`: The 'prove it on-chain' action is only a proxy route. No UI, no states (rate-limited 1/hour globally, 25 test-USDC/day cap exhausted, success with explorer tx link) and no label that it is testnet. The plan's Card B only shows a 'would-broadcast' simulation. (docs/15 §2 'L3 treatment'; docs/05 §4 `POST /challenge/prove-onchain`)
- `/challenge (scoreboard states)`: Only the zero-loss sentence is specified. Missing: N=0 (3/N undefined, so show 'no human attempts yet'), and lossEvents.total > 0 (show the loss count by predicate honestly, no 3/N line, link to the incident/patch note). Also missing: oracle-disagreement display, and `source: live|recorded` shown next to every number. (docs/15 §8 display rule, ChallengeStats; docs/12 R-SANDBOX; docs/12 R32)
- `/challenge (CTA to Lite audit and pilot)`: Challenge participants are segment S6, and the page CTA 'Run a free Lite audit on your own wallet limits' / 'Pilot this on one real invoice' is the funnel. The plan's /challenge brief has no CTA and drops `/blast-radius/audit` from the challenge header. It needs a cross-origin CTA (not traction) so the funnel exists. (docs/09 §4 row S6; docs/09 §2 'Challenge traffic')
- `/engagements/[id] (owner MilestoneAck action)`: `POST /evidence/ack` takes an owner EIP-712 `MilestoneAck(milestoneId, artifactHash, override, deadline)`. It is the only way OWNER_ACK evidence and override work. The plan lists OWNER_ACK as an evidenceSpec but gives the page no ack-signing panel (with WYSIWYS-style display of milestone and artifact hash), no 'collect evidence' trigger for `POST /evidence/collect`, and no wiring for the `override` flag. (docs/05 §2 typed data (MilestoneAck), §4 `/evidence/*`; docs/05 §5 `/engagements/[id]`)
- `/sign/[token] (server-side token resolution)`: The plan invents `/api/sign-token/[token]`. The kernel's `GET /v1/engagements/:id` is tenant-scoped by the owner's HMAC token, and docs/05 §4 has no endpoint that resolves a payee token, so the payee page has no spec'd data source. It needs a KERNEL-SVC ask in QUESTIONS (token format, expiry, one-time use, what the payee may see). Add it to conflict (c). (docs/05 §4 (no payee-read route), §5 `/sign/[token]`; services/kernel/src/app.ts engagement routes; docs/QUESTIONS.md WP-12 item 9)
- `/audit/[receiptHash] (not-found and not-public states)`: `public_receipts` has only hashes. The verifier needs the full receipt (payee, amounts), which is tenant-scoped, and amounts are public only for opted-in tenants. The plan has no 'receipt not public / not found / tenant did not opt in' state and no rule for what a private receipt's owner can do (paste JSON for offline verify). Also add the offline path `pnpm verify-receipt`. (docs/QUESTIONS.md WP-09 item 5; docs/05 §3 RLS note; docs/11 §7 'Receipts verifiable offline')
- `/certificate/[vault] (history, patch-loop diff, validity metadata)`: Missing: (1) a view of a specific historical certificate (`GET /certificates/:vault/:certHash`) and the generated before/after `hourlyCap` side-by-side that the video scene 1:42-2:12 uses. (2) asOf block number and hash, `certHash`, `validity.checkedAt/freshnessSeconds`. (3) the codeMatch wording 'validated against build <gitSha>; on-chain code not matched' when NOT_CHECKED. (4) the MISMATCH outcome, which the CLI has (exit 30) but the chip trio omits. (docs/16 §3, §5.3, §7, §8; docs/11 §2 row 1:42)
- `/replay/[bundle] (fields)`: The plan's field list omits `harnessVersions`, `decisions[]` and `extractionOutputs[]`, which `verify-bundle` re-runs on, and the certificate's chain reads. It also doesn't say the bundle must be hosted at `/replay/<bundleHash>/` as static assets, where the hash in the URL is the verification anchor. (docs/15 §7 ReplayBundle; docs/16 §7 last row; docs/05 §2 ReplayBundle)
- `Replay fallback scope`: The plan's replay list omits `/blast-radius` and the `/` data blocks (the brief lists /blast-radius as judge-facing and replay-required). The T-24h checklist only names four pages, so the plan's SEC-10 test is fine, but the brief's list is wider. (PROJECT_BRIEF §6.4; docs/11 §6 'Replay bundle built')
- `/pilot terms and delete-on-request (privacy/terms page)`: There is no public page or link for the pilot terms and consent (`docs/PILOT_TERMS.md`), or for the delete-on-request path for documents and attempts. /security only covers IP hash and cookies. It omits 30-day attempt-text retention, delete-on-request and the contact. Not a mandated route, but the specs require these statements to exist somewhere public. (docs/09 §6 'One-page pilot terms', §9 'Data'; docs/15 §9 'Data minimization')
- `/pilot (single-tenant inference and late events)`: Open item: with one pilot per network the per-network row identifies that tenant. The plan says 'names only with consent' but does not address the k-threshold question. It also treats Thu 18:00 as a hard freeze, while the spec allows verified late events Fri/Sat. Say what /pilot shows for post-freeze events (as-of stamp, labelled late). (docs/QUESTIONS.md WP-09 item 3; docs/09 §10 Thu/Sat rows; docs/12 R-DEPLOY)
- `Accessibility target`: The plan has WCAG minimums but not the brief's measurable target of Lighthouse a11y >= 90, nor 'understandable in 30 seconds' for judge pages. (PROJECT_BRIEF §6.6)
- `Network / chain state on owner and sign pages`: The plan puts a testnet/mainnet label only on /sign. Owner pages (/dashboard, /engagements/*, /intents/[id]) also need explicit network, wrong-chain and wrong-account states, because testnet and mainnet are never blended and use separate keys. (docs/09 §9; AGENTS §3)

### Wrong or contradicting
- /intents/new promises 'dual-model extraction through the budget ledger' with 'extraction unavailable' as the exception. Decided 2026-10-12: there is no Anthropic key and zero paid LLM calls by default. Invoice fields come from the deterministic parser (WP-16 parse/amount.ts, parse/terms.ts) plus the human entering or confirming fields; the LLM extractor stays behind config, off unless a key exists. The default path is deterministic parse plus a confirm-fields form, and the 'unavailable' banner is the default state. Same issue for challenge Card C and the output panel's 'extraction A/B': label which extractor ran (docs/QUESTIONS.md 2026-10-12 15:20 'No paid LLM'; docs/05 §4 `/api/extract`).
- Challenge degrade assumptions. The plan treats L0 (free-form) as normal and 'drop to L1' as the cut. V2_STATUS (2026-10-13 KEVIN: NO CUTS) restored free-form and house attackers to scope, but with no LLM key the free-form path only works on the deterministic parser or when a key exists. Plan must say which, and make L1 the launch level when no key (docs/15 §10; docs/V2_STATUS.md; docs/QUESTIONS.md no-paid-LLM).
- RECORDED labelling. The plan labels all replay content RECORDED (docs/15 §7 and AGENTS agree). But the 2026-10-12 decision says 'nothing may be called RECORDED unless a real model call produced it (none can now)'; simulated or deterministic outputs stay SIMULATED. The plan must resolve this: bundle contents produced by the deterministic or simulated path need a SIMULATED (or 'replayed deterministic run') label, otherwise it breaks the honesty rule (AGENTS §0.7, §0.9).
- /judge card 1 is 'recorded-data only'. The spec says the button 'runs ATK-10 on the sandbox in ~10 s' (live, with RECORDED as automatic fallback). Always-recorded is defensible for safety, but then it must be labelled RECORDED/SIMULATED permanently and not described as 'runs'. The plan also lists this as a spec conflict but picks a side without noting that /judge is on the challenge allow-list for exactly this reason (docs/11 §3 card 1; docs/05 §5).
- Fixture receipt behind a card called 'verify a real receipt'. Wed step 3 builds /audit against a 'fixture receipt' and /judge card 2 uses it. Spec card 2 requires a real mainnet/testnet receipt; a fixture must be labelled demo/fixture, and the card must not say 'real' until a real pilot receipt exists (docs/11 §3 card 2; AGENTS §0.7; docs/09 §2).
- Cut order. (1) Kevin's 2026-10-13 'NO CUTS' means any cut needs asking him; the plan's cut list presents them as already decided. (2) It cuts 'what-if sliders' 4th, but docs/12 §4 cut 8 says 'keep what-if sliders and the certificate', and docs/11 §3 card 3 and docs/16 §7 require them. (3) 'Owner pages ship demo-tenant only' collides with the never-cut items 'release path' and '>= 1 real pilot with a real payee', and with the video's real flow at 0:38-1:12; owner pages are on the critical path of pilot traction, not a cuttable surface (docs/12 §4 'Never cut'; docs/11 §2).
- Next 16.4 / React 19.3 upgrade (commit e901f63). Spec says Next.js 15 App Router with exact pin of 15.x (AGENTS §4, §0.10; docs/05 §5; QUESTIONS 2026-10-10 item 2; PROJECT_BRIEF §6.2.1). The ESLint and dependency-cruiser rules were written for Next 15. Also the template's new dependencies (three, r3f, drei, rapier, framer-motion, gsap, react-responsive) are not in docs/CHANGELOG_SWARM.md, which AGENTS §0.10 and SEC-11 require. The plan should record the deviation in QUESTIONS and log the dependencies.
- CSP. Plan suggests adding 'wasm-unsafe-eval' for rapier. SEC-06 requires CSP to 'match the specified policy template on every route', and the template has no wasm allowance. It also says 'keep 3D on / only', but `/` is allowed on the challenge origin, the hostile-input origin. The challenge profile's `/` must be a no-3D variant, or the policy template and SEC-06 change must go through SEC (docs/13 SEC-06; docs/15 §6).
- Inline styles. The plan checks 3D under CSP but not the template's inline `style=` usage: Header.tsx, Footer.tsx, Reveal.tsx, SectionFeaturesGrid.tsx and SectionCareers.tsx contain `style=`, and framer-motion SSRs inline styles. The spec bans inline `style=` (lint) and `style-src` has no unsafe-inline, so these break SEC-06 / the lint rule (docs/15 §6).
- 'Audit' wording. The plan says 'audit collides with the banned audited' and asks to confirm claims:lint allows 'unaudited'. Only `\baudited\b` is banned (scripts/claims-lint.mjs); 'audit' and `/audit` are spec route names and 'unaudited' is explicitly encouraged (docs/16 §4.3). Renaming nav to 'Verify a receipt' is harmless but the stated reason is wrong; and 'Lite audit' is the spec's name for the free check (docs/09 §4).
- Open question 4 proposes putting `kevinandrew.27it@licet.ac.in` as the /security contact. Decided 2026-10-10 item 6: GitHub private vulnerability reporting is primary, a plus-addressed secondary contact (SECURITY.md has one) is used, and no other public place carries Kevin's address. Don't publish the personal address unless Kevin explicitly changes this.
- 'Counts freeze Thu 18:00' is presented as the clock, but V2_STATUS re-baselined G5 to Fri 18:00 (G4 Thu 23:59). 09 §10 does say 'freeze counts at 18:00' Thu, so the plan is consistent with 09 but should state it follows 09 and that Fri video/README use those frozen counts. Late verified events on Sat are allowed by 09 §10 (docs/V2_STATUS.md gate clock).
- Spec conflict list is incomplete. Add: (d) receipt links from challenge origin to /audit (see missing), (e) `/api/public/challenge/stats` exists only on the sandbox DB, (f) payee sign-token resolution has no kernel endpoint, (g) full-receipt public access (QUESTIONS WP-09 item 5), (h) Next 16 vs the Next 15 pin.
- /dashboard 'agent-metrics strip' and '14-day obligations' have no data endpoint in docs/05 §4 (only `GET /state`); plan's conflict (c) covers lists but should also list 'agent metrics' as 'computed data' source, else it breaks INV-18 if hand-built.

### Kevin design list
- /judge (layout; lane fixes card order and labels)
- /attack-lab
- /challenge (chrome and scoreboard; output panel stays safety-lane)
- /certificate/[vault] (chrome and typography; section order and status chip fixed)
- /pilot
- / (live matrix and pilot-stat blocks, prune template links)
- /security (typography only)

### Open questions
- Is a separate challenge origin (own Vercel project/subdomain) available by Thu noon? Otherwise /challenge ships replay-only.
- Should owner pages (/dashboard, /engagements/*, /intents/*) be judge-reachable with the demo tenant, or restricted to you and pilots?
- Will at least one real payment land before the Thu 18:00 IST pilot-count freeze? Otherwise /pilot ships honest zeros plus baseline.
- Approve SECURITY.md safe-harbor wording and confirm the contact is your own address, plus GitHub private vulnerability reporting on.
- Can your 6-7 hand-designed pages be back by Thu 12:00 IST for same-day integration?
- Do you have real Discord/Telegram/X links for the footer, or remove them?
- Confirm /blast-radius/audit (Lite), /intents index and /docs are cut-first (P1).
