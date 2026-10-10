# Pilot kit — outreach scripts, runbook, objections (WP-27)

Source spec: `docs/09_TRACTION_AND_PILOTS.md` (the spec wins on any conflict). Terms: `docs/PILOT_TERMS.md`. Tracker: `docs/pilots/pilot_tracker.csv` (schema in `docs/pilots/README.md`).

> **Send gate.** Nothing in this file is sent until Kevin has approved the style on a sample. Auto-mode may block sends; report it and let Kevin send. Do not work around it.

## 0. Rules for every message
1. **Hand-write line 1** about the person (what they build, a post of theirs, how they pay people). If you cannot write a true first line, skip the lead.
2. Casual, short, no template feel. Never reuse a variant on two people in the same channel. Vary the opening, the length and the ask.
3. One ask only: one real invoice, or a free wallet-limits check.
4. No traction numbers, and none of the overclaiming words listed in DEC-012 (`pnpm claims:lint` checks them). If a number is needed, it comes from `scripts/claims.ts`, never typed.
5. Challenge participants and anyone reached via the sandbox are prospects, not customers, until a real engagement exists (INV-17).
6. Testnet and mainnet are never blended in anything we say.
7. Do not describe Symbolon as holding or moving anyone's funds.
8. Log each contact in the tracker the same day.

## 1. The offer (one sentence)
"I'll set up an AI invoice-payer for your USDC payouts that cannot pay the wrong person, pay twice, or go over a cap you set, even if the AI is tricked. It's free during Tameion, you keep custody, and setup takes about 20 minutes."

Keep "cannot" in that sentence tied to the vault's caps and the signed payee. If a lead asks how sure we are, use the answer in §5, not a stronger word.

## 2. First-touch variants (swap in a real line 1)
Pick one per lead. Each has different length and tone on purpose.

**A. Short DM (Discord/Telegram)**
> {line 1: something true about them}
> I'm building Symbolon for the Tameion hackathon. An AI reads contractor invoices, but it can't move money unless a separate checker and an on-chain vault agree. Would you run one real payout through it this week? Free, you keep custody.

**B. Peer-builder tone (Arc/Canteen channels)**
> {line 1}
> Quick one: you already pay people in USDC, so you've probably thought about what happens if an agent mis-pays. That's what I'm working on. Happy to set it up with you on a single small invoice, about 20 min on a call. No pressure if the timing's bad.

**C. Wallet-limits angle (no pilot ask yet)**
> {line 1}
> If you run an agent with a wallet, I'll work out your worst-case loss from four numbers: balance, per-tx cap, daily cap and your human-approval threshold. Free. I can send the result back as a short write-up.

**D. Email, slightly longer (agencies/collectives)**
> Subject: {a subject specific to them, not "Partnership"}
> Hi {name},
> {line 1}
> I'm Kevin, a student builder. For the Tameion hackathon I made a tool that reads a contractor's invoice and proposes the USDC payment, but a deterministic checker plus an on-chain vault decide whether it goes out: right payee, right amount, evidence of delivery, within your caps. You keep custody and can pause or withdraw any time.
> I'm looking for a few teams to try it on one real payout, capped small. It's free and I'll do the setup. If that's not for you, I can still check your current wallet limits for free.
> Kevin

**E. Student-founder network (testnet only, say so)**
> {line 1}
> Do you have a freelancer or vendor you're paying soon? I'd like to run that payment through a tool I built, on **testnet** (so no real money moves). The freelancer does real work, the payment flow is real, the coins aren't. 20 minutes, free.

**F. Customer-zero payee (Edith Studio payees; Kevin controls the other side)**
> {line 1}
> I'd like to pay you for {task} through a new flow I'm testing. It'll ask you to sign a short note with your wallet address and the amount before I pay. Is a USDC payment OK? Network: {testnet|mainnet}.

## 3. Public posts
**Builder channels (before `/challenge` is live)**
> Building for Tameion: **Symbolon**, an invoice-payer for agents where the AI reads the invoice but a deterministic checker and an on-chain vault decide the release. Looking for 3 to 5 small teams who pay contractors in USDC to run one real invoice through it. Free setup, you keep custody. Also: send me your agent wallet limits and I'll tell you the worst-case loss. DM me.

