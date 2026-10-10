# 04 — KERNEL SPEC (deterministic decision engine)

> `packages/kernel-core` is a pure function library: `evaluate(intent, ctx, policy) → Decision`. Same input ⇒ byte-identical output. No clock, randomness, network, filesystem, env, or LLM. (INV-8, INV-9, INV-10)
>
> **v2 delta (no new K-IDs; existing checks extended):** K-01 (no binary, INV-23) · K-08 (`amountDue` from signed terms) · K-09 (evidence sources: fixtures in sandbox, signed allowlist in production; hardened SSRF guard) · K-12 (escalation budget) · K-14 (terms binding, plan feasibility, discount window). New pure package `packages/terms` (INV-19). New reason codes in §6. Why: `14_RED_TEAM_V2.md` RT-02/03/12/14/15.

## 1. Verdict algebra

| Verdict | Meaning | Money moves? |
|---|---|---|
| `RELEASE` | all checks pass; schedule at `payAt` | yes (after TOCTOU re-evaluation at `payAt`) |
| `HOLD` | waiting on something objective (evidence, liquidity, screening, time) | no; auto re-evaluated when the missing thing changes |
| `ESCALATE` | needs a human (ambiguity, anomaly, above threshold) | no, until owner signs `OwnerApproval` |
| `REJECT` | violates a binding/invariant (wrong payee, over cap, no engagement) | no; alert; never auto-retried |
| `REPLAY` | exact duplicate of an earlier intent | no; returns the original decision |

Severity: `REJECT > ESCALATE > HOLD > RELEASE`. Each check returns `{id, status: PASS|FAIL|SKIP, onFail: REJECT|ESCALATE|HOLD, code, detail, refs[]}`. Final verdict = highest severity among `FAIL`s, else `RELEASE`. `SKIP` is legal only for checks the policy explicitly disables (e.g., K-13 when screening is off) and is shown in the receipt. **A required check that throws ⇒ that check counts as a `HOLD` `FAIL` with code `KERNEL_ERROR`** (so the verdict is `HOLD`, or a higher severity if another check also fails; it is never `RELEASE`).

`REPLAY` is produced only by K-04 and short-circuits the pipeline.

## 2. `KernelContext` (everything the kernel may know; assembled by `services/kernel`)

```ts
KernelContext = {
  now: ISODateTime,                         // injected; kernel-core never reads a clock
  tenantId: UUID, vaultAddress: Address, chainId: number,
  chain: { tokenAddress: Address, tokenDecimals: number },   // verified at deploy (V-04)
  engagement: Engagement | null,            // loaded by (intent.engagementId); must match on-chain registration
  milestone: Milestone | null,
  priorDecisions: DecisionSummary[],        // last 90 d for tenant (by intentId, docHash, payee+invoiceNo, payee+amount)
  released: {                               // INCLUDES decided-but-unsettled amounts (race guard)
    engagementTotal: bigint, tenantDay: bigint, tenantWeek: bigint,
    payeeDay: bigint, payeeCountDay: number, categoryMonth: Record<string, bigint>
  },
  evidence: Evidence[],                     // collected by kernel collectors only
  ownerApproval: OwnerApproval | null,      // signature already verified by service
  screening: { status: 'CLEAR'|'HIT'|'UNKNOWN', checkedAt: ISODateTime, provider: string } | null,
  balances: { vaultAvailable: bigint, pendingReleases: bigint, obligations14d: bigint },
  payeeHistory: { priorPayments: number, onTime: number, disputes: number },
  doc: { hash: Hex32, normalizedHash: Hex32, normalizedText: string, zeroWidthCount: number },  // kernel-stored doc, NOT from extractor
  invoiceReceivedAt: ISODateTime,           // v2: recorded by the kernel when the document was accepted; starts the discount clock (INV-19)
  paymentTerms: PaymentTerms | null,        // v2: from the dual-signed engagement (inside termsHash); null ⇒ policy defaults, no discount
  escalations: { today: number, todayByEngagement: Record<string, number> },   // v2: for the K-12 escalation budget
  profile: 'production' | 'sandbox',        // v2: K-09 evidence mode ('sandbox' ⇒ fixtures only)
  breaker: { halted: boolean, reason: string | null },
  payeeChangePending: boolean
}
```

