# SYMBOLON — START HERE

> **The agent proposes. The evidence disposes.**
> An evidence-gated treasury kernel for AI agents that move a business's money on Arc, plus **Blast Radius**, a pre-flight that computes (and empirically tests) the maximum loss if the agent is fully compromised.
>
> **v2 spine (say it exactly like this, everywhere): _Don't trust the agent. Bound it. Prove it. Invite attack._**
> *Bound it* = evidence-gated kernel + on-chain vault. *Prove it* = Loss Bound Certificate anyone can recompute (`16`). *Invite attack* = the public "Break the Treasurer" challenge (`15`). The agent also does real work: the **Treasury Planner** chooses payment timing/discounts inside kernel-feasible plans (`03` §5).

Hackathon: **Tameion Agents Hackathon** (Canteen × Circle × Arc). Builder: Kevin Andrew, solo, with an agent swarm.
Doc set v1 generated: Fri 2026-10-09, ~11:30 IST. **v2 (this set): Sat 2026-10-10.** v2 supersedes v1 wherever they differ; every change is listed in `docs/CHANGES_V2.md`, and the red-team that drove it is `14_RED_TEAM_V2.md`. If you already fed v1 to Claude Code, run `kickoff/V2_RECONCILE.md` first.

---

## 0. The clock (do not lose this)