**After `/challenge` is live (testnet sandbox, no prize; only then)**
> I built an AI treasurer that pays contractor invoices, but it can't move money unless a checker and an on-chain vault agree. Try to make it pay the wrong person, the wrong amount, or twice: {challenge URL}. It's a testnet sandbox with posted rules and no prize. Every attempt gets a signed receipt, and the loss bound comes with a certificate you can recompute yourself. If you pay people in USDC, I'll run your wallet limits through the same calculator for free.

(No attempt counts, loss counts or bound figures here unless they come from `scripts/claims.ts`.)

## 4. Follow-ups
- **T+24h, soft:** "No rush. The quick version only needs four numbers (balance, per-tx cap, daily cap, human-approval threshold). Want me to send the result?"
- **T+3 days, last one:** one line that adds something new (a short note on what they'd see), then stop. Two follow-ups maximum per lead.
- **They say no or go quiet:** mark `CONTACTED` with a note; do not chase.
- **They reply with interest:** book a call within 48 hours; link `docs/PILOT_TERMS.md` before the call, not in a cold message (the first message carries no links for now).

## 5. Objection handling
| Objection | Answer |
|---|---|
| "Why not a Safe multisig?" | A Safe gates approvals. Symbolon does the reading and checking so approvals are rare and informed. It can sit in front of a Safe (owner = Safe, ERC-1271). |
| "Circle Agent Wallets already have limits." | They give MPC custody, spend limits, allow/block lists and screening, per Circle's docs. They don't see invoices or your signed engagement. Symbolon adds payee binding, evidence-gated release, dedupe, signed receipts and a loss bound you can recompute. The two are complementary, and the free Lite audit accepts an Agent-Wallet-style policy. |
| "Why should I trust your max-loss number?" | You don't have to. It's a certificate: run the verifier against your own RPC, and it recomputes from chain state and lists its assumptions and exclusions. It is calculated from on-chain state and empirically tested, and it is a recomputation, not a proof. |
| "I don't trust unaudited contracts." | Fair. The contracts are unaudited. Caps are tiny, you keep custody, you can pause or withdraw, testnet is an option, the code is open and the tests are published. |
| "Another tool to manage." | About 20 minutes to set up, one upload per invoice, and escalations are written in plain language. |
| "What if the AI misreads the invoice?" | The AI's output is never what releases money. The checker compares against the signed engagement, and a mismatch is held or escalated, not paid. |
| "What do you do with my invoices?" | Hashes plus redactable text, no raw invoice text in logs, private by default, deleted on request. Nothing public without your yes. |

## 6. Onboarding runbook (20 minutes, screen-share)
1. Connect the owner wallet, create the tenant, choose the network (2 min).
2. Create the engagement: payee wallet, cap, window, milestones, evidence spec. Send the payee the signing link; the payee signs (5 min).
3. Deploy and fund the vault by script with a small amount (4 min).
4. Upload one real invoice. Show extraction, decision and receipt (5 min).
5. Release, or show a hold or escalation if that's what happens. Say so plainly. Open `/audit/<hash>` (3 min).
6. Ask about publishing consent (terms §7) and schedule the next real payout (1 min).

Before the call: send `docs/PILOT_TERMS.md`, agree the caps, confirm the network choice. After: tracker row updated the same day.

## 7. What to record after a real event (same day)
1. Tracker row updated (`docs/pilots/pilot_tracker.csv`).
2. A `traction_events` row (`kind, network, real, internal, amount_base_units, tx_hash, note`). Kevin runs `arc-canteen update traction` with the same facts.
3. Explorer link and receipt screenshot stored under `docs/evidence/` (no secrets, no raw invoice text).
4. Flows between wallets Kevin controls are `internal` and never counted as pilots or real payments.
5. Any number reaching the README, video or submission form is generated by `scripts/claims.ts`.

## 8. Day plan (IST; from `docs/09` §10)
| Day | Pilot-kit actions |
|---|---|
| Sun Oct 11 | Calls with first repliers; finalize S1 engagements |
| Mon Oct 12 | Onboard pilot #1 (testnet is fine); S1 first testnet payment |
| Tue Oct 13 | First real payment; onboard pilot #2 |
| Wed Oct 14 | Pilots #3 and #4; collect consented quotes; protect at least 3 h of outreach |
| Thu Oct 15 | Final payments; snapshot; freeze counts at 18:00 |

## 9. Honesty limits
- Real counterparties only. No synthetic users, no self-dealing counted, no invented quotes.
- Targets (floor / target / stretch) are goals. They are never reported as results.
- India: before Kevin personally moves real USDC on mainnet, a chartered accountant is consulted. Default to testnet for his own flows and let external pilots fund their own vaults.
