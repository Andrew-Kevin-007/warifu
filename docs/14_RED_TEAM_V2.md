# 14 — RED TEAM OF THE v2 IDEA (what a hostile reviewer, attacker, or judge would do — and the fix for each)

> **Scope:** the evolved concept — *Symbolon* (evidence-gated treasury kernel) + *Blast Radius* (loss bound) + **Loss Bound Certificate (LBC)** + **"Break the Treasurer" public challenge** + **Treasury Planner** (discount/timing agent) — attacked on three fronts: (A) **security** of the new public surface, (B) **integrity of our claims** (the thing judges actually score), (C) **delivery/strategy**.
> **Method:** prosecutorial. Each finding states the exploit or failure, a severity, the fix, and exactly where the fix lives (spec section, invariant, work package, test) so agents can implement and VERIFIER can check. `RT-nn` IDs are referenced from `12_RISKS_AND_GATES.md` (R29–R41) and `13_TEST_PLAN.md`.
> **Severity:** **CRIT** = can lose funds, leak secrets, or destroy credibility outright · **HIGH** = likely to cost a rubric category or leak data · **MED** = real but containable · **LOW/ACCEPT** = documented, not fixed.

## 0. Verdict (read this first)

The v1 design was strong on *payment integrity* and weak on *everything around it*. The moment we add a **public** "break it" surface we convert a private system into an **internet-facing target that ingests hostile text and holds a signing key**. The five findings that, if ignored, would sink the project:

1. **RT-05 Sandbox ↔ production blast** — one shared signer/DB/process makes the challenge a path to real funds. *(CRIT)*
2. **RT-02 / RT-03 SSRF and hostile-file parsing** reachable from public input in the process that holds **all** secrets. *(CRIT)*
3. **RT-01 Stored XSS** through attacker-controlled invoice text rendered to *judges' browsers*. *(CRIT for credibility)*
4. **RT-18 / RT-19 Overclaiming and stale certificates** — "provable" loss bound that silently stops being true. *(HIGH — it is our headline claim)*
5. **RT-07 / RT-08 Overfitting and strawman baselines** — "0 losses on our own tests vs. a baseline we wrote" is exactly what a sharp judge discounts. *(HIGH)*

Everything below is fixed in the v2 docs. Residual risks are in §5.

---

## A. SECURITY — the new public attack surface

