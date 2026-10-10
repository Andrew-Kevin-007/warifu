# 08 — BLAST RADIUS (calculated maximum loss for an agent's spending authority)

> **v2 delta.** The numbers computed here are packaged as a **Loss Bound Certificate** that anyone can recompute and that goes STALE on change (`16`). `bounds.ts` is the single implementation (CLI, API, UI sliders, simulator oracle). Language rule (DEC-012): "calculated from on-chain state and empirically tested", never "proven". Availability caveat added (§4, §12).
>
> **Claim we make:** *under stated threat models and assumptions, the maximum loss is X, derived in closed form and validated by ≥ 500 differential T3 trials against the real contract and ≥ 200 T1 red-team plans against the real kernel. The best attack we found extracted Y (tightness Y/X).*
> **Claim we do NOT make:** that the agent can't be fooled, that evidence is un-fakeable, or that the work was good. Symbolon bounds *who* is paid, *how much*, and *how fast*, not *quality of work*.

## 1. Why this is worth building
Tameion FAQ Q4: autonomy should be "bounded by something it cannot talk its way past." Owners can't act on "it has guardrails." They can act on **"$200 per rolling day; vault empty in 1 day; you need detection within N hours."** Blast Radius turns guardrails into a number, and the *validation loop* (LLM red-teamer vs deterministic checker vs real contract) is the research artifact.

## 2. Definitions
- **Authorized set `A`**: payments `(payee, amount)` that the owner's signed engagements and satisfied evidence/approvals entitle.
- **Loss**: value transferred outside `A` (wrong payee, wrong amount, early/unevidenced, duplicate).
- **Exposure**: value an attacker could cause to move *within* `A`'s payees but without entitlement (e.g., premature payment to a registered payee).
- **Horizon `t`**: the time before detection/pause (1 h, 6 h, 24 h, 48 h, 7 d). Formally the **half-open** interval `[T, T+t)` (`16` §2.2): the vault's rolling window excludes a release exactly 24 h old, so releases at `T` and `T + 24 h` are both legal and a *closed* 24 h interval would contain two daily windows.

## 3. Threat models

| ID | Compromised | Attacker capability | In scope |
|---|---|---|---|
| **T1** | LLM extractor + web app (and its kernel service token) | submit arbitrary documents/intents/evidence uploads; observe outputs | yes |
| **T2** | Relayer (Circle API key/wallet) | submit, delay, drop, or reorder already-signed txs; cannot forge attestations | yes (liveness) |
| **T3** | **Kernel signer key** (and kernel service, relayer, guardian) | sign arbitrary `Attestation`s; submit any tx; pause | **yes (headline)** |
| T3c | T3 **+ colluding registered payee** | as T3, and the beneficiary is the attacker | yes (worst case) |
| T4 | Owner key | owns the vault | **out of scope** (loss = balance); recommend multisig/hardware key |
| T5 | Payee key | receives *authorized* funds; cannot alter engagement alone | out of scope |

## 4. Closed-form bounds

### Inputs
`B` vault balance · `P` perTxCap · `D` dailyCap (**exact rolling 24 h**) · `H` humanThreshold · `N=64` max releases/24 h · `hc` hourlyCap (0 = disabled; P1) · engagements `i` with remaining capacity `R_i = cap_i − released_i` and window `[s_i, e_i]` · policy values for kernel-level caps.

### T3 (signer compromised; no owner approval available)
- Per-release limit without owner approval: `p* = min(P, H)` (amounts `> H` need an owner signature the attacker lacks).
- Per rolling day: `d* = min(D, N·p*)`.
- Loss over an interval of length `t`: since any interval of length `t` is covered by `⌈t/24h⌉` rolling windows,
  **`L_T3(t) ≤ min( B, d*·⌈t/24h⌉, Σ_i R_i[active in interval] )`**.
  With `hc > 0`: additionally `≤ min(…, hc·⌈t/1h⌉)`, which matters for `t < 24 h`.
