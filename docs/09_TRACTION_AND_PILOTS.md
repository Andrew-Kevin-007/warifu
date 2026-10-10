# 09 — TRACTION & PILOTS (30% of the score; the hardest 30% for a solo builder)

> Rubric: *"Genuine usage during the event window: real businesses, payments actually flowing in USDC, volume you can point to. Test USDC counts. Real customers transacting in real USDC on mainnet count more."* FAQ: *"What doesn't count is a synthetic dataset. If nobody's actual money is on the other side of the decision, the agent isn't being tested."* And Q6: **they judge the delta**: where the product and user count were when Tameion began vs. now.

We start ~12 days behind the cohort. **We cannot win on volume. We win on verifiability, realness, and a sharp story per user.**

> **v2 delta.** (1) **INV-17:** attack traffic (challenge attempts, house attackers, demo tenants) is *never* traction; `tenants.kind` ∈ {pilot, demo, challenge} and every stat view filters `kind='pilot'` by construction. (2) The challenge is a **funnel** (S6), not a metric; outreach hours are protected (RT-33). (3) **INV-18:** every number in the form, README and video comes from `scripts/claims.ts`, not from typing. (4) Wording: "bounded under stated assumptions", never "safe/unhackable/proven" (DEC-012).

## 1. The design property that makes pilots easy and legally cleaner
Symbolon is **non-custodial per business**: each pilot is the **owner** of its own vault, funds it with its own USDC, can pause/withdraw any time. Kevin/Symbolon never holds third-party funds and never needs to send his own money for pilots to be real. (I'm not a lawyer; see §9.)

## 2. Definitions (what counts, publicly)

| Term | Definition | Counts toward "businesses onboarded"? |
|---|---|---|
| **Business** | A distinct person/entity with its own owner wallet and ≥ 1 registered engagement with a **different** payee wallet, where at least one invoice was processed | yes |
| **Real payment** | A `Released` event on **mainnet** paying a real payee for a real deliverable | counts as "real" |
| **Test payment** | Same flow on testnet with a real counterparty doing real work | counts, labeled testnet |
| **Internal / demo** | Flows between wallets Kevin controls, demo tenant (`kind='demo'`), attack-lab runs | **never** counted; labeled `internal` |
| **Challenge traffic** *(v2)* | Attempts on the public sandbox (`kind='challenge'`): humans, one-click runs, house attackers | **never** counted as traction; shown only on `/challenge` as attack statistics |
| **Audit run** | A Blast Radius Lite run for a third party | counted separately, never as "businesses" |
| **Certificate verification** *(v2)* | Someone ran `pnpm lbc verify` or opened `/certificate/*` | not tracked as a metric; may be mentioned qualitatively only if we can evidence it |

## 3. Targets (floor / target / stretch: from PRD)
Businesses onboarded **2 / 4 / 8** · of which mainnet **1 / 2 / 3** · real payments **6 / 15 / 30** · mainnet value **$40 / $150 / $400** · distinct payees **3 / 6 / 12** · audits run **3 / 8 / 20**.
Floor is the "don't lose" line; set expectations: a floor-level result with airtight evidence beats inflated stretch claims.

## 4. Segments and channels (ranked by speed-to-yes)

| # | Segment | Why they say yes | Where to find them (≤ 48 h) | What they get |
|---|---|---|---|---|
| S1 | **Edith Studio** (customer zero) | you control it | n/a | pays 2–3 real subcontractors/tools |
| S2 | **Hackathon/Arc builders who already pay contributors or contractors in USDC** (small teams, OSS maintainers, DAO ops) | already on-chain, already feel the agent-payment fear, 1 DM away | Canteen Discord, Arc builder Discord, Circle dev community, hackathon channels, X/Farcaster threads about Tameion | free setup + safe-payout controls + Blast Radius audit |
| S3 | **Crypto-native small agencies/freelancer collectives** (design, dev, community) | pay 3–10 people monthly in USDC | X/Farcaster/Telegram groups, ETHGlobal/Devfolio alumni lists, web3 job boards, Kevin's network | same |
| S4 | **E-Cell / student-startup founders** (Kevin's network) | trust Kevin, have real freelancers/vendors | direct | **testnet** pilot with a real contractor doing real work (be explicit it's testnet) |
| S5 | **Blast Radius Lite users** (agent builders) | free, 2-minute value | Discord #builders posts, hackathon cohort threads | an audit + invitation to pilot |
| S6 *(v2)* | **Challenge participants** who ask "can I use this?" | they just tried to break it and saw the receipts | the `/challenge` page CTA ("Run a free Lite audit on your own wallet limits" and "Pilot this on one real invoice") | Lite audit → pilot invitation. **They are prospects, not customers, until a real engagement exists.** |

Use Kevin's existing outreach machinery (Instantly/Apollo/PhantomBuster, Vibe Prospecting) only for **S3 list-building and compliant, targeted, low-volume** messages; no spam. Hand-write the first line of every message.

## 5. Customer zero: Edith Studio (S1), concrete plan
1. **Pick real payees (by Sat Oct 10):** identify 2–3 people/services Edith Studio genuinely pays or plans to pay in the next 10 days (designer, editor, copywriter, offshore dev, a tool vendor who accepts USDC). Prefer people who will accept USDC. If none exists, **hire a micro-task** you actually want done (logo variant, landing-page copy, 30-second edit) for $15–$40 from a real freelancer who accepts USDC. That is a real need, a real payee, a real deliverable.
2. **Engagement per payee**: 1–3 milestones, evidence spec chosen to be hard to fake (OWNER_ACK + ARTIFACT_HASH, or CI_PASS pinned SHA), cap = milestone total.
3. **Funding:** testnet first (faucet / `arc-canteen wallet`). **Mainnet only after Gate G3** and only if funding USDC is practical and compliant for Kevin (see §9); otherwise the mainnet count comes from external pilots funding their own vaults.
4. **Run the real flow end-to-end**, capture screenshots, explorer links, the receipt page, and the payee's confirmation (a `ReceiptAck` or a plain message with permission to quote).
5. Log events (§8).

## 6. External pilot recruitment (S2/S3/S4)

### The offer (one sentence)
> "I'll set up an AI invoice-payer for your USDC payouts that **cannot pay the wrong person, pay twice, or exceed a cap you set**, even if the AI is tricked; free during Tameion, you keep custody, 20 minutes to set up."

### Ask
One real contractor, one real invoice, **cap ≤ $50** per payment, testnet or mainnet at their choice; permission to publish anonymized stats and explorer links.

### Message templates (adapt; hand-write line 1)
**Discord/Telegram DM:**
> Hey {name}, saw you pay {contributors/contractors} in USDC for {project}. I'm building Symbolon for the Tameion hackathon: an AI that reads contractor invoices but can't actually move money unless a deterministic checker + an on-chain vault agree (right payee, right amount, evidence of delivery, caps). You keep custody and can pause/withdraw anytime. Would you try it on **one** real payout this week? I'll set it up with you (≈20 min) and it's free. If you'd rather not, I can also run a free "blast radius" check on your current agent/wallet limits.

**Public post (Arc/Canteen builder channels):**
> Building for Tameion: **Symbolon**, an evidence-gated treasury kernel + Blast Radius (max-loss calculator for agent wallets). Looking for 3–5 small teams who pay contractors in USDC to run one real invoice through it. Free setup; you keep custody. Also: paste your agent wallet limits → I'll tell you your worst-case loss. DM me.

**Follow-up (T+24h):** *"No pressure; the 2-minute Blast Radius version needs only 4 numbers (balance, per-tx cap, daily cap, human-approval threshold). Happy to send the result."*

**Public post v2 (only once `/challenge` is live on the sandbox; testnet, no prize):**
> I built an AI treasurer that pays contractor invoices but can't move money unless a deterministic kernel and an on-chain vault agree. Try to make it pay the wrong person, the wrong amount, or twice: <challenge URL>. It's a testnet sandbox with posted rules (no prize), every attempt gets a signed receipt, and the loss bound is a certificate you can recompute yourself: `pnpm lbc verify <vault>`. If you pay people in USDC, I'll also run your wallet limits through the same bound calculator for free.

### Objection handling
| Objection | Answer |
|---|---|
| "Why not a Safe multisig?" | Safe gates approvals; Symbolon automates the reading/verification work so approvals become rare, and every approval is informed. Can sit *in front of* a Safe (owner = Safe, ERC-1271 supported). |
| "Circle Agent Wallets already have limits." | Agent Wallets give MPC custody, per-tx/daily/weekly/monthly limits, allow/blocklists and screening (per Circle docs). They don't see invoices or engagements. Symbolon adds payee binding to a signed engagement, evidence-gated release, dedupe, signed receipts and a recomputable loss bound. **Complementary**; our free Lite audit accepts an Agent-Wallet-style policy and reports its bounds. |
| "Why should I trust your 'max loss' number?" *(v2)* | Don't. It's a certificate: run `pnpm lbc verify <vault> --rpc <your RPC>`; it recomputes from chain state, lists its assumptions and exclusions, and turns STALE when anything loosens. It is calculated and empirically tested, not proven. |
| "I don't trust unaudited contracts." | Fair. Caps are tiny ($100/tx, $200/day); non-custodial; you can pause/withdraw; testnet option; open source; invariants + fuzz tests published. |
| "Another tool to manage." | 20-minute setup; one upload per invoice; escalations are plain-language. |

### Onboarding runbook (20 minutes, screen-share)
1. Connect owner wallet; create tenant; choose network. (2 min)
2. Create engagement: payee wallet, cap, window, milestones, evidence spec. Send payee the signing link; payee signs (gasless via relayer). (5 min)
3. Deploy/fund vault (script) with small amount. (4 min)
4. Upload a real invoice; show extraction, decision, receipt. (5 min)
5. Release (or hold/escalate if that's what happens: honest!). Show `/audit/<hash>`. (3 min)
6. Ask permission to publish anonymized stats; schedule the next real payout. (1 min)

### One-page pilot terms (docs/PILOT_TERMS.md; swarm drafts, Kevin reviews)
Hackathon-grade software, no warranty; non-custodial; caps; user can pause/withdraw; testnet/mainnet choice; data handling (documents stored hashed + redactable; delete on request); consent for public anonymized stats; no financial/legal advice; contact.

## 7. Pilot tracker (`pilots` sheet or Supabase table; swarm maintains)
Columns: `pilot_id, name/handle, segment(S1–S5), channel, first_contact_at, stage, network, owner_wallet, payees_count, engagements_created, invoices_processed, real_payments, value_base_units, last_event_at, consent_publish(Y/N), testimonial(Y/N, quote), notes`.
Stages: `CONTACTED → REPLIED → CALL_SCHEDULED → ONBOARDED → FIRST_INVOICE → FIRST_RELEASE → REPEAT`.
Daily target funnel (days 1–6): 15 contacts/day → 5 replies → 2 calls → ≥ 1 onboarded/day from D3 on.

## 8. Logging ritual (every real event, same day)
1. Insert a `traction_events` row (`kind, network, real, internal, amount_base_units, tx_hash, note`).
2. Kevin runs **`arc-canteen update traction`** with the same facts (check `--help` for fields; V-08), and `arc-canteen update product` for product milestones.
   - **Baseline entries are done today** (Wave 0) so the delta is visible.
   - Example honest entries: *"Onboarded #1 external business (agency, 4 payees, mainnet). 1 invoice released: 25 USDC to a designer, tx 0x…. Receipt https://…/audit/0x…"* · *"Attack lab: 24 attacks + hold-out, symbolon 0 loss, B1 x of y, B0 x of y, B2 x of y; honest corpus a/b auto-released or correctly escalated."* *(numbers pasted from `results/*.json` via `scripts/claims.ts`, never typed)*
3. Screenshot or screen-record the explorer + receipt page; store in `docs/evidence/` (no secrets).
4. Update public `/pilot` view (it reads the sanitized SQL view automatically).

## 9. Honesty, compliance, legal cautions (**not legal/financial advice; verify with qualified people**)
- **No wash trading. No self-dealing counted. No synthetic users.** Label everything; a skeptical judge should be able to click every explorer link and find a real counterparty.
- **Testnet vs mainnet are never blended** in a single number.
- **Testimonials only with explicit consent**; no fabricated quotes; anonymized by default.
- **Custody/money-transmission:** the non-custodial design is deliberate; don't describe Symbolon as holding or transmitting customer funds; get proper advice before any production launch.
- **India-specific (Kevin is based in Chennai):** crypto/VDA transfers can carry tax-deduction and reporting obligations, and cross-border foreign-exchange rules (FEMA) can apply. Before **you personally** move real USDC on mainnet, check with a chartered accountant. Safe defaults: use testnet for your own flows; let **external pilots fund their own vaults** with their own USDC; keep mainnet amounts trivial; keep records.
- **Sanctions/blocklists:** K-13 screening when available; refuse to onboard payees in sanctioned jurisdictions; USDC blocklist behavior documented.
- **Data:** documents may contain PII; store hashes + redactable text; no logging of raw invoices; delete on request.
- **Claims discipline:** say "bounded under stated assumptions," never "safe" or "unhackable."
- *(v2)* **Challenge legal/ethics (RT-27/28):** testnet only; **no cash prize; no mainnet challenge vault**; `SECURITY.md` with good-faith terms; synthetic data only; IPs stored as salted hashes with a 7-day TTL; no cookies/analytics on the challenge origin. Kevin reviews the terms before publishing (`15` §9). If an external attacker reports a real flaw, thank them publicly (with consent) and fix it; that is a feature of the story, not a failure.
- *(v2)* **No attack traffic as traction, ever** (INV-17): not in the form, not in the video, not in `arc-canteen update traction`. Challenge numbers may appear on the form only as a separate, clearly labelled "attack-surface evidence" line.

## 10. Day-by-day traction actions

| Day (IST) | Actions |
|---|---|
| **Fri Oct 9** | Baseline CLI entries; join Discords; post public message; DM 10 S2/S3 targets; pick S1 payees; draft pilot terms |
| **Sat Oct 10** | DM 15 more; start Blast Radius Lite teaser post (no tool yet: "DM me 4 numbers"); book 2 calls for Mon/Tue |
| **Sun Oct 11** | Calls with first repliers (use testnet demo if product not ready); finalize S1 engagements |
| **Mon Oct 12** | Onboard pilot #1 on **testnet** (even before mainnet); S1 first testnet payment; continue outreach |
| **Tue Oct 13** | **First real payment** (S1, mainnet if G3 passed, else testnet-labeled); onboard pilot #2; log CLI |
| **Wed Oct 14** | Pilots #3–4; repeat payments; Blast Radius Lite live → 3–8 audits; collect consented quotes. *(v2)* Challenge **soft-launch to 5–10 friendly attackers** (not traction); keep ≥ 3 h of outreach |
| **Thu Oct 15** | Final real payments; snapshot stats; ask pilots for a one-line quote and permission; freeze counts at 18:00. *(v2)* Challenge public; rebuild replay bundle; post v2 public message |
| **Fri Oct 16** | Use final numbers in video/README; submit v1 |
| **Sat Oct 17** | Only add *verified* late events; resubmit |

## 11. Public stats SQL (view `public_traction_summary`; the per-network `public_pilot_stats` is defined in `05` §3b)
```sql
-- v2 (INV-17): kind drives everything. is_internal remains for compatibility but is derived from kind in 0002_v2.sql.
drop view if exists public_traction_summary;   -- created by 0002_v2.sql (05 §3b); shown here for the claims generator
create view public_traction_summary as
select
  count(distinct t.id) filter (where t.kind = 'pilot') as businesses_onboarded,
  count(distinct t.id) filter (where t.kind = 'pilot' and t.network = 'mainnet') as businesses_mainnet,
  count(*) filter (where te.kind = 'release' and te.real and t.kind = 'pilot') as real_payments,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.real and te.network = 'mainnet' and t.kind = 'pilot'), 0) as mainnet_value_base_units,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.network = 'testnet' and t.kind = 'pilot'), 0) as testnet_value_base_units,
  (select count(*) from blast_reports where tenant_id is null) as audits_run
from tenants t left join traction_events te on te.tenant_id = t.id;
```
(Adjust `real` semantics: `real=true` means a real counterparty/deliverable, regardless of network; mainnet/testnet is reported separately.) **Test (SEC-04a):** in a scratch DB with the `deployment_profile` trigger disabled for the test only, insert `challenge` and `demo` tenants with releases and assert every column of this view and of `public_pilot_stats` is unchanged (the trigger itself is SEC-04b, `13` §4.6).

## 12. Submission traction answers (template; **fill only with verified numbers**)
- **Businesses onboarded:** `{n}` (`{m}` on mainnet): `{one line each, anonymized with consent}`.
- **Value moved:** `{x}` USDC mainnet across `{k}` real payments to `{p}` distinct payees; `{y}` USDC testnet. Explorer links in `/pilot`.
- **Problem solved for them:** "They pay contractors in USDC and wouldn't let an AI do it unsupervised. Symbolon let them delegate invoice-to-payment with a hard-bounded blast radius (`$X`/day) and a replayable receipt per payment."
- **Delta:** "At Tameion start: spec only, 0 users, 0 USDC. Now: …" (matches CLI baseline entry).
- **After Tameion:** "We plan to keep building: open-sourcing kernel/attack suite; pilot conversion to paid plan; seeking Canteen/Circle follow-on."
- *(v2)* **Attack-surface evidence (separate line, not traction):** "Public sandbox challenge: `{N}` distinct human attempts (unique text × scenario; one-click replays and house runs excluded) by `{U}` distinct visitors, `{L}` oracle-scored losses (95 % upper bound `{3/N}` on the loss rate); loss bound certificate verifiable with `pnpm lbc verify`." *(fill from `ChallengeStats` via `scripts/claims.ts`; if N is small, say so)*