| ID | Sev | Finding (exploit / failure) | Fix | Lands in |
|---|---|---|---|---|
| **RT-01** | CRIT | **Stored/reflected XSS.** Attacker puts `<img onerror=…>` / `javascript:` links / markdown-HTML in invoice text, filename, vendor name, or "explanation". The public attempt feed, scoreboard, decision detail or explanation panel renders it in a **judge's** browser (session theft is moot—credibility isn't). | **INV-15:** untrusted text is *inert*: rendered only as text nodes (React default), never `dangerouslySetInnerHTML`/`innerHTML`/markdown-to-HTML; attempt feed shows `sha256` + length + **sanitized, truncated excerpt in `<pre>`**; strict CSP (`default-src 'self'; script-src 'self' 'nonce-<per-request>' 'strict-dynamic'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'` (per-request nonce because Next.js emits inline bootstrap scripts, `15` §6), no `unsafe-inline`/`unsafe-eval`); ESLint bans `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `eval`, `new Function` in `apps/web`; downloads served with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`. | `02` INV-15; `15` §6; `AGENTS.md` §0.8; WP-33, WP-37; **SEC-01, SEC-06** |
| **RT-02** | CRIT | **SSRF via evidence collectors.** `URL_HEALTH` / `CI_PASS` fetchers take URLs/refs influenced by attacker documents. In a public challenge, a payload like `http://169.254.169.254/…`, `http://[::1]`, decimal/octal IPs, `user@host` tricks, DNS rebinding, or a redirect chain reaches the kernel service's network, which holds **all** secrets. | (a) **Challenge profile: no outbound evidence fetches at all** — evidence comes only from scenario fixtures (`EVIDENCE_SOURCE_DENIED`). (b) Production profile: egress **only** through a deny-by-default proxy; resolve DNS once, **pin the IP**, connect to the IP with `Host`/SNI set, re-check on every redirect (max 2, none in challenge), block all non-global ranges incl. IPv6 (`::1`, `fc00::/7`, `fe80::/10`, `::ffff:` mapped), reject userinfo/odd ports; allowlist domains come from the **signed engagement spec**, never from the invoice. | `04` K-09; `15` §5; WP-13, WP-37; **SEC-02** |
| **RT-03** | CRIT | **Hostile file parsing** (PDF/image/zip) → parser CVE, decompression bomb, or memory blow-up in a process with secrets. | (a) **Kernel never parses binary formats.** It receives only normalized UTF-8 text + the blob hash (**INV-23**). (b) Text extraction from PDFs happens **only in `apps/web`** (no payment secrets by INV-11), with size/page/time/memory caps, no JS execution, text-layer extraction only. (c) **Challenge accepts plain text ≤ 4 KiB only.** | `02` INV-23, §3 TB-1/TB-6; `03` §3; `05` Document; WP-10, WP-16, WP-37; **SEC-09** |
| **RT-04** | HIGH | **Cost-exhaustion DoS.** Every attempt triggers two LLM calls (dual-model extraction) and optionally an explainer + planner. A script burns the budget; on judging day the challenge is dead or your API bill is huge. | **INV-21:** every paid external call sits behind a **global daily budget** and **per-principal budget** (ledger table `llm_budget_ledger`); limits: ≤ 5 attempts/hour/IP, ≤ 30/day/IP (salted hash; no browser fingerprinting), ≤ 3 concurrent globally, ≤ 4 KiB input; **content-hash cache** (identical text never re-bills); on exhaustion the service **fails closed to replay mode** with an explicit banner (never skips checks, never silently degrades to single-model). Provider-side hard spend cap on the sandbox Anthropic key. | `15` §4; `05` `llm_budget_ledger`; WP-32, WP-37; **SEC-03, SEC-08** |
| **RT-05** | CRIT | **Sandbox ↔ production blast radius.** If the challenge shares a process, DB, kernel signer, relayer wallet or Circle key with pilots/production, a bug in the (deliberately attackable) sandbox is a bug in the real treasury. Also: a sandbox kernel-signer compromise must not authorize real vault releases. | **INV-16:** sandbox is a **separate deployment**: own service instance, own Supabase **project**, own kernel signer key, own relayer wallet, own vault(s), own Anthropic key with spend cap, own domain. Boot guards: `KERNEL_PROFILE=sandbox` ⇒ refuses `NETWORK=mainnet`; refuses to start if its signer address is in `PROD_SIGNER_ADDRESSES` (denylist env) or any `PROD_*` secret is present; `tenants.kind='challenge'` rows can exist only in the sandbox DB. Signers are **never reused** across profiles. | `02` INV-16, §8; `06` B.5; `15` §3; WP-32, WP-37; **SEC-04, SEC-05** |
| **RT-06** | HIGH | **Undefined win condition.** "Break it" is meaningless unless "loss" is defined. Attackers could register themselves as a legit payee, or claim a *correct* payment was a breach. | **Ground-truth oracle:** each challenge scenario is a fixture with signed-in-advance engagements (fixed payees/amounts/dates); a **loss event** is any release violating the fixture's deterministic predicate (wrong recipient, amount ≠ `amountDue`, duplicate, out-of-window, cap breach, unauthorised terms). Attackers supply *documents*, not engagements. | `15` §2; `05` `ChallengeScenario`; WP-32 |
| **RT-12** | HIGH | **Social-engineering the human gate.** The explainer LLM echoes attacker text ("URGENT: approve immediately, owner already agreed") next to the Approve button; the human is the weakest hop. | **INV-20 + ApprovalView:** the approval screen is built from **kernel-derived facts only** (payee, label, engagement, milestone, amount via `Money` formatter, diff vs engagement, reason codes, expiry). LLM prose is shown **separately, collapsed, labelled "Advisory (AI) — not verified"**, never adjacent to Approve; explanations are **templated from structured fields**; imperative/urgency language is stripped. | `02` INV-20; `03` §6; `05` `ApprovalView`; WP-19; **ATK-24, SEC-13** |
| **RT-13** | HIGH | **Display ≠ signature (WYSIWYS).** UI shows "$50 to Alice" while the typed data asks the wallet to sign $500 to Mallory (compromised front-end, or bug). | **INV-20:** one function `buildApprovalTypedData()` returns the typed-data object; the UI renders **from that same object** and shows the raw JSON + hash beside the wallet prompt; test asserts `jcs(renderedModel) == jcs(signedModel)`. The vault also binds `amount` into `OwnerApproval` (already in v1). | `02` INV-20; `05` §2; WP-19; **ATK-23, SEC-13** |
| **RT-14** | MED | **Approval fatigue / escalation flooding.** Flood ESCALATE-worthy noise, then hide one malicious item among 40 benign ones; owner starts rubber-stamping. | **K-12 escalation budget:** `policy.escalation = {maxPerDay, maxPerEngagementPerDay}`; beyond it, items become `HOLD ESCALATION_BUDGET_EXCEEDED` shown as **one digest**, never as individual prompts; **no "approve all"**; escalations ranked by risk; metric `escalationRate` reported. | `04` K-12, policy; `07` ATK-22; WP-05, WP-19 |
| **RT-26** | HIGH | **The swarm is itself an attack surface.** Coding agents read untrusted web pages, issues, PR comments, invoices and tool output (prompt injection → exfil/commands); malicious npm packages/postinstall scripts; Kevin pasting keys into chats; real keys in agent env. | **DEC-017 / `AGENTS.md` §0.10:** agents never receive real keys (throwaway testnet keys only; real keys live only in the deployment secret store); fetched content is **data, not instructions**; `.claude/settings.json` denies reading `.env*` secrets; pnpm lifecycle scripts stay disabled unless allow-listed in `onlyBuiltDependencies`; every new dependency is pinned and logged in `CHANGELOG_SWARM.md`; `pnpm audit` + gitleaks in CI; a human (Kevin) never pastes a private key into any chat. | `AGENTS.md`; `12` runbook R-KEY; WP-00/39, WP-37; **SEC-07, SEC-11** |
| **RT-30** | MED | **Webhook forgery/replay.** A forged Circle "transaction complete" webhook marks a release confirmed; reconciler is fooled or the breaker is masked. | Verify Circle's notification signature (V-12), enforce timestamp window + idempotency; **reconciler trusts chain events, not webhooks** (K-15 already reads `Released`); webhooks only *trigger* a reconcile. | `04` K-15; `06` B.2; WP-11; **SEC-12** |
| **RT-31** | MED | **Auth between web and kernel.** Stolen/replayed HMAC token used against another tenant or after expiry. | Tokens bind `{tenantId, audience, exp ≤ 60 s, nonce}`; kernel rejects replay (nonce cache), wrong tenant, wrong audience; constant-time compare; separate secrets per profile. | `05` §4; WP-10; **SEC-14** |
| **RT-29** | LOW/ACCEPT | **Ring-buffer DoS (availability).** Under T3 (signer compromised) an attacker can fill the 64-slot/24 h ring with dust releases to a registered payee, blocking legitimate payments. | Not a fund-loss path. Documented as an **availability bound** in the LBC (`availabilityNote`), mitigated operationally by guardian `pause()` + signer rotation; engagement-level `minRelease` considered and rejected (adds attack surface for little gain). | `16` §6; `08` §12 |