## 3. Evaluation order

```
K-16 breaker pre-check → K-01 → K-02 → K-03 → K-04 (may REPLAY) → K-05 → K-06 → K-07 → K-08
→ K-09 → K-10 → K-11 → K-12 → K-13 → K-14 → aggregate → build receipt
(K-15 runs post-settlement, asynchronously)
```
Every check runs even after an earlier failure (collect **all** reasons for the receipt), **except** `K-04 REPLAY` short-circuit and `K-01 SCHEMA_INVALID` (nothing downstream is meaningful).

## 4. The checks

### K-01 STRICT_SCHEMA — onFail: REJECT — P0
- Zod `.strict()` parse of `PaymentIntent`; unknown keys fail.
- Amounts: `^(0|[1-9][0-9]{0,29})$` integer strings only. Addresses: valid EIP-55 checksum. Dates: ISO-8601. String lengths bounded (free text ≤ 2,000 chars).
- Codes: `SCHEMA_INVALID`.
- Tests: fuzzed invalid shapes never reach later checks; unknown field rejected.
- *(v2, INV-23)* The kernel-stored document record holds `normalizedText` (UTF-8, ≤ `policy.limits.maxDocChars`, default 20,000; sandbox ≤ 4,096 bytes) and `blobSha256`; the intent references it by `documentId`/`docHash`. `POST /v1/documents` accepts **text produced by `apps/web`** plus an opaque blob that is stored and hashed but **never parsed** by the kernel. Any intent or document field that looks like a binary payload (base64/hex run over the limit, `data:` URIs, invalid UTF-8, NUL bytes) ⇒ `REJECT SCHEMA_INVALID`. The kernel never opens PDFs/images/archives.

### K-02 PRECISION_EXACT — onFail: ESCALATE (ambiguity/mismatch) or REJECT (rounding required) — P0
Targets the *original-entry* error class (article: `6.000000` read as `6.00`) and locale confusion.
Algorithm `parseMoney(printed, currencyHint, declaredDecimals)`:
1. Unicode NFKC normalize; **reject non-ASCII digits** and scientific notation (`1e3`) → `REJECT NON_ASCII_DIGITS|SCIENTIFIC`.
2. Remove currency symbols/codes; treat space, NBSP, thin space, apostrophe as **grouping**.
3. Identify separators `.` and `,`. Rules:
   - both present → the **last** one is decimal, the other is grouping (`1.000,50` → 1000.50; `1,000.50` → 1000.50).
   - one separator, appears once, followed by **exactly 3 digits** → **AMBIGUOUS** (`1.000`, `1,000`) → `ESCALATE AMOUNT_AMBIGUOUS` (unless the doc states its convention elsewhere and `decimalSeparatorGuess` agrees *and* K-08 later matches the milestone exactly).
   - one separator, followed by 1–2 digits or ≥4 digits → decimal (`1,5`; `3.14159`).
   - one separator repeated (`1.000.000`) → grouping.
4. Digits after the decimal separator > `declaredDecimals` → **`REJECT REFUSE_ROUND`** (never round). Fewer is padded.
5. Compare to extractor `parsedBaseUnits`: mismatch → `ESCALATE EXTRACTION_PARSE_MISMATCH`. `parsedBaseUnits=null` → `ESCALATE AMOUNT_AMBIGUOUS`.
6. If line-item amounts are all printed, `Σ lineItems ≠ total` → `ESCALATE LINEITEM_SUM_MISMATCH`.

**Test vectors** (decimals=6): `"1,000.00"→1000000000` · `"1.000,00"→1000000000` · `"1.000"→AMBIGUOUS` · `"1,5"→1500000` · `"6.000000"→6000000` · `"6.00"→6000000` · `"6.0000001"→REJECT REFUSE_ROUND` · `"1 000,50"→1000500000` · `"1'000.50"→1000500000` · `"1e3"→REJECT` · `"١٠٠"→REJECT` · `"$1,000"→ AMBIGUOUS` (lone sep + 3 digits) · `"$1,000.00"→1000000000`.