- **Burst note:** for `t ≤ 24 h`, the bound is `min(B, d*, ΣR)`: **the whole daily cap can leave in minutes.** (Rolling caps limit volume, not rate.) This is the loophole the red-team loop should discover and the P1 `hourlyCap` fixes (see §8).
- **Beneficiary:** funds go only to registered payees. If payees are honest, *attacker-extractable* = 0 and the number above is **owner-exposed** (premature/unentitled payments to legitimate payees). Under **T3c** (colluding payee) extractable = the same bound. Headline uses T3c.
- **Cannot do under T3** (tested): create a payee, raise caps, withdraw, exceed `perTxCap`/`dailyCap`, reuse an `intentId`, exceed an engagement cap, pay outside the engagement window, pay above `H` without owner approval.
- **Availability (not loss), v2 / RT-29:** under T3 the attacker can fill the 64-slot ring with dust releases to a registered payee and block legitimate payments for up to 24 h. This is reported in the certificate as an availability note; mitigation is guardian `pause()` plus signer rotation.
- **Outstanding owner approvals** (signed `OwnerApproval`, unused, before `deadline`) can be consumed by a compromised signer; they are owner-authorized amounts and are stated as a note, not added to the bound.
- **Semantics for the certificate** (horizon meaning, `sumRemaining` without a `start` filter, `binding` terms, alarmed variant parameter) are fixed once in `16` §2.2.

### T2 (relayer)
`L_T2 = 0` (cannot alter payee/amount; vault pays `e.payee`). Liveness: can censor/delay. Attestation `deadline` (10 min) limits stale-attestation replay. Owner can switch relayer instantly (anyone can submit).

### T1 (agent/web compromised; kernel honest)
- Unauthorized loss `= 0` **under assumption A-EVID** (evidence collectors report truthfully about the world).
- **Evidence-strength exposure:** classify each milestone's evidence spec:
  | Strength | Spec contents |
  |---|---|
  | STRONG | `OWNER_ACK`; `CI_PASS` with pinned commit SHA |
  | MEDIUM | `ARTIFACT_HASH` (payee must produce the exact bytes) ; `CI_PASS` on a branch ref |
  | WEAK | `URL_HEALTH` without `contentSha256`; empty spec with `allowOwnerOverride` unset |
  `Exposure_T1(milestone) = amount` if its spec is only WEAK (anyone controlling the URL can satisfy it), else 0. Report `Σ weak-evidence amounts` and say which milestones to harden. (Honest limitation, visible in the UI.)
- First payment to a new payee is always human-gated (K-12), so a T1 attacker cannot get a *new* payee paid even with weak evidence.

### Kernel-vs-vault consistency
Report **both** layers:
- Kernel policy values `p_k ≤` vault values `p_v`, else the policy is decorative → flag **POLICY_LOOSER_THAN_VAULT** (kernel refuses to boot per K-12, but Blast Radius also flags it for third-party audits).
- **T1 bound uses policy; T3 bound uses vault.** The report shows both numbers side by side.

### Time-to-empty and required detection
`TTE = ⌈B/d*⌉ days` (and minutes if burst-limited). Output: *"To keep loss under `$Z`, you must detect and pause within `h` hours"* where `h = max{ t : L_T3(t) ≤ Z }`. Detection sources: K-15 unknown-release alarm (any `Released` without a decision) → guardian `pause()` after at most one poll (60 s) plus the pause transaction and a finality margin, i.e. the published `detectionLatencySeconds` (default 300 s, `16` §2.2), so **practical T3 loss ≈ burst until first alarm**, bounded by the certificate's alarmed figure `boundT3c(i, detectionLatencySeconds)`; quote a one-minute figure only if that parameter is set to 60 s. Report this as the *"alarmed"* variant, assuming the monitor and guardian are not also down (assumption A-MON).

## 5. Differential validation (what makes the number credible)

### 5.1 T3 simulator vs real contract
`packages/blast-radius/src/t3-sim.ts`: deploys the **real** `SymbolonVault` on `arc-anvil`; random configs `(B, P, D, H, N, caps, windows)`; attacker strategies: greedy (max extraction at t=0, then each window), random-timing, boundary-timing (t = window ± 1 s), 64-slot saturation, many tiny releases, mixed approved/unapproved, repeated `intentId`, unregistered payees, post-expiry. Time via `evm_increaseTime/evm_mine`. Measure: max extracted in any half-open window `[T, T+t)` for **every certificate horizon** (1 m, 1 h, 6 h, 24 h, 48 h, 7 d), sliding over the whole attack schedule; the schedule includes releases at exactly `T` and `T + 24 h` and at `T + 24 h − 1 s`.
**Assertions:** (1) `measured ≤ bound` for all trials (a violation = *bound or contract is wrong*: fix and keep the failing seed as a regression test); (2) **tightness**: best greedy attack ≥ 95% of the bound in ≥ 90% of random configs (if not, the bound is loose: tighten the math or explain).