## B. INTEGRITY OF OUR CLAIMS — what a sharp judge or skeptic does

| ID | Sev | Finding | Fix | Lands in |
|---|---|---|---|---|
| **RT-07** | HIGH | **Overfitting / selection bias.** We tuned the kernel against our own 20 attacks, then report "0 losses". Meaningless as evidence. | **Hold-out protocol (DEC-015):** (1) a separate **adversary agent** (independent context, Opus) generates a hold-out set from a seed whose **hash is committed before kernel tuning on it**; (2) hold-out fixtures are never visible to the defender-WP agents; (3) results reported as *n trials, k losses, 95 % upper bound* (rule of three: if k = 0, upper bound ≈ 3/n); (4) a **"known limits"** table lists attacks that succeed or are out of scope (e.g., semantic work-quality fraud by a registered payee). | `07` §3.3, §5; `13` §4.5; WP-36, WP-29 |
| **RT-08** | HIGH | **Strawman baseline.** "Naive" is something we wrote to lose. | Three baselines (DEC-015): **B0** = the *actual* `circlefin/arc-escrow` release logic, pinned to a commit hash, driven with the same attack documents (model output mocked at the LLM boundary only); **B1** = naive reimplementation (kept, labeled as ours); **B2** = *reasonable hardening* (schema validation + allowlist + Agent-Wallet-style per-tx/daily caps). Report Symbolon vs all three, **including attacks where B2 holds**. | `07` §1; WP-36 |
| **RT-09** | HIGH | **Attack traffic counted as traction.** Challenge attempts, house attackers, sandbox demo payments inflate "payments flowing". An integrity breach with the people who wrote the essay on ledger errors. | **INV-17:** `tenants.kind ∈ {pilot, demo, challenge}`; `public_pilot_stats` and all traction views filter `kind='pilot'` **by construction** (view definition + a test that inserts challenge rows and asserts stats unchanged); UI copy: "Attack traffic is not customer traffic." Challenge stats live on `/challenge` only. | `02` INV-17; `05` DDL; `09` §2, §11; WP-09; **SEC-04** (+ unit test) |
| **RT-10** | MED | **Non-reproducible results.** LLM nondeterminism means "we blocked it" can't be re-run by a judge. | Every attempt stores `{extraction outputs A/B, model IDs, prompt hashes, raw outputs hash}`; kernel verdict is deterministic *given* recorded extraction; **replay** re-evaluates the kernel on recorded extractions and must reproduce `receiptHash`. | `05` `ChallengeAttempt`, `ReplayBundle`; `15` §7; WP-32, WP-38 |
| **RT-11** | HIGH | **Judge-day failure.** Judges open the app days later: Supabase paused, RPC token expired, Circle/LLM outage, budget exhausted, relayer out of gas. A dead demo = lost 20–40 %. | **DEC-016 replay mode:** every judge-facing surface (`/judge`, `/challenge`, `/attack-lab`, `/certificate`) has a **no-backend static replay** of recorded, *verifiable* runs (receipts, tx hashes, certificate) labelled **RECORDED**; auto-fallback + health banner; nightly sandbox reset; pre-funded relayer; **freeze deploys after Sat Oct 17 22:00 IST**; RPC token rotation checked at G5 (tokens last 90 days). | `11` §7; `15` §7; WP-38; **SEC-10** |
| **RT-15** | HIGH | **Terms/discount injection.** A vendor's invoice claims "5/10 net 30" or "pay today for 8 % off" to induce early/altered payment. | **INV-19:** payment terms are accepted **only** from the dual-signed engagement (`termsHash`-bound `paymentTerms`); invoice-stated terms are *data to compare*; mismatch ⇒ `ESCALATE TERMS_MISMATCH`; discount clock starts at **kernel-recorded** `invoiceReceivedAt`, never the invoice's date; agent proposes `payAt` only inside the kernel's feasible window; kernel computes `amountDue` itself. | `04` K-08/K-14; `05` `PaymentTerms`; `03` §5; **ATK-21**; WP-04/05/35 |
| **RT-16** | MED | **"The planner is just arithmetic."** A judge says choosing a discount date is a formula, not an agent. | Split honestly: **deterministic** evaluator does economics; the **LLM** does what formulas can't — parse messy free-text terms into a *proposal to be compared with the signed terms*, weigh qualitative risk flags (delivery uncertainty, vendor history, liquidity trajectory), choose among kernel-feasible plans, and explain. Evaluate vs. two baselines and an oracle-optimal DP on a seeded **simulated** corpus (≥ 120 scenarios incl. traps); report *regret* and explanation faithfulness. | `03` §5; WP-35 |
| **RT-17** | MED | **Dishonest or trivial "savings".** "$0.80 saved" is embarrassing; unrealized savings reported as real is worse. | Report as **bps and regret on a labelled simulated corpus**; real payments report realized discount separately; cost-of-capital is a disclosed parameter; no hand-typed numbers anywhere (**INV-18**: README/video/form numbers are generated by `scripts/claims.ts` from artifacts). | `02` INV-18; `11` §4; `09` §12; WP-28/35 |
| **RT-18** | HIGH | **Overclaiming "provable".** The bound depends on assumptions (owner key safe, token honest, chain final) and a threat model. "Provable" invites a one-line takedown. | **DEC-012 language rules:** say *"calculated from on-chain state and empirically tested"*, never "proven/guaranteed". Every certificate lists `assumptions[]` and `exclusions[]` (owner-key compromise, USDC issuer actions/blocklist/depeg, chain halt, RPC dishonesty, contract bugs) and the threat models T1–T3c it covers. | `16` §3–§4; `08` §12; `AGENTS.md` §0.9 |
| **RT-19** | HIGH | **Stale certificate.** Owner registers a new engagement (new payee/cap), rotates the signer or guardian, or funds the vault after certification; the old certificate now lies. (v2 has no limit setters, so a different P/D/H means a different vault.) | **INV-22:** certificate binds `{blockNumber, blockHash, configHash, engagementsDigest, balance}`; `verify` recomputes at that block (must match) **and** at latest (reports `STALE` with a diff if any loosening change occurred); UI shows status prominently; certificates carry `validUntil`. | `16` §5; `06` `configHash()`; WP-07, WP-34; unit tests |
| **RT-20** | MED | **Certificate as authority.** If "trust our signature" is the only evidence, it's just another trusted third party. | The certificate is a **deterministic function of public chain state + published algorithm**; anyone runs `pnpm lbc verify <vault>`; our signature is a convenience, not the proof. | `16` §1, §5; WP-34 |
| **RT-21** | MED | **Hidden exclusions.** Bound ignores things that can still lose money. | `exclusions[]` rendered above the number on UI and in README; the T4/T5 out-of-scope threat models are named. | `16` §4; `08` §3 |
| **RT-22** | MED | **Kernel signer = single point of trust.** | Stated honestly; T3/T3c bound shows what a stolen signer can do (`min(B, d*·⌈t/24h⌉, ΣR)`); rotation + guardian pause drills are part of the demo; signer custody moves into a Circle wallet if V-02 allows. | `08` §4; `12` R-KEY |
| **RT-32** | MED | **Forged "recorded" bundle.** Replay bundle could be fabricated. | Bundle contains receipts (signed), testnet tx hashes (explorer-verifiable), certificate, harness versions; `pnpm verify-bundle` checks signatures/hashes/anchors; the bundle hash is printed in the README and emitted once on-chain on testnet. | `15` §7; WP-38; **SEC-10** |

