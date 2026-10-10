# 01 — PRODUCT REQUIREMENTS: SYMBOLON + BLAST RADIUS

> **v2 delta.** Spine: *Don't trust the agent. Bound it. Prove it. Invite attack.* Adds: Loss Bound Certificate (`16`), public challenge (`15`), Treasury Planner (`03` §5), 24 attacks + hold-out vs three baselines (`07`), replay mode, SEC hardening (`14`). Anything not serving that sentence is P1/P2 (DEC-011).

## 1. Problem

A small business (or DAO, agency, freelancer collective) holds USDC and owes money to contractors and vendors. An AI agent can read the invoice and press the button. But:

1. **Ledgers can't catch most agent errors.** Double-entry only proves two columns agree. Omission, wrong-party, wrong-account-kind, wrong-amount-both-sides, compensating errors, and sign reversals all pass. (Canteen, *Agents and Ledgers in 2026*.)
2. **Wallet caps can't see evidence.** A $50 cap does nothing when the right amount goes to the wrong allowlisted payee, or the same invoice is paid twice with a new number.
3. **Models are bad release conditions.** The Circle arc-escrow sample releases on a model's `valid && confidence == HIGH` and never reads the stored release timestamp (per the Canteen essay). A prompt-injected PDF can steer that.
4. **No one can state the blast radius.** Owners are asked to trust an agent without a number for "worst case."

## 2. Thesis