### 5.2 T1 red-team loop (LLM adversary vs real kernel)
`packages/blast-radius/src/redteam.ts`:
1. **Proposer** (Claude, higher-capability model): given `policy.yaml`, engagement/milestone summary, vault config, and the *names and one-line descriptions* of K-01..K-16 (not their code or tests), emit `AttackPlan[]` as JSON:
   ```ts
   AttackPlan = { name, hypothesis, targetCheck?: 'K-xx', steps: Array<
       | {op:'doc', template: string, params: Record<string,string>}
       | {op:'evidence', kind: string, claim: string}
       | {op:'time', advanceSeconds: number}
       | {op:'intent', overrides: object}
       | {op:'approval', forged: boolean}>, expectedLoss: boolean }
   ```
2. **Mutators** (programmatic, 50+ plans): cap ±1 base unit; per-payee velocity edges; amounts that are exact multiples of 10^12; separator variants; duplicate intent with case-changed addresses; timestamps at `start`/`end` ± 1 s; 64th/65th release; evidence with stale timestamps; approvals with swapped amount.
3. **Executor** runs each plan against the real kernel + local vault, recording `loss`, `checksFired`, `finalVerdicts`.
4. **Gate:** `unauthorizedLoss == 0` for every plan. Any success is a **bug**: file ticket, fix, add to regression corpus.
5. **Coverage matrix:** which checks fired for how many plans. Checks that **never** fired are untested paths: add targeted plans or delete dead code.
6. **N ≥ 200 plans (floor), 1,000 (target)**; report seeds, model IDs, prompt hashes.
7. *(v2)* **Provenance of the numbers.** Every results file carries `{gitSha, seed(s), modelIds, promptHashes, vaultRuntimeCodeHash (immutables zeroed), solc/foundry versions}`; the certificate's `validation.codeMatch` uses that hash (`16` §5.3). Results produced against a different bytecode are shown as "not validated for this deployment".

### 5.3 Report schema (`blast_reports`; also rendered in UI)
```json
{
  "tenant": "edith-studio", "policyHash": "0x…", "vault": {"B":"200000000","P":"100000000","D":"200000000","H":"50000000","N":64,"hourlyCap":"0"},
  "threatModels": {
    "T1": {"unauthorizedLossBound":"0","weakEvidenceExposure":"30000000","assumptions":["A-EVID"]},
    "T2": {"lossBound":"0","liveness":"censorable"},
    "T3c": {"bound24h":"200000000","bound7d":"200000000","tte":"1d","burstLimited":true,"alarmedLoss":"…"}
  },
  "validation": {"t3Trials": 500, "t3Violations": 0, "t3BestAttack24h":"200000000", "tightness":1.0,
                 "t1Plans": 240, "t1Losses": 0, "coverage": {"K-06": 61, "K-12": 44}},
  "recommendations": [{"id":"R-HOURLY","text":"Add hourlyCap = D/8 → 1 h loss bound 25 USDC","delta":{"bound1h":"25000000"}}]
}
```

> *(v2)* `blast_reports` rows reference the certificate generated from the report (`certificates.cert_hash`). The JSON above is an intermediate artifact; the certificate (`16` §3) is the public, hash-bound form.

## 6. UI (`/blast-radius`)
- **Headline card:** *"If the AI is fully compromised: $0 unauthorized loss (assuming evidence integrity). If the kernel key is also stolen: up to $X in the first day; vault empty in D days. Validated by N trials; best attack found $Y."*
- Threat-model table, evidence-strength table (milestones with WEAK evidence highlighted), policy-vs-vault consistency, **what-if sliders** (edit `D`, `P`, `H`, `hourlyCap` → instant client-side recompute using the *same* package code; "Run validation" triggers server trials).
- "Assumptions & limits" panel (always visible, A-EVID, A-MON, A-OWNER-KEY, model fidelity).
- Export JSON/PDF; permalink per report. *(v2)* A link to `/certificate/[vault]` and the `pnpm lbc verify` command; sliders use `bounds.ts` and never mutate a published certificate.

## 7. Blast Radius Lite (public free audit; traction lead-gen; closed-form only)
`/blast-radius/audit`: user pastes numbers for **their** agent wallet setup (balance, per-tx, daily/weekly/monthly limits, allow/blocklist usage, human-approval threshold, number of keys/roles). *(v2, RT-23)* A second input mode accepts an **Agent-Wallet-style policy JSON** (per-tx / daily / weekly / monthly limits, recipient and contract allow/blocklists) and reports the same bounds; this positions Symbolon as complementary to Circle Agent Wallets. The page is also the CTA for challenge participants (`09` S6). Lite output is **not** a certificate (no chain state is read) and says so. Output: closed-form bounds under **both** window interpretations (rolling vs calendar; the calendar-bucket case shows the **2× boundary effect**), time-to-empty, detection requirement, and a "questions you must answer" list (do approvals/allowances/contract calls count against limits? can funds hop to sibling wallets? who holds the policy-change key?).
- **No access to anyone's wallet.** Inputs are numbers only; stored only with consent for aggregate stats (`audits run` is a traction metric reported **separately** from "businesses onboarded").
- Do **not** audit or publish findings about third-party systems without their consent.