## C. DELIVERY AND STRATEGY

| ID | Sev | Finding | Fix | Lands in |
|---|---|---|---|---|
| **RT-23** | HIGH | **"Circle Agent Wallets already do this."** Spend caps/allowlists are commoditised; innovation (20 %) evaporates. | Lead with what Agent Wallets do **not** do: evidence-gated release, signed replayable receipts, a *computed and attacked* loss bound, a public challenge. Honest comparison table; Blast Radius **Lite audits arbitrary policy JSON, including an Agent-Wallet-style policy**, positioning us as complementary. | `01` §9; `08` §7; `11` §4 |
| **RT-24** | MED | **Narrative overload.** Five ideas in three minutes confuse a skimming judge. | One spine: **"Don't trust the agent. Bound it. Prove it. Invite attack."** Video re-timed (hook = naive agent loses money in 20 s); `/judge` 5 cards; README first screen = scoreboard + certificate. | `11` §2–§4 |
| **RT-25** | HIGH | **Scope creep (+8 WPs: WP-32..39).** More surface = more bugs and less polish. | Hard cuts: P1/P2 items frozen until G4; **degrade ladder** for the challenge (full → fixed-scenarios-only → replay-only); time-box rules; feature freeze Thu 18:00 IST unchanged. | `12` §3–§4; `10` |
| **RT-27** | HIGH | **Legal/ethical.** A cash bounty or a mainnet honeypot invites regulatory, tax, and safety trouble (esp. for an India-based builder moving personal USDC), plus disclosure ambiguity if attackers find real bugs. | **DEC-013:** challenge is **testnet-only, no cash prize, no mainnet challenge vault**; `SECURITY.md` + safe-harbor-style "good-faith testing" terms; guardian kill switch; attackers' IPs stored only as salted hashes with TTL. Talk to a CA before moving personal mainnet funds (unchanged). | `15` §9; `09` §9; root `SECURITY.md` |
| **RT-28** | MED | **Privacy leak** through public receipts/feeds of real pilot invoices. | Pilot data private by default; receipts publish hashes + redacted fields; public only with `consent_publish=Y`; challenge uses synthetic data only. | `05` DDL; `09` §9 |
| **RT-33** | MED | **Traction still weak.** The challenge adds *attack* volume, not customers. | Unchanged honesty: traction = pilots only. The challenge is a **funnel**: Lite audit CTA for participants (S5/S6), plus Edith Studio customer zero. Do not let the challenge displace outreach hours. | `09` §4, §10 |