> Delegated authority works when the steward spends freely inside a boundary they cannot talk their way past, and every spend leaves a reviewable record. (Tameion FAQ Q4 + prior-art #1.)

Symbolon makes the boundary **three layers deep**, each with a different failure mode:

| Layer | Who | Can be fooled by prompt injection? | Enforced where |
|---|---|---|---|
| L1 Agent | LLM extractor/timing/explainer | Yes (assume so) | nowhere; advisory only |
| L2 Kernel | deterministic checks K-01..K-16 | No (no LLM in the decision path) | off-chain service |
| L3 Vault | Solidity contract | No | on-chain, final |

Blast Radius quantifies what an attacker gets when L1 falls, L1+L2 fall, etc.

**v2 reading of the table.** *Bound it* = L2 + L3. *Prove it* = the **Loss Bound Certificate**: the number Blast Radius computes, packaged so anyone can recompute it from chain state (`pnpm lbc verify <vault>`) and see it go STALE when the vault changes. *Invite attack* = the public testnet **challenge**, where attackers supply documents and an oracle (not us) decides whether money was lost. The LLM layer also has real work, the **Treasury Planner**: choosing *when* and *how* to pay inside the kernel-feasible region (early-pay discounts, liquidity), while the kernel stays the only authority on *whether* and *how much*.

## 3. Users and jobs-to-be-done

| Persona | Context | Job | Pain today |
|---|---|---|---|
| **P1 Studio owner** (Kevin / Edith Studio; customer zero) | Pays 1–3 subcontractors (designer, editor, offshore dev) and a few tools | "Pay my people on time, correctly, without babysitting; prove it later." | Manual wires, copy-paste addresses, no audit trail |
| **P2 Crypto-native agency / DAO ops lead** | Pays contributors in USDC, 5–30 payees | "Let an agent run payouts without it ever being able to rug us." | Fear of agent autonomy; Safe-multisig friction |
| **P3 Contractor/payee** | Wants fast, certain pay | "Get paid when work is verified; no net-30 float." | Waiting, disputes, wrong-address mishaps |
| **P4 Reviewer/auditor** | Canteen/Circle judge; later a real auditor | "Replay why money moved; verify without trusting the operator." | Opaque agent logs |
| **P5 Other agent builders** | Hackathon cohort | "How exposed is my agent wallet?" | No quantified answer |

## 4. Product principles

1. **The model proposes; it never disposes.** No LLM output is a release condition.
2. **Fail closed.** Any exception, timeout, missing evidence → `HOLD`/`ESCALATE`, never `RELEASE`.
3. **Refuse, don't round.** Money is integer base units with declared decimals. Ambiguity is escalated.
4. **Evidence is collected by the kernel, not asserted by the agent.**
5. **Every decision is replayable.** Receipt = inputs hash + checks + policy version + model IDs + signature.
6. **Non-custodial.** The business's owner key can always pause and withdraw. Symbolon never holds third-party funds.
7. **Be honest about limits.** Report false-reject rate, assumptions, and what is out of scope.

## 5. Scope

### P0: must ship (core demo + pilots)
- P0-1 Engagement creation + dual signing (owner + payee), on-chain registration.
- P0-2 Invoice ingest (paste/upload text/PDF) → dual-model extraction → `PaymentIntent`.
- P0-3 Kernel pipeline K-01..K-14 + verdict algebra + signed receipts.
- P0-4 `SymbolonVault.sol` with attestation-gated release, per-tx/daily caps, human-approval threshold, payee binding, pause, owner withdraw. Deployed on Arc testnet; mainnet after gate.
- P0-5 **Treasury Planner** (v2): agent chooses among kernel-feasible payment plans (timing, early-pay discount) with a templated, structured rationale; deterministic evaluator computes economics; terms only from the signed engagement (DEC-014). Escalation explanations are templated from structured fields (INV-20).
- P0-6 Human approval via owner EIP-712 signature (on-chain enforced above threshold).
- P0-7 Reconciler (K-15 chain-side) + circuit breaker (K-16).
- P0-8 Attack lab: Symbolon vs baselines **B0/B1/B2** across ATK-01..24, plus the committed-seed **hold-out set**, with honest-corpus false-reject rate (DEC-015).
- P0-9 Blast Radius v1: closed-form max-loss under 4 threat models + ≥500 randomized differential trials on the real contract, published as a **Loss Bound Certificate** with assumptions, exclusions and staleness (`16`).
- P0-10 Web UI: dashboard, intent detail, engagements, attack lab, blast-radius report, `/certificate/[vault]`, `/challenge`, public receipt verifier, `/judge` guided path (5 cards), pilot stats, **replay mode** for all judge-facing pages (DEC-016).
- P0-11 Pilots: Edith Studio live on real payees; ≥2 external businesses (see targets).
- P0-12 *(v2)* **"Break the Treasurer" challenge** (`15`): testnet-only, separate deployment, oracle-defined loss, public scoreboard, replay bundles (WP-32/33).
- P0-13 *(v2)* **Loss Bound Certificate** build/verify/CLI/API/UI (`16`, WP-34).
- P0-14 *(v2)* **Security hardening + SEC suite** (INV-15/16/21/23, SEC-01..14; WP-37) and **replay mode** (WP-38).

### P1: strong if time allows (v2: **frozen until Gate G4 passes**, DEC-018)
- P1-1 Payee acknowledgement witness (`ReceiptAck`) closing the loop for commission errors.
- P1-2 Circle Compliance Engine screening (K-13) wired live.
- P1-3 Dispute-draft generation on HOLD.
- P1-4 Vendor behavior memory (on-time, disputes) feeding the timing agent.
- P1-5 Vault factory (per-tenant clone) instead of scripted deploys.

### P2: stretch (only after Gate G5)
- P2-1 ERC-8183 adapter: kernel acts as the *deterministic evaluator*.
- P2-2 ERC-8004 agent identity registration for the kernel/extractor.
- P2-3 EURC lane (invoices in EUR → EURC).
- P2-4 Agent Wallet probe suite for Blast Radius (mainnet, human OTP).
- P2-5 Memo-contract anchoring of `receiptHash` in the payment transaction.
- P2-6 Run the attack lab against the real arc-escrow app and publish findings constructively (+ upstream PR).

### Explicit non-goals
Yield/USYC, cross-chain settlement, FX/swap, fiat on/off-ramps, KYC, legal entity management, a mobile app, "AI CFO forecasting," general accounting. *(v2)* **Cash bounties, a mainnet challenge vault, claims of "provable"/"guaranteed" security, formal verification, counting attack traffic as customers.**

## 6. Key user stories (acceptance criteria are testable)

**US-1 Create an engagement.** *As an owner, I define a payee, wallet, cap, window, and milestones with evidence specs; the payee signs; it registers on-chain.*
- AC: engagement is rejected on-chain unless both EIP-712 signatures verify; `Engagement` row and `EngagementRegistered` event match by `termsHash`.

**US-2 Pay a verified milestone.** *As an owner, I upload the contractor's invoice; the agent extracts it, the kernel verifies evidence, and the vault releases USDC.*
- AC: end-to-end on testnet in <60 s for a clean invoice; receipt verifiable at `/audit/<receiptHash>`; `Released` event carries the same `receiptHash`.

**US-3 Be protected from a swapped wallet.** *As an owner, when an invoice or email says "new wallet details," nothing is paid to the new address.*
- AC: ATK-11 yields `REJECT` (K-06) or `ESCALATE` (K-11); vault would also revert; Blast Radius states payee-change requires old-payee + new-payee + owner signatures plus delay.

**US-4 Never double-pay.** *Retries, timeouts, renumbered invoices do not produce a second payment.*
- AC: ATK-08 → exact replay returns the *original decision*; ATK-12 → `ESCALATE`; vault `used[intentId]` prevents on-chain repeat.

**US-5 Know the worst case.** *As an owner, I see "max loss in 24 h if the agent is fully compromised: $X; if the kernel signer is also compromised: $Y."*
- AC: report generated from `policy.yaml` + on-chain config; ≥500 randomized T3 trials on the real contract and ≥200 T1 red-team plans show zero trial above the stated bound; the same numbers are published as a Loss Bound Certificate with assumptions and exclusions shown above the number.

**US-6 Human stays in control above a threshold.** *Large payments require my wallet signature, verified on-chain.*
- AC: release above `humanThreshold` reverts without a valid `OwnerApproval`.

**US-7 Replay any decision.** *As a reviewer, I paste a receipt hash and see checks, evidence refs, policy version, model IDs, signature validity, and tx link.*
- AC: `/audit/<hash>` verifies signature + on-chain anchor without trusting our server.

**US-8 Verify the bound yourself.** *As a reviewer or counterparty, I run `pnpm lbc verify <vault> --rpc <my RPC>` and get exit 0 (VALID), 10 (STALE, with diff) or 20 (UNVERIFIED).*
- AC: recomputation uses only public chain state and the published algorithm version; tampering with any field yields MISMATCH; no Symbolon server or signature is needed (`16` §5).

**US-9 Try to break it.** *As a stranger, I open `/challenge`, pick a scenario, submit a hostile document and see within seconds whether the oracle scored a loss, with the receipt and every check that fired.*
- AC: ≤ 4 KiB text only; fresh scenario instance per attempt; a loss is defined by the scenario's deterministic predicate, not by us; attack traffic never changes pilot stats (INV-17); works in RECORDED mode if the backend is down.

**US-10 Pay at the right time.** *As an owner, I see the planner's recommended payment date and why (discount window, liquidity), computed against the terms in my signed engagement.*
- AC: invoice-stated terms never change `amountDue` or the permissible window (ATK-21); the plan's economics are produced by the deterministic evaluator; any figure shown for the simulated corpus is labelled SIMULATED.

## 7. Success metrics

### Product quality (reported in README, honestly)
| Metric | Floor | Target |
|---|---|---|
| Attack suite: Symbolon loss across ATK-01..24 (oracle-defined) | 0 USDC | 0 USDC |
| **B1 (naive)** loss on the *applicable* attacks (n/a rows excluded from the denominator and listed) | ≥ 12 succeed | ≥ 15 |
| **B0 (real arc-escrow path)** and **B2 (hardened)** | reported as measured, **no target** (we publish where they hold) | same |
| **Hold-out set** (`ATK-H*`, seed hash committed first): Symbolon losses k of n | k = 0, n ≥ 100, report rule-of-three upper bound | n ≥ 300 |
| Honest corpus (≥40 invoices): auto-release or correct ESCALATE | ≥ 90% | ≥ 95% |
| Honest corpus: wrongful REJECT | ≤ 5% | ≤ 2% |
| Blast Radius T3 differential trials with bound violations (real contract) | 0 / 500 | 0 / 1000 |
| Blast Radius T1 red-team plans with unauthorized loss | 0 / 200 | 0 / 1000 |
| `pnpm lbc verify` on the testnet vault with an independent RPC | exit 0; STALE reproduced after a config change | + code-match MATCH |
| Treasury Planner on the **simulated** corpus (≥120 scenarios incl. traps) | beats pay-immediately and pay-on-due baselines on mean net benefit; **0 trap mispayments** | ≥ 80 % of oracle-optimal (DP) net benefit; labelled SIMULATED |
| Challenge (reported on `/challenge` only; never traction) | oracle-scored losses = 0; ≥ 30 distinct attempts; house attackers nightly | ≥ 100 attempts; ≥ 10 distinct external attackers |
| E2E clean invoice latency (extract→release→final) | < 90 s | < 45 s |
| Cost per invoice (LLM) | < $0.10 | < $0.03 |

### Traction (see `09_TRACTION_AND_PILOTS.md`; **no wash trading**)
| Metric | Floor | Target | Stretch |
|---|---|---|---|
| Real businesses/people onboarded (distinct, non-self) | 2 | 4 | 8 |
| Of which on mainnet with real USDC | 1 (Edith Studio) | 2 | 3 |
| Real (non-test) payments released | 6 | 15 | 30 |
| Value moved: mainnet USDC | $40 | $150 | $400 |
| Value moved: testnet USDC | n/a | $2,000 | $10,000 |
| Distinct payees paid | 3 | 6 | 12 |
| Blast Radius audits run for third parties | 3 | 8 | 20 |

> *(v2, INV-17)* Challenge attempts, house attackers and demo tenants are **never** counted in the rows above. `public_pilot_stats` filters `tenants.kind='pilot'` by construction.

## 8. Mapping to the judging rubric

| Criterion (weight) | What we show | Honest risk |
|---|---|---|
| **Agentic sophistication (30%)** | Agent decision surface D1–D6 (`03_AGENT_SPEC.md`): the **Treasury Planner** chooses *when* and *how* to pay inside kernel-feasible plans and is scored (regret vs oracle, simulated) against two baselines; triages, explains (templated), drafts disputes; agent–kernel agreement and human-agreement-on-escalations published; attack suite + **hold-out** where the agent is *fooled* and still can't hurt | A judge may read "kernel decides" as "less agentic." Mitigation: timing/triage/explanation decisions are real, varied, and logged; show cases where the agent **overrode the default timing** with reasons. |
| **Traction (30%)** | Customer zero on mainnet + external pilots + public `/pilot` stats + CLI traction log; delta from baseline recorded today | We start ~12 days after the cohort; cannot out-volume. Win on verifiable realness. |
| **Circle tool usage (20%)** | Dev-controlled Wallets (operator/relayer), USDC (ERC-20 + native gas), Arc Foundry contracts, Compliance Engine screening (if V-01 clears), App Kit/EURC (P2), ERC-8183/8004 (P2) | Don't over-claim: no Gateway/CCTP/USYC in P0. List exactly what is used. |
| **Innovation (20%)** | Evidence-gated release with payee-signed engagements; precision refusal; **Loss Bound Certificate** (a recomputable, self-expiring bound, not a signed promise); **public oracle-scored challenge**; payee-ack witness; the "Six Errors" attack corpus + hold-out protocol as open artifacts | "It's just a validator" is the likely critique; answer with the attack matrix and the bound. |

## 9. Competitive positioning (verified claims only)

| Alternative | What it gives | What it doesn't |
|---|---|---|
| Circle **dev-controlled wallets** | Programmatic custody, signing | No built-in policy engine; docs say enforce in app logic |
| Circle **Agent Wallets** | Per-tx/daily/weekly/monthly limits, allow/blocklists, sanctions screening, MPC custody | Policies are mainnet-only; limits can't see invoice/engagement evidence |
| **arc-escrow** sample | AI-validated deliverable → release/refund | Release gated on a model confidence value; release timestamp unused (per Canteen's analysis) |
| Infra-level guardrail projects from earlier hackathons (e.g., spending limits/whitelists) | Caps and recipient whitelists | Cannot catch right-amount/wrong-payee-within-allowlist, duplicates under new numbers, decimal/locale errors |
| Safe multisig + manual review | Strong control | Not agentic; slow; human attention is the bottleneck |

### 9b. Honest comparison with Circle Agent Wallets (RT-23)

Based only on the Circle documentation we read on 2026-10-09 (`00` §4); re-verify before publishing. We position as **complementary**: Blast Radius Lite accepts an Agent-Wallet-style policy as input and reports its bounds.

| Dimension | Agent Wallets (per Circle docs) | Symbolon |
|---|---|---|
| Custody | 2-of-2 MPC, key shares not exposed to the agent | owner-controlled vault contract; kernel signer is a single key bounded by the vault (disclosed) |
| Limits | per-tx / daily / weekly / monthly; recipient and contract allow/blocklists | per-tx, exact rolling-24 h, optional hourly, per-engagement cap, human-approval threshold, payee binding, time window |
| Screening | sanctions screening on transfers | optional Compliance Engine hook (K-13, if V-01 clears) |
| Availability | mainnet only; policy change needs email OTP | Arc testnet and mainnet; policy changes are on-chain/owner-signed |
| Sees invoice/engagement evidence | not described in the docs we read | yes (evidence-gated release, K-05..K-09) |
| Signed replayable decision receipts | not described in the docs we read | yes (JCS → keccak → EIP-712, anchored in `Released`) |
| Computed, attacked loss bound | not described in the docs we read | yes (certificate + hold-out + public challenge) |
| Maturity | Circle production infrastructure | unaudited hackathon code; mainnet TVL ≤ $200 per vault |

## 10. After the hackathon (for the "what happens next" question)

Open-source `kernel-core` + `receipts` + `attack-suite` (the "Six Errors" benchmark) under Apache-2.0; hosted control plane (engagement management, evidence collectors, approvals, audit exports) priced per business/month; Blast Radius as the free top-of-funnel audit. Canteen's FAQ promises funding/grants/partnership support to teams who keep going; say so in the submission.