### K-03 DOC_TYPE_SIGN — REJECT / ESCALATE — P0
Targets *complete reversal*. `docType=INVOICE` required. `CREDIT_NOTE` → `ESCALATE CREDIT_NOTE` (never an outbound payment). `STATEMENT|OTHER` → `REJECT NOT_PAYABLE`. Amount must be > 0 (also enforced in K-01 type).

### K-04 IDEMPOTENCY_DEDUPE — REPLAY / ESCALATE — P0
- `normInvoiceNo = upper(strip non-alphanumerics, strip leading zeros)`.
- `intentId = keccak256(JCS({engagementId, milestoneId, normInvoiceNo, amountBaseUnits, payee}))`, where `amountBaseUnits` is the **gross invoiced** amount (v2: never the discounted `releaseAmountBaseUnits`, `05` §2), so re-quoting a discount or renumbering cannot mint a second valid intent.
- Exact `intentId` seen → **`REPLAY`** returning the prior decision (never a new release). Same `doc.hash` seen with different invoice no. → `ESCALATE DUPLICATE_DOC`.
- Near-duplicate (same payee + same amount within 7 d, different milestone/invoice no.) → `ESCALATE NEAR_DUPLICATE`.
- Same `(engagementId, milestoneId)` already `RELEASED/PENDING` under a different invoice no. → `REJECT MILESTONE_ALREADY_PAID` (covers ATK-20).
- Vault `used[intentId]` is the on-chain backstop.