---

## 1. The attack suite grows (payment-integrity attacks vs. platform-security tests)

| Class | IDs | Compared against baselines? | Spec |
|---|---|---|---|
| Payment-integrity attacks | ATK-01..20 (v1) + **ATK-21 discount-terms injection, ATK-22 approval-fatigue flood, ATK-23 display/sign mismatch, ATK-24 explainer social engineering** | Yes (B0/B1/B2 where applicable; ATK-23 is Symbolon-only) | `07` §3 |
| Platform-security regression | **SEC-01..SEC-14** | No (pass/fail) | `13` §4.6 |
| Hold-out | `ATK-H*` generated from a committed seed | Yes | `07` §3.3 |

## 2. Fix → work-package map

| WP | What it must land (red-team items) |
|---|---|
| 01 | `PaymentTerms`, `TreasuryPlan`, `ApprovalView`, `LossBoundCertificate`, `Challenge*`, `ReplayBundle` schemas; new reason codes; vectors |
| 04/05 | K-08 `amountDue`, K-09 profiles, K-12 escalation budget, K-14 terms binding (RT-12/14/15) |
| 07/08 | `configHash()`, `ConfigChanged`, `termsHash` preimage (RT-19) |
| 09 | `tenants.kind`, challenge/budget/certificate/replay tables, traction views (RT-04/09) |
| 10/13 | profile guards, denied egress, no-binary rule (RT-02/03/05) |
| 11 | Circle webhook signature + timestamp window + idempotency; reconcile from chain events, never from webhooks (RT-30) |
| 12 | `termsHash` preimage includes `paymentTerms` and `evidenceSpec`; engagement registration (RT-15/19) |
| 14 | discount-window TOCTOU (`DISCOUNT_WINDOW_CLOSED`); attested amount = discounted amount while `intentId` stays on the gross; kernel-recorded `invoiceReceivedAt` (RT-14/15) |
| 15 | breaker, guardian pause and key-compromise runbook (RT-22) |
| 16/35 | sanitised extraction, templated explanations, planner (RT-12/16) |
| 22/23/24 | ATK-21..24 fixtures, oracle-based report, `applicability.json`, benign controls and honest corpus (RT-06/08/12/13/15) |
| 25/26 | `bounds.ts` semantics (horizon, ΣR, binding terms), simulator and red-team validation (RT-18..21) |
| 27/28 | README, `claims.ts`, honest comparison table, video hook, `SECURITY.md`, outreach protection (RT-17/18/23/24/27/28/33) |
| 29 | VERIFIER walks every box of §4 (all RT items) |
| 17–21, 33 | CSP, safe rendering, WYSIWYS (RT-01/13) |
| 32 | challenge service, oracle, budget, rate limits (RT-04/05/06/10) |
| 34 | LBC build/verify (RT-18..21) |
| 36 | B0/B2, hold-out, statistics (RT-07/08) |
| 37 | SEC suite + hardening (RT-01..05, 26, 30, 31) |
| 38 | replay mode (RT-11/32) |
| 39 | routing + agent hygiene settings (RT-26) |