| Item | Value |
|---|---|
| Official deadline | **Sat 2026-10-17, 11:59 PM ET** = **Sun 2026-10-18, 09:29 IST** (EDT is UTC-4 in mid-October) |
| Luma page disagrees | Luma says "Sept 27 – Oct 10, two-week". It is almost certainly recycled Agora/Lepton copy, but **confirm with @kdrohan in the Canteen Discord today** (question #1 below). |
| Working deadline (ours) | **Sat 2026-10-17, 22:00 IST final submit** (≈11.5 h buffer). **v1 submitted by Fri 2026-10-16 evening IST.** The form allows unlimited resubmits: submit early, then improve. |
| Time available | From **Sat 2026-10-10 15:00 IST**: ~7.8 days = ~186 h wall-clock. Plan for ~100 productive swarm-hours + Kevin's review/ops time. (v1 assumed Fri 16:00 start; the calendar in `10` §2 is re-based in v2.) |
| Submission needs | public GitHub repo, <3 min recorded video (Loom/YouTube/Vimeo), live URL (strongly encouraged), traction answers (businesses onboarded, value moved, problem solved). |
| Scoring | Agentic sophistication 30 · Traction 30 · Circle tool usage 20 · Innovation 20. Judges have final say. Judging is asynchronous: **a reviewer clicks around without you in the room.** |

---

## 1. One-paragraph pitch

AI agents that read invoices and move money fail in ways a ledger cannot see: wrong payee, duplicate-on-retry, a decimal truncated, a swapped wallet address inside a PDF. Canteen's own essay *Agents and Ledgers in 2026* says the fix is to treat model output as an **input, never the release condition**, and to check entries against **evidence outside the ledger**. Circle's developer-controlled wallets ship with **no policy engine** (the docs tell you to enforce controls in your own application logic), and Circle's Agent Wallet caps/allowlists cannot see evidence. **Symbolon is that missing policy engine**: an LLM agent extracts and proposes; a deterministic kernel decides; an on-chain vault enforces it, so even a fully compromised agent *and* a compromised kernel are bounded by a number we compute and test (Blast Radius). Every release carries a signed, replayable decision receipt anchored on Arc.

**v2 additions in one paragraph.** (1) A **Loss Bound Certificate** states the maximum that can leave a vault per time horizon under named threat models and assumptions; it is a deterministic recomputation from public chain state (`pnpm lbc verify <vault>`), never "trust our signature", and it goes **STALE** automatically when the configuration changes (`16`). (2) A public, testnet-only **"Break the Treasurer"** challenge with a ground-truth oracle, separate infrastructure and no cash prize turns our attack suite into something a judge can try in 30 seconds (`15`). (3) A **Treasury Planner** gives the LLM real work: choosing among kernel-feasible plans (early-pay discounts, timing), with economics computed by a deterministic evaluator and terms accepted only from the signed engagement (`03` §5, `04` K-08/K-14). (4) Honest evaluation: three baselines (B0 = Circle's real arc-escrow logic, B1 naive, B2 hardened) and a hold-out attack set whose seed hash is committed first (`07`, DEC-015). (5) Judge-day resilience: every judge-facing page has a no-backend **replay mode** (DEC-016). (6) Swarm hygiene: model/effort routing per role (`17`), a SEC role, secrets deny-rules (DEC-017).

---

## 2. Reading order

| # | File | Read it when |
|---|---|---|
| 00 | `00_START_HERE.md` | now |
| 01 | `01_PRD.md` | product scope, personas, success metrics, scoring map |
| 02 | `02_ARCHITECTURE.md` | system design, trust boundaries, invariants, threat model |
| 03 | `03_AGENT_SPEC.md` | the LLM side: extraction, timing, explanation, guardrails |
| 04 | `04_KERNEL_SPEC.md` | the deterministic side: 16 checks (K-01..K-16), verdict algebra |
| 05 | `05_DATA_MODELS_AND_API.md` | schemas, SQL DDL, API contracts, receipt format |
| 06 | `06_CONTRACTS_AND_CIRCLE.md` | `SymbolonVault.sol`, EIP-712 types, Circle/Arc integration |
| 07 | `07_ATTACK_SUITE.md` | 24 attacks (ATK-01..24) + hold-out set, baselines B0/B1/B2, honest corpus, metrics |
| 08 | `08_BLAST_RADIUS.md` | max-loss model, red-team loop, differential validation (feeds the certificate) |
| 09 | `09_TRACTION_AND_PILOTS.md` | how to get real users in 8 days; honesty rules; CLI logging |
| 10 | `10_SWARM_PLAN.md` | **work packages, waves, agent briefs, file ownership, schedule** |
| 11 | `11_DEMO_AND_SUBMISSION.md` | video script, README skeleton, submission checklist |
| 12 | `12_RISKS_AND_GATES.md` | risk register, decision gates, cut lines, kill criteria |
| 13 | `13_TEST_PLAN.md` | test pyramid, CI, SEC suite, independent verification protocol |
| 14 | `14_RED_TEAM_V2.md` | **v2** 33 findings (RT-01..33) against the evolved idea, with fixes and where they land |
| 15 | `15_CHALLENGE_SPEC.md` | **v2** "Break the Treasurer": scenarios, oracle, isolation, abuse controls, replay bundles |
| 16 | `16_LOSS_CERTIFICATE_SPEC.md` | **v2** Loss Bound Certificate: algorithm, schema, verification, staleness, language rules |
| 17 | `17_MODEL_AND_EFFORT_ROUTING.md` | **v2** which Claude model/effort per role and per WP; where `ultracode:` is allowed |
| — | `CHANGES_V2.md` | **v2** what changed from v1, breaking changes, schemas delta, what Kevin must do (read this first if you used v1) |
| ★ | `AGENTS.md` | copy to repo root (also as `CLAUDE.md`). Rules every agent must obey. |

Swarm entry point: **`10_SWARM_PLAN.md`** + **`AGENTS.md`** + **`17_MODEL_AND_EFFORT_ROUTING.md`** (launch each lane with the MODEL/EFFORT printed at the top of its `kickoff/WP-nn_*.md`).

---

## 3. Decisions log (frozen unless a gate in `12_RISKS_AND_GATES.md` fires)

| ID | Decision | Why |
|---|---|---|
| DEC-001 | Build **Symbolon**; **Blast Radius** ships inside it as the pre-flight screen. One submission, two ideas, one codebase. | Both orbit the organizers' stated hard question (autonomy bounded by something the agent cannot talk past). The policy file enforced by the kernel is the same file Blast Radius analyzes, so marginal cost is low. |
| DEC-002 | **TypeScript everywhere.** No Rust in the hackathon build. | 8 days. Every Circle/Arc reference sample (arc-escrow, arc-fintech) is TypeScript/Next.js/Supabase, so agents can lift working code. A Rust port of `kernel-core` is a post-hackathon item. *(This corrects my earlier "Rust on Workers" suggestion.)* |
| DEC-003 | Write our own **`SymbolonVault.sol`**; do **not** fork `RefundProtocol.sol`. Reuse scaffolding (Next.js/Supabase/wallet-generation scripts) from arc-escrow/arc-fintech, Apache-2.0, with attribution. | The article's critique of arc-escrow is that release hinges on a model confidence string. Our contract design is different in kind. Judges grade the **delta**, so scaffolding reuse is fine if disclosed. |
| DEC-004 | **Developer-controlled wallets** (relayer/operator) + our vault/kernel as the policy engine. **Agent Wallets are not in the core path.** | Docs: dev-controlled wallets have no built-in policy engine. Agent Wallet spending policies are **mainnet-only** and each policy change needs an email OTP (not swarm-automatable). Agent Wallet analysis is a P2 Blast Radius mode. |
| DEC-005 | Two deployables: **`apps/web`** (UI + LLM extractor; **zero Circle/signing secrets**) and **`services/kernel`** (all secrets). | "The LLM has no keys and no network path to the wallet" must be demonstrable, not asserted. A CI test asserts web env has no secrets. |
| DEC-006 | **Testnet-first**; mainnet only for pilot payments, **vault TVL ≤ $200 each**, after Gate G3. | Arc mainnet is live (Sept 16, 2026) and the rubric says mainnet counts more, but our contract is unaudited hackathon code. |
| DEC-007 | Extractor runs **two different Claude models** and requires agreement (default `claude-sonnet-5-5` + `claude-haiku-5-5`, configurable). | Cheap variance reduction; disagreement becomes an ESCALATE signal (K-10). |
| DEC-008 | No yield/USYC, no cross-chain, no swaps in P0. | USYC docs page 404'd (access unverified); focus. EURC lane is P2. |
| DEC-009 | Receipts = **RFC 8785 (JCS) canonical JSON → keccak256 → EIP-712 signature by kernel signer**; hash emitted in the vault `Released` event. | Replayable by anyone; no custom crypto. |
| DEC-010 | Traction is logged daily to **our DB and via `arc-canteen update traction`**; baseline recorded **today**. No wash trading, ever. | The CLI feeds Canteen/Circle's view of traction and "delta" (what changed during the event). See `09_TRACTION_AND_PILOTS.md`. |
| DEC-011 *(v2)* | One spine, one sentence: **"Don't trust the agent. Bound it. Prove it. Invite attack."** The video, README top screen, `/judge` page and form answers all lead with it. Anything that does not serve a word in that sentence is P1/P2. | RT-24 narrative overload; a skimming async judge needs one idea. |
| DEC-012 *(v2)* | Loss bounds are **"calculated from on-chain state and empirically tested"**, never "proven/guaranteed/audited". Certificates always list assumptions and exclusions above the number; `pnpm claims:lint` enforces the wording. | RT-18/21: "provable" invites a one-line takedown. |
| DEC-013 *(v2)* | The public challenge is **testnet-only, no cash prize, no mainnet challenge vault**, on a **separate deployment** (service, DB project, signer, relayer, vault, LLM key, origin), with a ground-truth oracle that defines "loss". | RT-05/06: a deliberately attackable surface must not share anything with real funds. |
| DEC-014 *(v2)* | **Treasury Planner:** the LLM chooses among **kernel-feasible plans**; a deterministic evaluator does the economics; payment terms are accepted **only from the dual-signed engagement** (`termsHash`-bound); results on the planner corpus are labelled **simulated**. | RT-15/16/17: terms injection, "it's just arithmetic", dishonest savings. |
| DEC-015 *(v2)* | Evaluation honesty: baselines **B0** (real `circlefin/arc-escrow` decision path, pinned commit, only network edges stubbed; fallback B1 if it cannot be vendored in 3 h), **B1** (naive reimplementation, labelled ours), **B2** (reasonable hardening); plus a **hold-out set** from an independent adversary agent, seed hash committed before tuning; report n, k, rule-of-three upper bound. | RT-07/08: overfitting and strawman baselines. |
| DEC-016 *(v2)* | **Replay mode:** every judge-facing surface renders from a recorded, verifiable bundle (`RECORDED` watermark) when the backend/RPC/LLM/budget is down; deploy freeze after Sat Oct 17 22:00 IST. | RT-11: judges open the app days later. |
| DEC-017 *(v2)* | **Swarm hygiene:** agents never get real keys; fetched/untrusted content is data not instructions; `.env*` secrets denied in `.claude/settings.json`; pnpm lifecycle scripts allow-listed; new role **SEC**; **model/effort routing per `17`** (Opus 5.5 xhigh for money-critical roles, Sonnet 5.5 for scoped work, `ultracode:` only for named verification passes, never `max`). | RT-26: the swarm is an attack surface; usage limits are the binding constraint. |
| DEC-018 *(v2)* | **Scope cuts:** WP-30 (P1 extras) and WP-31 (P2) are **demoted until after G4**; ERC-8183 stays default NO-GO; Agent Wallet probe stays human-in-loop and optional. New P0 work is WP-32..39. | RT-25/27: more features lose to fewer, deeper, verified ones. |

---

## 4. What was verified vs. what is assumed

**Verified from primary sources on 2026-10-09:**
- Arc **mainnet public launch: Sept 16, 2026**; USDC is the native gas token; sub-second deterministic finality.
- `docs.arc.io` EVM-differences note: **USDC uses 18 decimals natively (not 6)**; a system emitter logs all USDC Transfer events; mempool enforces a **20 Gwei `maxFeePerGas` floor**; **blocklist reverts consume gas without a receipt**; **`address(0)` sends revert**. *(Read `https://docs.arc.io/arc/references/evm-differences.md` before touching amounts.)*
- **Arc Foundry** (`arc-forge`, `arc-cast`, `arc-anvil`) is the supported contract toolchain.
- Circle **dev-controlled wallets** have **no built-in policy engine**; you enforce restrictions in app logic. EOA wallets suit "can hold native token for gas."
- Circle **Agent Wallets**: 2-of-2 MPC, key shares never exposed to the agent; transfers sanctions-screened; policies = `per-tx / daily / weekly / monthly` limits plus `recipient-allowlist|blocklist` and `contract-allowlist|blocklist`; **mainnet only; OTP to change**.
- `arc-canteen` CLI: `login`, `wallet` (testnet wallet funded $5 USDC), `rpc`, `context sync`, **`update traction`**, **`update product`**, `submit-showcase`, `submit-puzzle`.
- Reference samples: `circlefin/arc-escrow` (Next.js, Supabase, dev-controlled wallets, OpenAI validation, `@circle-fin/smart-contract-platform`, webhook at `/api/webhooks/circle`, Node 22+), `circlefin/arc-fintech` (Next.js, Supabase, App Kit, EarnKit, Gateway, **Compliance Engine screening**, vitest).
- Arc docs index lists: Memo contract (metadata on a contract call preserving sender), Multicall3From batching, EIP-3009 gasless relayer, ERC-4337 paymaster, ERC-8004 agent identity, **ERC-8183 jobs** (escrow + deliverable hash) on testnet.

**Unverified. Every agent must log resolution in `docs/VERIFY_LOG.md` (see `AGENTS.md`):**
- V-01 Compliance Engine access for our API key/testnet and its exact API.
- V-02 Whether dev-controlled wallets support EIP-712 `signTypedData` (decides kernel-signer custody; default is an env-held key, disclosed).
- V-03 Arc mainnet `CIRCLE_BLOCKCHAIN` identifier and mainnet RPC/explorer; Circle mainnet key setup.
- V-04 ERC-20 USDC decimals on Arc vs native 18 (**expected 6 for the ERC-20 interface; verify**).
- V-05 ERC-8183 semantics and mainnet availability (P2 evaluator adapter).
- V-06 USYC permissioning (excluded from scope; irrelevant unless P2).
- V-07 How Agent Wallet limits treat `approve`/allowances/contract calls (P2 probe).
- V-08 Exact fields of `arc-canteen update traction/product`.
- V-09 Who the judges are, and whether they see CLI traction events.
- V-10 *(unused; number reserved so references stay stable)*
- V-11 Whether Circle's contract-execution API accepts **pre-encoded `callData`** for `release(...)` (struct argument) or needs `abiFunctionSignature` + `abiParameters` (tuple encoding); log the exact working call (`06` B.2).
- V-12 Circle webhook **notification-signature scheme** (headers, algorithm, public-key retrieval via `CIRCLE_WEBHOOK_PUBLIC_KEY_ID`) and whether a timestamp is signed (needed for the replay window, RT-30).
- V-13 Whether Arc testnet/mainnet RPC serves **archive state** for old blocks (decides whether `pnpm lbc verify --block N` can recompute at the stated block or falls back to digest equality, `16` §5.2).
- V-14 Exact model aliases and spend/usage limits for the Anthropic key used by the sandbox challenge (provider-side cap), and that `opus`/`sonnet` in Claude Code resolve to Opus 5.5 / Sonnet 5.5 on the user's plan (`17` §2).

---

## 5. Questions to ask in the Canteen Discord today (copy-paste)

1. "Tameion Luma says Sept 27–Oct 10, the site says Oct 17 11:59 PM ET. Confirming Oct 17 is the real deadline?"
2. "Is traction judged from `arc-canteen update traction` logs, the submission form, or both?"
3. "Does Circle Compliance Engine screening work on Arc testnet with a standard console key?"
4. "Is it fine to submit a project that hardens/extends circlefin/arc-escrow patterns and contributes a fix upstream?" *(FAQ says fork-and-remix is welcome; this just buys goodwill.)*
5. "Who are the judges / is there a Circle-side reviewer?"
6. *(v2)* "Is a public testnet-only 'try to break our treasury agent' challenge (no prize, separate infra, house rules posted) welcome during judging, and does it count as product traction or should we report it separately?" *(We report it separately regardless: INV-17.)*

---

## 6. Wave 0 checklist: Kevin does these **today**, before the swarm starts

```bash
# 1. Canteen / Arc CLI (testnet RPC + traction logging + agent context)
uv tool install arc-canteen          # event page alt: uv tool install git+https://github.com/the-canteen-dev/ARC-cli
arc-canteen login                    # GitHub auth; use the SAME GitHub handle you registered on Luma
arc-canteen wallet                   # creates + funds a testnet wallet ($5 USDC on first run)
arc-canteen shell-init >> ~/.zshrc   # exports $RPC in every shell
arc-canteen context sync             # clones Arc/Circle docs + 5 sample codebases to ~/.arc-canteen/context/
arc-canteen status                   # dashboard (also shows the current "puzzle", an easter-egg lane)
arc-canteen update product           # BASELINE ENTRY: "Starting point: spec only, no code, 0 users"
arc-canteen update traction          # BASELINE ENTRY: 0 businesses, 0 USDC moved

# 2. Circle tooling
npm install -g @circle-fin/cli       # Node >= 20.18.2
#   In Claude Code:  /plugin marketplace add circlefin/skills   then   /plugin install circle-skills@circle
#   Circle MCP server for live SDK signatures/addresses:
#   { "mcpServers": { "circle": { "url": "https://api.circle.com/v1/codegen/mcp" } } }
#   Circle Console: create API key (testnet) + register Entity Secret
#   https://developers.circle.com/wallets/dev-controlled/register-entity-secret
#   Testnet faucet: https://faucet.circle.com

# 3. Arc Foundry (contracts)
#   https://docs.arc.io/arc/tutorials/install-arc-foundry.md   -> arc-forge / arc-cast / arc-anvil

# 4. Accounts / infra
#   GitHub: repo `symbolon` (private until submission, then public; Apache-2.0 or MIT) | Supabase cloud project | Vercel project (web)
#   Railway (or Fly) service (kernel) | Anthropic API key | Loom account
```

Then hand the swarm: repo + `AGENTS.md` + `10_SWARM_PLAN.md`, and start **Wave 1**.

### 6b. v2 additions to Wave 0 (Kevin, ~45 min; none of these is a code task)

```text
1. Sandbox accounts (separate from production, DEC-013/INV-16):
   - 2nd Supabase PROJECT (name: symbolon-sandbox)        - 2nd Vercel project (challenge origin; separate domain)
   - 2nd service instance for the sandbox kernel           - 2nd Anthropic API key with a provider-side monthly spend cap
   - throwaway testnet keys only (kernel signer, relayer, vault owner for sandbox); NEVER reuse a production key
2. Claude Code lanes (see 17): copy `.claude/` from the v2 pack into the repo root; launch each lane with the
   MODEL/EFFORT line printed at the top of its kickoff file (opus xhigh for money-critical lanes, sonnet otherwise).
   Do NOT set CLAUDE_CODE_EFFORT_LEVEL globally. Do NOT use effort `max`. Use `ultracode:` only for the passes in 17 §5.
3. Never paste a private key, seed phrase or Circle entity secret into any chat or any agent session.
4. Run kickoff/V2_RECONCILE.md in your EXISTING Claude Code session before starting any new WP (reconciles repo with v2).
```

---

## 7. Glossary

- **Symbolon**: Greek tally broken in two; the agreement is real only when the halves fit. Here: *agent-proposed intent* (half 1) × *signed engagement + evidence* (half 2).
- **Engagement**: owner+payee co-signed agreement binding payee address, budget cap, milestones, time window.
- **Evidence**: kernel-collected proof for a milestone (CI run, URL health, artifact hash, owner ack).
- **Intent**: structured payment proposal from the LLM extractor.
- **Kernel**: deterministic service that evaluates intents and signs release attestations.
- **Vault**: on-chain contract holding USDC; releases only on a valid kernel attestation to a registered payee within caps.
- **Receipt**: canonical, signed record of a decision (inputs hash, checks, policy version, model IDs), anchored on-chain.
- **Blast Radius**: max loss per time window under a stated threat model, computed and empirically validated.
- **Verdicts**: `RELEASE`, `HOLD`, `ESCALATE`, `REJECT` (and `REPLAY` for exact duplicates).
- **Loss Bound Certificate (LBC)**: JSON statement of the maximum value that can leave a vault per horizon under named threat models/assumptions; recomputable by anyone; goes STALE on change (`16`).
- **Challenge**: the public testnet "Break the Treasurer" game with an oracle that defines loss (`15`).
- **Treasury Planner**: LLM role that picks among kernel-feasible payment plans (discount/timing); economics by a deterministic evaluator (`03` §5).
- **Replay bundle**: recorded, verifiable run set that lets judge-facing pages work with no backend (`15` §7).
- **B0/B1/B2**: baselines for the attack suite (real arc-escrow path / naive / hardened) (`07`).
- **WYSIWYS**: what you see is what you sign; the approval screen renders from the same object that is signed (INV-20).