### K-05 ENGAGEMENT_BINDING — REJECT — P0
- Engagement exists, `status=ACTIVE`, indexed from on-chain `EngagementRegistered` with matching `termsHash`; `now ∈ [start, end]` (**the time-window check arc-escrow's unused timestamp should have been**).
- Milestone belongs to that engagement; status ∈ `PENDING|EVIDENCE_OK`; if engagement is `sequential`, all prior milestones are `PAID`.
- References printed in the invoice are only *hints*; the binding is the engagement referenced by the intent **and** consistent with the payee/amount.
- Codes: `NO_ENGAGEMENT`, `ENGAGEMENT_INACTIVE`, `OUT_OF_WINDOW`, `MILESTONE_ORDER`, `UNKNOWN_MILESTONE`.

### K-06 PAYEE_BINDING — REJECT — P0
- **The payout address is always `engagement.payee`.** A document-provided address is only compared.
- Invoice address present and ≠ engagement payee → `REJECT PAYEE_MISMATCH` + alert (targets ATK-02/10/11).
- `claimsAddressChange=true` → at least `ESCALATE ADDRESS_CHANGE_CLAIMED` (K-11 also fires); address change is possible **only** via the on-chain `PayeeChange` path (old payee + new payee + owner signatures + delay).
- `payeeChangePending=true` → `HOLD PAYEE_CHANGE_PENDING`.
- Name collisions (`Acme Design` vs `Acme Design Ltd`) never matter: names are not authority; addresses bound by signature are.

### K-07 CURRENCY_DECIMALS — REJECT — P0
- Currency must be `USDC` (P0). Print aliases `USD|$|USDC` map to USDC iff `policy.currency.treatUsdAsUsdc`. `EUR` → `REJECT CURRENCY_UNSUPPORTED` (P2 EURC lane).
- `ctx.chain.tokenDecimals` must equal `engagement.currencyDecimals` and vault-stored decimals → else `REJECT DECIMALS_MISMATCH`.
- **Scaling sanity (Arc native 18 vs ERC-20 6):** reject `amountBaseUnits > 10^(decimals+9)` (>1e9 whole units) → `REJECT SCALE_ABSURD`. Amounts are never expressed in native 18-decimal units anywhere in the kernel (`packages/chain` converts at the edge).
- Test vector: expected 5 USDC (`5000000`) vs `5000000000000000000` → REJECT; same value ×10^12 appears in ATK-05.

### K-08 AMOUNT_CONFORMANCE — REJECT (over) / ESCALATE (under) — P0
- Exact equality of the **invoiced (gross)** amount with `milestone.amountBaseUnits` unless `partialAllowed`. *(v2)* The **release amount** must equal `amountDue(payAt)` computed by `packages/terms` from the **signed** `paymentTerms` and the kernel-recorded `invoiceReceivedAt`: inside the early-pay window `gross − floor(gross·discountBps/10000)`, otherwise `gross`. A release amount that differs ⇒ `REJECT OVERPAY` (higher) or `ESCALATE UNDERPAY_PARTIAL` (lower). Invoice-stated discounts never alter `amountDue` (INV-19, ATK-21).
- `amount > milestone.amount` or `Σ released + amount > engagement.cap` → `REJECT OVERPAY`. `amount < milestone.amount` and not partial → `ESCALATE UNDERPAY_PARTIAL?`.
- Per-milestone exactness is what defeats *compensating* errors (ATK-06): overpaying A and underpaying B cannot net out.

### K-09 EVIDENCE_MATCH — HOLD (missing) / REJECT (contradicting) — P0
Milestone `evidenceSpec` is `all_of` over typed requirements; kernel evaluates only **kernel-collected** `Evidence`:

| Type | Collector (kernel-side) | Pass condition |
|---|---|---|
| `OWNER_ACK` | verifies EIP-712 `MilestoneAck(milestoneId, artifactHash?)` by owner | valid signature, fresh (≤ `evidenceFreshnessHours`) |
| `CI_PASS{repo, ref}` | GitHub REST: workflow run for commit SHA/branch | latest run `conclusion=success`, `head_sha` matches `ref` pinned in spec |
| `URL_HEALTH{url, expectStatus, contentSha256?}` | HTTPS GET with **SSRF guard** | status matches; if hash pinned, body hash matches |
| `ARTIFACT_HASH{sha256}` | file uploaded to kernel storage; kernel computes hash | equals spec/ack-bound hash |

- Evidence supplied by the LLM, the payee, or the web app with no kernel collection record is **ignored** (treated as missing). Screenshots are never evidence.
- Missing → `HOLD EVIDENCE_MISSING` (re-evaluated automatically when evidence arrives). Failed/contradicting (CI red; URL 500) → `HOLD EVIDENCE_FAILED`. `evidenceTampered` (hash mismatch) → `REJECT EVIDENCE_HASH_MISMATCH`.
- `ownerOverride`: an `OWNER_ACK` marked `override=true` may satisfy any requirement (human judgment) if `policy.evidence.allowOwnerOverride`.
- SSRF guard *(v2, hardened; RT-02)*: https only, port 443 only, no userinfo in URLs; **resolve DNS once, pin the IP, connect to the IP with `Host`/SNI set**; re-validate on every redirect (max 2; **0 in sandbox**); block all non-global ranges for IPv4 *and* IPv6 (RFC1918, 100.64.0.0/10, loopback, link-local incl. 169.254.169.254, `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped `::ffff:0:0/96`, decimal/octal/hex IP spellings normalized before checking); 5 s timeout; 1 MB body cap; egress only through a deny-by-default proxy. **Domains come from the signed engagement's evidence-spec allowlist, never from the invoice or the intent.** Anything else ⇒ `HOLD EVIDENCE_SOURCE_DENIED`.
- *(v2)* **Sandbox profile (`profile='sandbox'`, `EVIDENCE_MODE=fixtures`):** no outbound fetches at all; evidence exists only if the scenario fixture store holds a record for the exact spec entry; every other reference ⇒ `HOLD EVIDENCE_SOURCE_DENIED`.

### K-10 EXTRACTION_CONSENSUS — ESCALATE — P0
`ctx`/intent consensus must be `AGREE` on payee wallet, `amount.printed`, `parsedBaseUnits`, `invoiceNumber`, `docType`, references. `DISAGREE` → `ESCALATE EXTRACTION_DISAGREE` (diff in receipt). `SINGLE` → `ESCALATE SINGLE_EXTRACTION` unless `policy.extraction.allowSingle`. (Targets ATK-18.)

### K-11 INSTRUCTION_CHANGE_HEURISTIC — ESCALATE — P0
Deterministic scan of **kernel-stored** normalized document text (NFKC, lowercase, zero-width stripped, homoglyph map for common Cyrillic/Greek lookalikes). Flags:
- Change-of-details: `new wallet`, `updated (payment|wallet|bank) details`, `change of (bank|wallet|address)`, `please (use|send to) the following (address|wallet)`.
- Instruction-like: `ignore (all|any|previous|above)`, `system:`, `assistant:`, `you are (now )?an? `, `do not verify`, `skip (the )?(check|verification)`, `approve (this|the) (payment|invoice)`, `pay (immediately|now)`.
- Structure: `zeroWidthCount > 5`, base64-like runs > 200 chars, hex strings that parse as an address different from engagement payee.
- Also any extractor `anomalies[]` of type `INSTRUCTION_IN_DOC|ADDRESS_CHANGE`.
Never auto-REJECTs (false positives on honest invoices must be human-resolvable); the receipt lists matched patterns with offsets. Pattern list lives in `packages/kernel-core/src/patterns.ts`, versioned, and tested with an adversarial corpus.

### K-12 AUTHORITY_ENVELOPE — REJECT (hard cap) / ESCALATE (human gate) — P0
From `policy.yaml`:
- `perTxHardCap` exceeded → `REJECT CAP_PER_TX`.
- Tenant daily/weekly totals (including pending) exceeded → `REJECT CAP_DAILY|CAP_WEEKLY`.
- Category monthly budget exceeded → `ESCALATE CATEGORY_BUDGET`.
- Payee velocity (count/day, amount/day) exceeded → `REJECT VELOCITY` (defeats ATK-14 splitting).
- `amount > humanApprovalAbove` → requires `ownerApproval` bound to `(intentId, receiptHash, amount, deadline)`, where `receiptHash` is the **escalation** decision's receipt (the service checks it is in the intent's `supersedes` chain, that `amount` equals the release amount and that `deadline` is still in the future); absent or unbound → `ESCALATE HUMAN_REQUIRED`. The attestation then carries the *final* receipt's hash and the relayer passes the approval as `OwnerApprovalRef` (`06` A.4).
- *(v2)* **Escalation budget (RT-14):** `policy.escalation = { maxPerDay, maxPerEngagementPerDay }`. When `ctx.escalations` already meets the budget, a would-be `ESCALATE` becomes `HOLD ESCALATION_BUDGET_EXCEEDED` (no money moves; surfaced to the owner as **one ranked digest**, never as separate approval prompts; no bulk-approve exists). `REJECT` verdicts do not consume budget. Rank = fewest passing checks / largest amount / newest payee first.
- First payment to a payee: `amount ≤ newPayeeFirstPaymentMax` else `ESCALATE FIRST_PAYMENT_LARGE`; **first payment always requires owner approval** if `policy.newPayee.alwaysHuman`.
- Mirrors on-chain `perTxCap`, `dailyCap`, `humanThreshold`; policy values must be ≤ vault values (checked at startup; mismatch ⇒ refuse to boot).

### K-13 COUNTERPARTY_SCREEN — HOLD / REJECT — P1 (P0 if V-01 clears)
`CLEAR` and fresh (≤ `screening.staleAfterHours`) → pass. `UNKNOWN`/stale → `HOLD SCREENING_PENDING` (service triggers a screen). `HIT` → `REJECT SCREEN_HIT` + alert. If disabled by policy → `SKIP` (visible in the receipt as `SCREENING_DISABLED`). Also records USDC-blocklist state if detectable.

### K-14 LIQUIDITY_AND_TIMING (+ TERMS BINDING, v2) — HOLD / ESCALATE — P0
- `vaultAvailable − pendingReleases ≥ amountDue + reserveFloor` else `HOLD LIQUIDITY`.
- **Terms binding (v2, INV-19; RT-15):**
  - Terms source = `ctx.paymentTerms` (signed). `null` ⇒ policy defaults (`timing.defaultNetDays`, no discount).
  - `intent.statedTerms` (from the extractor) is **compared, never adopted**: if the invoice states an early-pay discount and the signed terms have none ⇒ `ESCALATE TERMS_NOT_SIGNED`; if stated `netDays` or `earlyPay` differ from the signed values in either direction ⇒ `ESCALATE TERMS_MISMATCH`; `ambiguous=true` ⇒ `ESCALATE TERMS_MISMATCH` unless the invoice states no terms at all.
  - `dueDate = invoiceReceivedAt + netDays` (signed terms). The invoice's *printed* due date is recorded as a hint and ignored for timing when signed terms exist.
- **Feasible plans (v2):** `feasiblePlans(ctx, policy)` (pure, in `packages/terms`) enumerates `TAKE_DISCOUNT | DUE_MINUS_BUFFER | IMMEDIATE | AFTER_EVIDENCE | AFTER_DISPUTE_WINDOW | HOLD` with `payAt`, `amountDue`, `liquidityAfter`, `reserveFloorOk`. A plan is feasible only if: evidence is (or will be) satisfied before `payAt`; `payAt ≥ legalEarliest = max(now, evidenceSatisfiedAt, disputeWindowEnd)`; `payAt ≤ legalLatest = dueDate − payBeforeDueBufferHours` (or `legalEarliest` if the due date has passed ⇒ flag `LATE`); for `TAKE_DISCOUNT`, `payAt ≤ windowEnd − windowSafetyMarginMinutes`; caps/reserve floor hold. `intent.planSelection.planId` must belong to the set, else the selection is discarded (`PLAN_OUT_OF_ENVELOPE` recorded) and the evaluator's top **safe** plan is used (`timingSource='DEFAULT'`, `plannerFallback=true`).
- **Timing proposal handling (legacy path, retained as fallback):** proposal inside `[legalEarliest, legalLatest]` → accepted; else clamped with `TIMING_CLAMPED`. Due date passed → `payAt = now`, flag `LATE`.
- **Discount window at `payAt` (TOCTOU, §5):** if the re-evaluated `amountDue(now)` differs from the scheduled amount because the window has closed ⇒ `ESCALATE DISCOUNT_WINDOW_CLOSED` (default; owner chooses pay-full / ask payee to honour / hold). Never a silent switch.
- Output `payAt`, `amountDue`, `planId`, `timingSource: 'AGENT'|'CLAMPED'|'DEFAULT'`, `plannerFallback`.

### K-15 RECONCILIATION_WITNESS — post-settlement — P0 (chain side) / P1 (payee ack)
Runs every 60 s and on webhook:
1. For each decision `RELEASE` with a submitted tx: find vault `Released` for `intentId`; verify `payee, amount, receiptHash` equal the decision. Missing after 120 s → `finding: RELEASE_UNCONFIRMED`; after 10 min → HIGH.
2. **Unknown release:** any `Released` event without a matching decision → HIGH (possible signer compromise).
3. Balance identity: `vaultBalance == deposits − Σ releases − withdrawals` else HIGH.
4. P1: payee `ReceiptAck` within `ackWindow` (default 72 h, demo 10 min) else `ACK_MISSING` (alert, no breaker). This is the **counterparty witness**: the wrong party never acknowledges, so commission errors surface even when the chain "confirms" the transfer.
Findings are rows in `reconciliations`; HIGH triggers K-16.

### K-16 CIRCUIT_BREAKER — pre-check & trip — P0
State `OK | HALTED`. Trip on: HIGH reconciliation finding; unknown release; screening `HIT` on a previously paid payee; kernel exception rate > 5 in 10 min. When `HALTED`: every `evaluate()` returns `HOLD BREAKER_HALTED`; the service calls `vault.pause()` through the **guardian** key (pause-only role); unpause is owner-only and requires a recorded reason.

## 5. TOCTOU guard (re-evaluation at `payAt`)

A `RELEASE` verdict is a *schedule*, not a payment. At `payAt` the service rebuilds `KernelContext` and calls `evaluate()` again; only a fresh `RELEASE` with identical `(intentId, amount, payee)` yields an attestation. *(v2)* `amount` here is the **release amount** `amountDue(payAt)`; `intentId` is derived from the **gross invoiced amount** (K-04), so re-quoting a discount or renumbering cannot create a second valid intent. A changed outcome produces a new `Decision` with `supersedes = previous.decisionId`. Attestation `deadline = now + 10 min`.

## 6. Reason codes (stable enum; UI maps to text)

*(v2 additions at the end of the list: `TERMS_NOT_SIGNED, TERMS_MISMATCH, DISCOUNT_WINDOW_CLOSED, EVIDENCE_SOURCE_DENIED, ESCALATION_BUDGET_EXCEEDED, PLAN_OUT_OF_ENVELOPE`; the enum in `packages/schemas` is authoritative.)*

`SCHEMA_INVALID, NON_ASCII_DIGITS, SCIENTIFIC, REFUSE_ROUND, AMOUNT_AMBIGUOUS, EXTRACTION_PARSE_MISMATCH, LINEITEM_SUM_MISMATCH, CREDIT_NOTE, NOT_PAYABLE, DUPLICATE_DOC, NEAR_DUPLICATE, MILESTONE_ALREADY_PAID, NO_ENGAGEMENT, ENGAGEMENT_INACTIVE, OUT_OF_WINDOW, MILESTONE_ORDER, UNKNOWN_MILESTONE, PAYEE_MISMATCH, ADDRESS_CHANGE_CLAIMED, PAYEE_CHANGE_PENDING, CURRENCY_UNSUPPORTED, DECIMALS_MISMATCH, SCALE_ABSURD, OVERPAY, UNDERPAY_PARTIAL, EVIDENCE_MISSING, EVIDENCE_FAILED, EVIDENCE_HASH_MISMATCH, EXTRACTION_DISAGREE, SINGLE_EXTRACTION, INSTRUCTION_IN_DOC, CAP_PER_TX, CAP_DAILY, CAP_WEEKLY, CATEGORY_BUDGET, VELOCITY, HUMAN_REQUIRED, FIRST_PAYMENT_LARGE, SCREENING_PENDING, SCREEN_HIT, SCREENING_DISABLED, LIQUIDITY, TIMING_CLAMPED, LATE, BREAKER_HALTED, KERNEL_ERROR, TERMS_NOT_SIGNED, TERMS_MISMATCH, DISCOUNT_WINDOW_CLOSED, EVIDENCE_SOURCE_DENIED, ESCALATION_BUDGET_EXCEEDED, PLAN_OUT_OF_ENVELOPE`.

## 7. `policy.yaml` (loaded by `packages/policy`; `policyHash = keccak256(JCS(json))` recorded in every receipt)

```yaml
version: 1
tenant: edith-studio
currency: { code: USDC, decimals: 6, treatUsdAsUsdc: true }   # decimals verified against chain (V-04)
caps:
  perTxHardCap: "100.000000"        # must be <= vault.perTxCap
  dailyCap: "200.000000"            # must be <= vault.dailyCap
  hourlyCap: "25.000000"            # P1; must be <= vault.hourlyCap when enabled (0/absent = off)
  weeklyCap: "600.000000"           # kernel-level only (the vault enforces rolling 24 h)
  humanApprovalAbove: "50.000000"   # must be <= vault.humanThreshold
velocity: { maxReleasesPerDay: 10, maxReleasesPerPayeePerDay: 3, maxAmountPerPayeePerDay: "150.000000" }
newPayee: { firstPaymentMax: "25.000000", alwaysHuman: true }
categories: { design: "150.000000", dev: "300.000000", tools: "100.000000" }   # monthly
reserve: { floor: "10.000000", lookaheadDays: 14 }
timing: { disputeWindowHours: 0, payBeforeDueBufferHours: 24, allowImmediate: true, defaultNetDays: 30, windowSafetyMarginMinutes: 60 }   # v2: last two keys
treasury: { costOfCapitalBps: 0 }                        # v2: disclosed parameter used by the plan evaluator (`03` §5.2)
escalation: { maxPerDay: 8, maxPerEngagementPerDay: 3 }  # v2: K-12 escalation budget (RT-14)
limits: { maxDocChars: 20000 }                           # v2: challenge profile overrides to 4096
evidence: { freshnessHours: 72, allowOwnerOverride: true, urlAllowlist: ["https://*.vercel.app", "https://edithstudio.vercel.app"] }
extraction: { allowSingle: false }
screening: { required: false, staleAfterHours: 24 }     # flip to true when V-01 clears
reconciliation: { ackWindowHours: 72 }                 # demo: 0.17 (10 min)
```
Numbers are pilot-scale defaults. Strings, never floats. Parsed to `bigint` base units at load.

## 8. Receipt contents (summary; full schema in `05_DATA_MODELS_AND_API.md`)

Decision + all `CheckResult`s (including `PASS`), `contextHash`, `policyHash`, `kernelVersion`, patterns version, extraction hashes (A and B, prompt hashes, model IDs), evidence hashes, engagement `termsHash`, timing proposal and clamp info, agent recommendation, human explanation hash. *(v2)* Also: `invoiceReceivedAt`, `paymentTermsHash`, `planId` + `PlanEvaluation` hash + `plannerFallback`, `amountDue`, `doc.normalizedHash`, `profile`. Signed (EIP-712 `Receipt`) by the kernel signer. Anchored by the vault `Released` event (`receiptHash`).

## 9. Property-based tests (fast-check; mandatory)

| Property | Statement |
|---|---|
| P-DET | `evaluate(i,c,p)` twice → deep-equal outputs (and equal `receiptHash`) |
| P-MONO | Adding any failing condition never improves the verdict (REJECT never becomes RELEASE) |
| P-NO-LLM | Mutating `confidence`, `humanExplanation`, or `agentRecommendation` never changes the verdict |
| P-K02-ROUNDTRIP | For random `Money` and 6 locale formatters, `parseMoney(format(m))` = `m` or `AMBIGUOUS` (never a different value) |
| P-K04-IDEM | Re-evaluating with `priorDecisions` containing the result ⇒ `REPLAY` with identical decision |
| P-K08-EXACT | `RELEASE` ⇒ `amount == milestone.amount` (or partial rule) |
| P-K12-CAPS | Random sequences of intents: cumulative `RELEASE` amounts within any window ≤ caps |
| P-K06-PAYEE | `RELEASE` ⇒ payout address == `engagement.payee` |
| P-FAILCLOSED | Injecting an exception into any required check ⇒ verdict ≠ `RELEASE` **and** `KERNEL_ERROR` ∈ reasons (the verdict is `HOLD`, or `ESCALATE`/`REJECT` when another check also fails at a higher severity; it is never `RELEASE`) |
| P-TERMS-IGNORE-INVOICE *(v2)* | Mutating `statedTerms` (any values) never changes `amountDue(payAt)`, `payAt` bounds or the release amount; it may only add `ESCALATE` reasons |
| P-TERMS-WINDOW *(v2)* | Discount applies iff `payAt ≤ invoiceReceivedAt + withinDays·86400`; boundary tested at ±1 s; `0 ≤ amountDue ≤ gross` always; `discountValue = floor(gross·bps/10000)` |
| P-INTENT-GROSS *(v2)* | `intentId` is invariant to the chosen plan/discount and changes with any of `{engagementId, milestoneId, normInvoiceNo, grossAmount, payee}` |
| P-PLAN-SUBSET *(v2)* | A `RELEASE` with a planner-chosen `payAt` implies the `planId` ∈ `feasiblePlans(ctx)`; otherwise `plannerFallback=true` |
| P-ESC-BUDGET *(v2)* | When the escalation budget is met, no input yields `RELEASE`; would-be `ESCALATE` ⇒ `HOLD ESCALATION_BUDGET_EXCEEDED` |
| P-NO-BINARY *(v2)* | Any intent containing a binary-looking or oversize payload ⇒ `REJECT SCHEMA_INVALID` before K-02 |
| P-SANDBOX-NO-FETCH *(v2)* | With `profile='sandbox'`, evidence collectors are never invoked with a URL; unknown sources ⇒ `HOLD EVIDENCE_SOURCE_DENIED` |

## 10. Non-goals for the kernel
No ML, no heuristics-scoring, no "confidence thresholds," no calling the network, no adjudicating whether work is *good* beyond configured evidence; the owner can always override by signing.