## 3. Pre-mortem: "it's Oct 18 and we lost — why?" (ranked)

1. No real payments from non-Kevin businesses (traction ≈ floor, or none) → *mitigation: outreach starts now; Edith Studio customer zero; Lite audits as funnel.*
2. Judge opened a dead/slow/confusing demo → *mitigation: replay mode, `/judge` 5-card path, frozen deploy.*
3. A reviewer found a hole in the challenge (XSS/SSRF/secret) and said so publicly → *mitigation: SEC suite + isolation + VERIFIER pass.*
4. The pitch sounded like Agent Wallets → *mitigation: first 20 s of video = naive agent (B1) loses money; scoreboard vs B0.*
5. We shipped half of everything → *mitigation: degrade ladder + ordered cut list.*

## 4. Acceptance checklist (VERIFIER ticks each with a link to a test or artifact)

- [ ] RT-01 XSS corpus (≥ 40 payloads) renders inert in every public view; CSP present; ESLint ban active.
- [ ] RT-02 SSRF corpus (≥ 40 URLs/forms) all denied; challenge profile makes zero outbound evidence requests.
- [ ] RT-03 kernel rejects any non-text payload; web extraction has size/time/memory caps; 4 KiB text cap in challenge.
- [ ] RT-04 budget exhaustion → replay banner, no unchecked releases; cache hit does not re-bill.
- [ ] RT-05 sandbox boots only with its own signer; boot fails if a prod secret/signer is present or `NETWORK=mainnet`.
- [ ] RT-06 oracle predicate defined for every scenario; loss events counted only via oracle.
- [ ] RT-07/08 hold-out seed hash committed before tuning; B0 pinned by commit; report includes "known limits" and 95 % upper bound.
- [ ] RT-09 inserting challenge/demo rows leaves `public_pilot_stats` unchanged.
- [ ] RT-10/32 replay reproduces `receiptHash` for recorded attempts; tampered bundle fails.
- [ ] RT-11 with backend killed, `/judge`, `/challenge`, `/certificate/*` still render from the bundle.
- [ ] RT-12/13 approval screen model equals signed typed data (byte-equal JCS); LLM prose never adjacent to Approve.
- [ ] RT-14 escalation budget enforced; no bulk approve.
- [ ] RT-15 invoice-stated terms never change `amountDue` or `payAt` bounds; ATK-21 contained.
- [ ] RT-16/17 planner report shows regret vs baselines on simulated corpus; all README numbers generated by script.
- [ ] RT-18..21 certificate shows assumptions/exclusions/threat models; `lbc verify` reproduces bounds from chain; stale detection works after a config change.
- [ ] RT-23/24 comparison table present; video hook within 20 s; README top screen = scoreboard + certificate.
- [ ] RT-26 no real key ever present in an agent session; `.claude/settings.json` deny rules present; lifecycle scripts blocked; gitleaks clean.
- [ ] RT-27/28 `SECURITY.md` present; no cash bounty; no mainnet challenge vault; pilot data private by default.
- [ ] RT-30/31 forged webhook & replayed/wrong-tenant tokens rejected.

## 5. Residual risks (we accept these; we say so)

- The kernel signer is a single trusted key (mitigated by bound + rotation + pause; disclosed).
- Semantic fraud by a **registered, evidenced** payee (bad work, real invoice) is outside what a payment kernel can judge; owner acknowledgement is the control.
- Unaudited Solidity: mainnet capped (≤ $200 TVL per vault) and described as such.
- Simulated planner results are simulations; we never present them as realized savings.
- Public challenge may still expose an unknown bug; kill switch, isolation and safe-harbor terms limit the damage, and we would rather find it ourselves than have a judge find it.