## 8. Patch loop (the demo story)
1. Run Blast Radius on the v1 vault. Expected discovery: **burst extraction**: entire `D` leaves in one minute (bound for `t=1 min` = `min(B, d*)`).
2. **Patch (P1, WP-08):** add `hourlyCap` (same ring buffer, `sum(last 1h) ≤ hourlyCap`); redeploy to testnet; rerun. `hourlyCap` is a constructor parameter and there is no setter (`06` A.4), so this is a **new vault and a new certificate**; the v1 vault's certificate does not carry over.
3. Show bound for `t=1 h` dropping (e.g., $200 → $25) with trials re-validated, and the **failing seed** (if any) kept as a regression test.
4. In the video: *"Blast Radius found a loophole in our own vault. We patched it. The number went from X to Y."* (Use real numbers only; if the red-team finds nothing, say so and show the coverage matrix instead.)

## 9. Agent Wallet probe mode (P2; mainnet; **human-in-loop**)
Circle Agent Wallet policies are mainnet-only and each change needs an email OTP (not swarm-automatable). With explicit owner consent and **≤ $2 total**, a human can run a probe checklist and record *observed* behavior only (V-07):
1. transfer above per-tx limit (expect block); 2. split transfers to exceed daily (cumulative block?); 3. `approve` allowance to a non-blocklisted contract: does it count?; 4. contract call through an allowlisted forwarder; 5. x402 payment vs transfer accounting; 6. hop to a sibling wallet/chain.
Any surprising bypass is reported **to Circle first** (responsible disclosure) and not published before they respond. The output feeds the Lite audit's "questions you must answer."

## 10. Work plan (see `10_SWARM_PLAN.md` WP-25, WP-26, WP-08)
| Step | Output | Gate |
|---|---|---|
| Closed-form module + unit tests (property tests on monotonicity: tightening any cap never increases the bound) | `packages/blast-radius/src/bounds.ts` | G3 |
| T3 simulator on anvil with ≥ 500 random configs | `t3-sim.ts`, results JSON | G3 |
| Red-team loop ≥ 200 plans, coverage matrix | `redteam.ts` | G4 |
| UI + Lite audit | `/blast-radius`, `/blast-radius/audit` | G4 |
| Patch loop (`hourlyCap`) + rerun + video capture | contract + report diff | G5 |
| *(v2)* Loss Bound Certificate build/verify/CLI/API/UI (`16`; WP-34) | `packages/blast-radius/src/lbc/*`, `/certificate/[vault]` | G4 |

## 11. Kill criteria for this module
If by **Gate G3 (Mon Oct 12 night)** (a) the closed form can't be validated within the tightness target and (b) the simulator can't run on anvil, **demote Blast Radius to closed-form + what-if UI only** and drop the red-team loop; keep the ATK-17 contract tests as the evidence. The module must never block Symbolon's core path. *(v2)* The certificate is part of the v2 spine, so on demotion it is still issued from the closed form with `validation.t3Trials = 0` and rendered as "not empirically validated for this deployment"; the claim language drops "empirically tested" accordingly (INV-18 / `claims:lint`).

## 12. Honest limitations (must appear in the report UI and README)
- Bounds hold **under the modeled semantics**; they are not formal proofs of the Solidity or of Arc.
- Evidence integrity (A-EVID) is assumed; weak evidence is highlighted, not solved.
- Detection/pause assumptions (A-MON) matter for the "alarmed" number.
- Owner-key compromise is out of scope.
- LLM red-teaming finds bugs; it does not prove their absence.
- *(v2)* Availability is not bounded (ring-buffer dust fill, relayer censorship).
- *(v2)* Token behavior (issuer freeze/blocklist/depeg), chain halts or deep reorgs, and RPC dishonesty are outside the bound (assumptions A-TOKEN, A-CHAIN in `16` §4).
- *(v2)* "Proven", "guaranteed", "audited" must not appear in any claim about these numbers unless an external audit exists and is linked.
