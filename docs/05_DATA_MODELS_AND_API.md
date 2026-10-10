# 05 — DATA MODELS, STORAGE, API

> `packages/schemas` (Zod) is the single source of truth. This doc is the human-readable contract; if code and doc disagree, fix the doc in the same PR.
>
> **v2 delta.** New/extended shapes: `PaymentTerms` (inside the signed terms), `FeasiblePlan`/`PlanEvaluation`/`PlanSelection`, `ApprovalView`, `LossBoundCertificate`, `ChallengeScenario/Attempt/Stats`, `ReplayBundle`; extended `Engagement`, `Document`, `PaymentIntent`, `Decision`, `Receipt`. **DDL changes ship as a new append-only migration `0002_v2.sql` (§3b), never by editing `0001_init.sql`.** New API routes in §4; new web routes in §5. Reason-code enum additions are in `04` §6 (authoritative in code).

## 1. Primitive types and conventions

```ts
type Hex32   = `0x${string}` & { len: 66 };   // keccak256 digests, ids
type Address = `0x${string}` & { len: 42 };   // EIP-55 checksummed
type BaseUnits = string;                      // decimal integer string, bigint-backed in code
type ISODateTime = string;                    // RFC 3339 UTC, 'Z'
```
- Amounts: **integer strings** in token base units; `decimals` carried separately. Never floats.
- IDs: `engagementId`, `milestoneId` = `keccak256(JCS({tenantId, slug|uuid}))` (deterministic, so on-chain and off-chain agree). `intentId` per `04_KERNEL_SPEC.md` K-04.
- Canonicalization: **RFC 8785 JCS** for any object that gets hashed/signed; keys sorted; no insignificant whitespace; numbers only where integral and < 2^53 (amounts are strings).
- Hashing: `keccak256` over UTF-8 JCS bytes. Documents: `keccak256(raw bytes)`.
- Verdict enum for signing: `RELEASE=1, HOLD=2, ESCALATE=3, REJECT=4, REPLAY=5`.
- Timestamps in contracts: `uint64` seconds.

## 2. Core schemas

```ts
// --- Engagement (the first half of the symbolon) ---
EvidenceRequirement =
  | { type: 'OWNER_ACK' }
  | { type: 'CI_PASS', repo: string /* "owner/name" */, ref: string /* sha or branch */, workflow?: string }
  | { type: 'URL_HEALTH', url: string, expectStatus: number, contentSha256?: Hex32 }
  | { type: 'ARTIFACT_HASH', sha256: Hex32 };

Milestone = {
  milestoneId: Hex32, slug: string, description: string,
  amountBaseUnits: BaseUnits, partialAllowed: boolean, immediate: boolean,
  dueDate: ISODateTime | null, category: string,
  evidenceSpec: EvidenceRequirement[],       // all_of
  status: 'PENDING'|'EVIDENCE_OK'|'PAID'|'DISPUTED'|'CANCELLED'
};

Engagement = {
  engagementId: Hex32, tenantId: UUID, owner: Address, payee: Address,
  payeeLabel: string, currency: 'USDC', currencyDecimals: number,
  capBaseUnits: BaseUnits, start: ISODateTime, end: ISODateTime,
  sequential: boolean, milestones: Milestone[],
  paymentTerms: PaymentTerms | null,         // v2: INSIDE the signed terms and therefore inside termsHash (INV-19)
  termsHash: Hex32,                          // keccak256(JCS(terms without signatures)); preimage = {engagementId, owner, payee, payeeLabel, currency, currencyDecimals, cap, start, end, sequential, milestones (incl. evidenceSpec), paymentTerms, nonce}
  ownerSig: Hex, payeeSig: Hex,              // EIP-712 EngagementTerms
  nonce: string,
  status: 'DRAFT'|'AWAITING_PAYEE'|'REGISTERING'|'ACTIVE'|'CLOSED'|'CANCELLED',
  registeredTx: Hex32 | null
};

// --- Payment terms (v2; signed by owner + payee as part of the engagement) ---
PaymentTerms = {
  netDays: number,                                              // integer 0..365; due = invoiceReceivedAt + netDays
  earlyPay: { discountBps: number, withinDays: number } | null, // 1..2000 bps; 0 < withinDays < netDays
  payBeforeDueBufferHours: number,                              // integer >= 0
  allowImmediate: boolean
};
// amountDue / window / APR math: packages/terms (pure bigint); definitions in 03 §5.2. Rounding: discount floors (payee-favourable).

// --- Evidence (kernel-collected only) ---
Evidence = {
  evidenceId: UUID, milestoneId: Hex32, type: EvidenceRequirement['type'],
  collectedBy: 'kernel',                      // literal; anything else is ignored by K-09
  collectedAt: ISODateTime, source: string, payload: unknown,
  payloadHash: Hex32, result: 'PASS'|'FAIL'|'ERROR', details: string
};

// --- Document & extraction ---
Document = { documentId: UUID, tenantId: UUID, rawHash: Hex32 /* sha256/keccak of original input */,
             blobSha256: Hex32 | null, mime: string, storageKey: string | null,
             normalizedText: string, normalizedHash: Hex32, zeroWidthCount: number,
             receivedAt: ISODateTime /* = invoiceReceivedAt, set by the kernel (INV-19) */, createdAt: ISODateTime };
// v2: text is produced by apps/web (caps, no JS execution); the kernel stores the blob opaquely and never parses it (INV-23).
// ExtractedInvoice (now with statedTerms), TimingProposal, FeasiblePlan, PlanEvaluation, PlanSelection: see 03_AGENT_SPEC.md §3, §5

// --- Intent (agent proposal) ---
PaymentIntent = {
  schemaVersion: 1, tenantId: UUID, documentId: UUID, docHash: Hex32,
  extraction: { a: ExtractedInvoice, b: ExtractedInvoice | null,
                modelA: string, modelB: string | null, promptHashA: Hex32, promptHashB: Hex32 | null },
  consensus: { status: 'AGREE'|'DISAGREE'|'SINGLE', diffs: { field: string, a: string, b: string }[] },
  engagementId: Hex32 | null, milestoneId: Hex32 | null,
  timingProposal: TimingProposal | null,        // legacy path / fallback (04 K-14)
  planSelection: PlanSelection | null,          // v2: planner's pick from the kernel-computed feasible set (03 §5.3)
  agentRecommendation: { verdict: 'RELEASE'|'HOLD'|'ESCALATE', reasons: string[] } | null,
  submittedAt: ISODateTime
};

// --- Decision / receipt ---
CheckResult = { id: `K-${string}`, name: string, status: 'PASS'|'FAIL'|'SKIP',
                onFail: 'REJECT'|'ESCALATE'|'HOLD'|null, code: ReasonCode | null, detail: string, refs: string[] };

Decision = {
  decisionId: UUID, tenantId: UUID, intentId: Hex32,
  verdict: 'RELEASE'|'HOLD'|'ESCALATE'|'REJECT'|'REPLAY',
  checks: CheckResult[], reasons: ReasonCode[],
  engagementId: Hex32 | null, milestoneId: Hex32 | null,
  payee: Address | null, amountBaseUnits: BaseUnits | null,
  payAt: ISODateTime | null, timingSource: 'AGENT'|'CLAMPED'|'DEFAULT' | null,
  releaseAmountBaseUnits: BaseUnits | null,      // v2: amountDue(payAt); `amountBaseUnits` stays the GROSS invoiced amount
  planId: Hex32 | null, plannerFallback: boolean, // v2
  invoiceReceivedAt: ISODateTime | null,         // v2
  policyHash: Hex32, kernelVersion: string, patternsVersion: string, contextHash: Hex32,
  agentRecommendation: PaymentIntent['agentRecommendation'],
  humanExplanation: string | null, supersedes: UUID | null, createdAt: ISODateTime
};

Receipt = {
  receiptVersion: 1,
  decision: Omit<Decision, 'humanExplanation'>,
  humanExplanationHash: Hex32 | null,
  inputs: {
    docHash: Hex32, extractionHashA: Hex32, extractionHashB: Hex32 | null,
    promptHashA: Hex32, promptHashB: Hex32 | null, modelA: string, modelB: string | null,
    evidence: { evidenceId: UUID, payloadHash: Hex32, result: string }[],
    engagementTermsHash: Hex32 | null,
    normalizedDocHash: Hex32,                     // v2
    paymentTermsHash: Hex32 | null,               // v2: keccak256(JCS(paymentTerms))
    planEvaluationHash: Hex32 | null,             // v2
    profile: 'production' | 'sandbox'             // v2
  },
  issuedAt: ISODateTime
};
// receiptHash = keccak256(JCS(Receipt)); signature = EIP-712 Receipt(receiptHash,intentId,verdict,policyHash,issuedAt)
```

### v2 shapes (authoritative Zod in `packages/schemas`; text here is the contract)

```ts
// --- WYSIWYS approval (INV-20): the UI renders FROM this object and signs `typedData` ---
ApprovalView = {
  intentId: Hex32, receiptHash: Hex32, engagementId: Hex32, milestoneId: Hex32,
  payee: { address: Address, label: string /* from the signed engagement, never from the invoice */ },
  decimals: number,
  grossBaseUnits: BaseUnits, releaseBaseUnits: BaseUnits,
  display: { gross: string, release: string },            // produced by the Money formatter only
  diffVsEngagement: Array<{ field: string, expected: string, actual: string }>,
  reasons: ReasonCode[],                                  // kernel-derived
  planSummary: { planId: Hex32, mode: string, payAt: ISODateTime, discountValue: BaseUnits } | null,
  expiresAt: ISODateTime,
  typedData: { domain: object, types: object, primaryType: 'OwnerApproval', message: { intentId: Hex32, receiptHash: Hex32, amount: BaseUnits, deadline: string } },
  typedDataHash: Hex32,                                   // keccak256(JCS(typedData)); shown beside the wallet prompt
  advisory: { text: string /* Untrusted<string>, collapsed, labelled "Advisory (AI), not verified" */ } | null
};
// buildApprovalTypedData(view) is the ONLY function that produces `typedData`; test: jcs(renderModel(view)) == jcs(signedModel).
// Placement: `packages/receipts/src/approval/{build,render}.ts` (WP-02; pure; imported by apps/web, attack-suite and sec-suite). `display.*` strings come from `formatBaseUnits()` in `packages/schemas` (the single bigint→string formatter; `packages/chain` re-exports it).

// --- Treasury Planner (03 §5): FeasiblePlan, PlanEvaluation, PlanSelection as specified there ---

// --- Loss Bound Certificate: schema `lbc/1` exactly as in 16 §3 (LossBoundCertificateSchema) ---

// --- Challenge (15) ---
ChallengeScenario = /* 15 §2 */;
ChallengeAttempt = {
  attemptId: UUID, scenarioId: 'S-A'|'S-B'|'S-C', source: 'human'|'house'|'oneclick', attackId: string | null,
  ipHash: Hex32 | null,                                   // sha256(ip ‖ CHALLENGE_IP_SALT), 7-day TTL
  textHash: Hex32, textLength: number, excerpt: string,   // Untrusted<string>; <= 240 chars, escaped; full text kept 30 d
  extraction: { modelA: string, modelB: string | null, promptHashA: Hex32, promptHashB: Hex32 | null, outputHashA: Hex32, outputHashB: Hex32 | null },
  decisionId: UUID, verdict: 'RELEASE'|'HOLD'|'ESCALATE'|'REJECT'|'REPLAY', reasons: ReasonCode[], checksFired: string[], receiptHash: Hex32,
  vaultSimulation: { ok: boolean, revertError: string | null } | null,
  txHash: Hex32 | null,
  oracle: { version: 'oracle-v1', result: 'NO_LOSS'|'LOSS', predicates: Array<'O1'|'O2'|'O3'|'O4'|'O5'|'O6'|'O7'|'O8'> },
  benignControl: boolean, publishable: boolean, createdAt: ISODateTime
};
ChallengeStats = /* 15 §8 */;

// --- Replay bundle (15 §7) ---
ReplayBundle = {
  version: 1, builtAt: ISODateTime, gitSha: string, harnessVersions: Record<string, string>,
  attackMatrix: object, holdout: { seedHash: Hex32, n: number, losses: number, upper95: number },
  scenarios: ChallengeScenario[], attempts: ChallengeAttempt[], receipts: Receipt[], decisions: Decision[],
  extractionOutputs: object[], certificate: object /* lbc/1 */, txs: Hex32[], plannerReport: object, bundleHash: Hex32
};
```

### EIP-712 typed data (domain: `name="SymbolonVault"`, `version="1"`, `chainId`, `verifyingContract = vault`)

```
EngagementTerms(bytes32 engagementId,address owner,address payee,uint256 cap,uint64 start,uint64 end,bytes32 termsHash,uint256 nonce)
Attestation(bytes32 intentId,bytes32 engagementId,bytes32 milestoneId,address payee,uint256 amount,bytes32 receiptHash,uint64 deadline)
OwnerApproval(bytes32 intentId,bytes32 receiptHash,uint256 amount,uint64 deadline)
PayeeChange(bytes32 engagementId,address oldPayee,address newPayee,uint256 nonce)
MilestoneAck(bytes32 milestoneId,bytes32 artifactHash,bool override,uint64 deadline)     // owner, off-chain only
ReceiptAck(bytes32 receiptHash,address payee,uint64 signedAt)                              // payee, off-chain only (P1)
Receipt(bytes32 receiptHash,bytes32 intentId,uint8 verdict,bytes32 policyHash,uint64 issuedAt) // kernel, off-chain/verifier
```
> `OwnerApproval` includes `amount` so an approval cannot be reused for a larger payment (the vault cannot read the receipt, so the amount must be in the signed struct). `receiptHash` is the hash of the **escalation** receipt the owner reviewed (not the final release receipt); `release()` receives `{receiptHash, deadline}` as `OwnerApprovalRef` (`06` A.4) and takes `intentId` and `amount` from the attestation. This supersedes the shorter form in `02_ARCHITECTURE.md`.

## 3. Postgres DDL (Supabase; `supabase/migrations/0001_init.sql`: append-only afterwards)

```sql
create table tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null, owner_address text not null,
  vault_address text, chain_id bigint not null, network text not null check (network in ('testnet','mainnet','local')),
  is_internal boolean not null default false,          -- excluded from public traction
  policy jsonb not null, policy_hash text not null,
  created_at timestamptz not null default now()
);

create table engagements (
  engagement_id text primary key, tenant_id uuid not null references tenants(id),
  owner text not null, payee text not null, payee_label text not null,
  currency text not null, currency_decimals int not null,
  cap_base_units numeric(40,0) not null, start_at timestamptz not null, end_at timestamptz not null,
  sequential boolean not null default false, terms jsonb not null, terms_hash text not null,
  owner_sig text, payee_sig text, nonce numeric(40,0) not null,
  status text not null, registered_tx text, created_at timestamptz not null default now()
);

create table milestones (
  milestone_id text primary key, engagement_id text not null references engagements(engagement_id),
  slug text not null, description text not null, amount_base_units numeric(40,0) not null check (amount_base_units > 0),
  partial_allowed boolean not null default false, immediate boolean not null default false,
  due_date timestamptz, category text not null, evidence_spec jsonb not null,
  status text not null default 'PENDING', unique (engagement_id, slug)
);

create table documents (
  document_id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  raw_hash text not null, mime text not null, storage_key text not null,
  normalized_text text not null, zero_width_count int not null default 0, created_at timestamptz not null default now()
);

create table intents (
  intent_id text primary key, tenant_id uuid not null references tenants(id),
  document_id uuid not null references documents(document_id), payload jsonb not null,
  created_at timestamptz not null default now()
);

create table decisions (
  decision_id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  intent_id text not null references intents(intent_id), verdict text not null,
  checks jsonb not null, reasons text[] not null, payee text, amount_base_units numeric(40,0),
  engagement_id text, milestone_id text, pay_at timestamptz, timing_source text,
  policy_hash text not null, kernel_version text not null, context_hash text not null,
  agent_recommendation jsonb, human_explanation text, supersedes uuid references decisions(decision_id),
  created_at timestamptz not null default now()
);
create index on decisions (tenant_id, intent_id, created_at desc);

create table receipts (
  receipt_hash text primary key, decision_id uuid not null references decisions(decision_id),
  receipt jsonb not null, signature text not null, signer text not null, issued_at timestamptz not null
);

create table evidence (
  evidence_id uuid primary key default gen_random_uuid(), milestone_id text not null references milestones(milestone_id),
  type text not null, collected_by text not null check (collected_by = 'kernel'),
  collected_at timestamptz not null, source text not null, payload jsonb, payload_hash text not null,
  result text not null check (result in ('PASS','FAIL','ERROR')), details text
);

create table approvals (
  approval_id uuid primary key default gen_random_uuid(), intent_id text not null references intents(intent_id),
  signer text not null, amount_base_units numeric(40,0) not null, deadline bigint not null, signature text not null,
  verified boolean not null default false, created_at timestamptz not null default now()
);

create table releases (                                -- one row per on-chain attempt
  release_id uuid primary key default gen_random_uuid(), decision_id uuid not null references decisions(decision_id),
  intent_id text not null, circle_tx_id text, tx_hash text, status text not null,  -- QUEUED|SUBMITTED|CONFIRMED|FAILED
  attestation jsonb not null, error text, submitted_at timestamptz, confirmed_at timestamptz,
  unique (intent_id) deferrable initially deferred
);

create table chain_events (                            -- indexed vault events
  id bigserial primary key, tenant_id uuid not null references tenants(id), event text not null,
  tx_hash text not null, log_index int not null, block_number bigint not null, data jsonb not null,
  unique (tx_hash, log_index)
);

create table reconciliations (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references tenants(id),
  kind text not null, severity text not null check (severity in ('LOW','MEDIUM','HIGH')),
  decision_id uuid, detail jsonb not null, resolved boolean not null default false, created_at timestamptz not null default now()
);

create table breaker_state (tenant_id uuid primary key references tenants(id), halted boolean not null default false,
  reason text, since timestamptz, resolved_by text);

create table receipt_acks (receipt_hash text primary key references receipts(receipt_hash), payee text not null,
  signature text not null, signed_at timestamptz not null);

create table agent_calls (id uuid primary key default gen_random_uuid(), tenant_id uuid, role text not null,
  model text not null, prompt_hash text not null, input_hash text not null, output jsonb not null,
  tokens_in int, tokens_out int, latency_ms int, cost_usd numeric(10,6), created_at timestamptz not null default now());

create table attack_runs (run_id uuid primary key default gen_random_uuid(), mode text not null, started_at timestamptz not null default now(),
  finished_at timestamptz, git_sha text, summary jsonb);
create table attack_results (id bigserial primary key, run_id uuid not null references attack_runs(run_id),
  attack_id text not null, target text not null check (target in ('naive','symbolon','arc-escrow')), outcome text not null,
  loss_base_units numeric(40,0) not null default 0, checks_fired text[] , detail jsonb);

create table blast_reports (id uuid primary key default gen_random_uuid(), tenant_id uuid, threat_model text not null,
  policy_hash text not null, vault_config jsonb not null, bound_24h numeric(40,0) not null, bound_7d numeric(40,0) not null,
  trials int not null, violations int not null, report jsonb not null, created_at timestamptz not null default now());

create table traction_events (id uuid primary key default gen_random_uuid(), tenant_id uuid, kind text not null,
  network text not null check (network in ('testnet','mainnet')), real boolean not null, internal boolean not null default false,
  amount_base_units numeric(40,0), tx_hash text, note text, cli_logged boolean not null default false, created_at timestamptz not null default now());

create table audit_log (id bigserial primary key, at timestamptz not null default now(), actor text not null, action text not null, detail jsonb);
```
**RLS:** all tables RLS-enabled; `anon` has **no** direct table access. Public pages read only through SQL **views**: `public_receipts` (hash, verdict, check IDs/codes, policy hash, tx hash, amounts only if tenant opted in), `public_pilot_stats` (per-network counts/sums, `tenants.kind='pilot'` only) and `public_traction_summary` (the single-row traction headline, same filter), `public_attack_latest`, `public_blast_latest`. The kernel uses the service role.

### 3b. v2 migration `supabase/migrations/0002_v2.sql` (append-only; if your repo already has `0001`, add this file, do not edit `0001`)

```sql
-- INV-17: tenant kind drives every traction view. is_internal is kept for compatibility and derived.
alter table tenants add column kind text not null default 'pilot' check (kind in ('pilot','demo','challenge'));
update tenants set kind = case when is_internal then 'demo' else 'pilot' end;

-- INV-16 defense in depth: a DB knows which deployment it belongs to.
create table deployment_profile (id int primary key default 1 check (id = 1), profile text not null check (profile in ('production','sandbox')));
create function enforce_tenant_kind() returns trigger language plpgsql as $$
declare p text;
begin
  select profile into p from deployment_profile where id = 1;
  if p is null then raise exception 'deployment_profile not set'; end if;
  if new.kind = 'challenge' and p <> 'sandbox' then raise exception 'challenge tenants only in sandbox DB'; end if;
  if new.kind = 'pilot' and p = 'sandbox' then raise exception 'pilot tenants never in sandbox DB'; end if;
  return new;
end $$;
create trigger tenants_kind_guard before insert or update of kind on tenants for each row execute function enforce_tenant_kind();

-- planner / terms / documents
alter table documents add column normalized_hash text, add column blob_sha256 text, add column received_at timestamptz not null default now();
alter table decisions add column release_amount_base_units numeric(40,0), add column plan_id text,
  add column planner_fallback boolean not null default false, add column invoice_received_at timestamptz;

-- attack suite: baselines B0/B1/B2 (naive -> b1, arc-escrow -> b0) and hold-out
alter table attack_results drop constraint attack_results_target_check;
update attack_results set target = 'b1' where target = 'naive';
update attack_results set target = 'b0' where target = 'arc-escrow';
alter table attack_results add constraint attack_results_target_check check (target in ('b0','b1','b2','symbolon'));
alter table attack_runs add column suite text not null default 'core' check (suite in ('core','holdout','sec')),
  add column holdout_seed_hash text, add column trials int;

-- budget (INV-21)
create table llm_budget_ledger (id bigserial primary key, day date not null, principal_hash text not null,
  role text not null, tokens_in int not null, tokens_out int not null, est_usd numeric(10,6) not null,
  cache_hit boolean not null default false, created_at timestamptz not null default now());
create index on llm_budget_ledger (day, principal_hash);

-- challenge (15)
create table challenge_scenarios (scenario_id text primary key, spec jsonb not null, oracle_version text not null, created_at timestamptz not null default now());
create table challenge_attempts (attempt_id uuid primary key default gen_random_uuid(),
  scenario_id text not null references challenge_scenarios(scenario_id),
  source text not null check (source in ('human','house','oneclick')), attack_id text, ip_hash text,
  text_hash text not null, text_length int not null, excerpt text not null, full_text text,       -- full_text purged after 30 d
  extraction jsonb not null, decision_id uuid, verdict text not null, reasons text[] not null, checks_fired text[] not null,
  receipt_hash text, vault_simulation jsonb, tx_hash text,
  oracle_result text not null check (oracle_result in ('NO_LOSS','LOSS')), oracle_predicates text[] not null default '{}',
  benign_control boolean not null default false, publishable boolean not null default false, created_at timestamptz not null default now());
create index on challenge_attempts (created_at desc);

-- certificates (16) and replay bundles (15 §7)
create table certificates (cert_hash text primary key, vault text not null, chain_id bigint not null, block_number bigint not null,
  block_hash text not null, cert jsonb not null, validity_status text not null check (validity_status in ('VALID','STALE','UNVERIFIED')),
  built_at timestamptz not null default now());
create index on certificates (vault, built_at desc);
create table replay_bundles (bundle_hash text primary key, built_at timestamptz not null default now(), git_sha text not null, storage_key text not null, summary jsonb not null);

-- views: traction counts pilots ONLY, by construction (INV-17). Drop + recreate (column lists may differ from v1).
drop view if exists public_pilot_stats;
create view public_pilot_stats as
  select t.network, count(distinct t.id) as businesses, count(r.*) as releases, coalesce(sum(r.amount_base_units),0) as value_base_units
  from tenants t left join releases_public r on r.tenant_id = t.id
  where t.kind = 'pilot' group by t.network;
drop view if exists public_traction_summary;
create view public_traction_summary as
select
  count(distinct t.id) filter (where t.kind = 'pilot') as businesses_onboarded,
  count(distinct t.id) filter (where t.kind = 'pilot' and t.network = 'mainnet') as businesses_mainnet,
  count(*) filter (where te.kind = 'release' and te.real and t.kind = 'pilot') as real_payments,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.real and te.network = 'mainnet' and t.kind = 'pilot'), 0) as mainnet_value_base_units,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.network = 'testnet' and t.kind = 'pilot'), 0) as testnet_value_base_units,
  (select count(*) from blast_reports where tenant_id is null) as audits_run
from tenants t left join traction_events te on te.tenant_id = t.id;
-- sandbox DB only: create view public_challenge_stats as <aggregate of challenge_attempts shaped like ChallengeStats (15 §8)>;
```
> Notes for the KERNEL-SVC agent: `releases_public` is a small helper view you create in the same migration (confirmed releases with `tenant_id`, `amount_base_units`); `public_challenge_stats` aggregates `challenge_attempts` into the `ChallengeStats` shape and is created only by the sandbox provisioning script. SEC-04 is two tests: (a) a *view test* in a scratch DB with the `deployment_profile` trigger disabled for that test only, which inserts `challenge` and `demo` rows and asserts `public_pilot_stats` and `public_traction_summary` are byte-identical before/after; (b) a separate *trigger test* with the profile set, which asserts the cross-profile inserts are refused. `deployment_profile` is written once by `scripts/set-db-profile.ts` at provisioning; the boot guards read it.

**RLS (v2):** all new tables are RLS-enabled with no `anon` policy; challenge tables are readable by the public only through `public_challenge_stats` and the replay bundle. The sandbox DB is a separate Supabase **project**.

## 4. Kernel HTTP API (`services/kernel`, Hono; JSON; all under `/v1`)

**Auth:** `Authorization: Bearer <HMAC-signed service token>` for web→kernel (rotating, scoped to `tenantId`). *(v2, RT-31)* The token binds `{tenantId, audience, exp ≤ 60 s, nonce}`; the kernel rejects replayed nonces, wrong tenant, wrong audience and expired tokens, compares in constant time, and uses a **different secret per profile**. **Owner/payee actions never rely on sessions; they carry EIP-712 signatures verified by the kernel.** Errors: `{ "error": { "code": "…", "message": "…", "detail": {…} } }` with HTTP 4xx/5xx. All mutating routes accept `Idempotency-Key`.

| Method & path | Purpose | Body → Response |
|---|---|---|
| `POST /documents` | *(v2)* Store the document: **text extracted by `apps/web`** (≤ `maxDocChars`) + optional opaque blob (stored/hashed, **never parsed**, INV-23); kernel normalizes text (`normalizeUntrusted`), records `receivedAt` (= `invoiceReceivedAt`) | multipart (`text`, `mime`, optional `blob`) → `{documentId, docHash, normalizedHash, textPreview}` |
| `GET /documents/:id/text` | Sanitized read for the extractor | → `{normalizedText}` |
| `POST /intents` | Submit agent intent; kernel computes `intentId`, runs `evaluate`, stores decision+receipt | `PaymentIntent` → `{intentId, decision, receiptHash}` |
| `GET /decisions/:id` · `GET /intents/:id` | Read | → `Decision` / intent+latest decision |
| `GET /intents/:id/plans` | *(v2)* Kernel-computed feasible plan set + deterministic evaluation (the planner's only view; also `read_context('plans')`) | → `{plans: FeasiblePlan[], evaluation: PlanEvaluation}` |
| `POST /intents/:id/plan-selection` | *(v2)* Submit the planner's `PlanSelection`; kernel validates membership, re-evaluates | `PlanSelection` → `{decision}` |
| `GET /intents/:id/approval-view` | *(v2, INV-20)* Build `ApprovalView` + exact `typedData` for the owner to sign | → `ApprovalView` |
| `POST /decisions/:id/explanation` | *(v2)* Attach the **advisory** AI note (sanitized, ≤ 60 words, stored as `Untrusted`); the human-facing explanation itself is **templated by the kernel** | `{text}` → `204` |
| `POST /approvals` | Owner `OwnerApproval` signature | `{intentId, receiptHash, amount, deadline, signature}` → verifies signer==owner and that `receiptHash`/`amount` equal the pending `ApprovalView`; re-evaluates; `{decision}` |
| `POST /engagements` | Create DRAFT engagement | terms → `{engagementId, typedData}` |
| `POST /engagements/:id/sign` | Submit `ownerSig` or `payeeSig` | `{role, signature}` → status; when both present, relayer registers on-chain |
| `POST /engagements/:id/payee-change` | Initiate `PayeeChange` flow (collect 3 sigs) | → status |
| `POST /evidence/collect` | Ask kernel to (re)collect evidence for a milestone | `{milestoneId}` → `Evidence[]` |
| `POST /evidence/artifact` | Upload artifact; kernel hashes | multipart → `{sha256}` |
| `POST /evidence/ack` | Owner `MilestoneAck` signature | → `Evidence` |
| `POST /receipts/:hash/ack` | Payee `ReceiptAck` (P1) | `{signature}` → `204` |
| `GET /receipts/:hash` | Full receipt + signature (tenant-scoped) | → `{receipt, signature, tx}` |
| `GET /state` | breaker, vault balance, pending, policy hash | → state |
| `POST /breaker/unfreeze` | Owner-signed unfreeze + reason | → state |
| `POST /attack-runs` · `GET /attack-runs/:id` | Run/read attack suite | → summary |
| `POST /blast-radius` · `GET /blast-radius/:id` | Compute/read report | → report |
| `GET /certificates/:vault` · `GET /certificates/:vault/:certHash` | *(v2)* Latest / specific Loss Bound Certificate with a server-side `validity` re-check | → `lbc/1` |
| `POST /certificates/:vault/build` | *(v2)* Build + publish a certificate (rate-limited; public for sandbox vaults, tenant-auth for pilot vaults) | → `lbc/1` |
| `GET /challenge/scenarios` · `POST /challenge/attempts` · `GET /challenge/attempts/:id` · `GET /challenge/stats` · `POST /challenge/prove-onchain` | *(v2, **mounted only when `KERNEL_PROFILE=sandbox`**; 404 in production)* challenge flow of `15`; every route behind rate limits + budget ledger | see `15` §1–§8 |
| `POST /webhooks/circle` | Circle webhook receiver (signature verified; *(v2, RT-30)* timestamp window + idempotency key; webhooks only **trigger** a reconcile, they never mark a release confirmed — K-15 trusts chain events; **VERIFY V-12**) | → `200` |
| `GET /healthz` · `GET /readyz` | probes | |

**Public (served by web from SQL views; no auth):** `/api/public/receipt/:hash` (+ verification helper), `/api/public/pilot-stats`, `/api/public/attack/latest`, `/api/public/blast/latest`, *(v2)* `/api/public/certificate/:vault`, `/api/public/challenge/stats`. Public routes are rate-limited and never return raw attacker text beyond the sanitized excerpt.

### Example: `POST /v1/intents` response (REJECT)
```json
{
  "intentId": "0x9a…",
  "decision": {
    "verdict": "REJECT",
    "reasons": ["PAYEE_MISMATCH", "INSTRUCTION_IN_DOC"],
    "checks": [
      {"id":"K-06","name":"PAYEE_BINDING","status":"FAIL","onFail":"REJECT","code":"PAYEE_MISMATCH",
       "detail":"invoice address 0xBAD… != engagement payee 0xA11…","refs":["engagement:0x77…"]},
      {"id":"K-11","name":"INSTRUCTION_CHANGE_HEURISTIC","status":"FAIL","onFail":"ESCALATE","code":"INSTRUCTION_IN_DOC",
       "detail":"matched: 'ignore previous', 'updated wallet details' @ offsets 412, 530","refs":[]}
    ],
    "policyHash": "0x…", "kernelVersion": "0.1.0"
  },
  "receiptHash": "0x5c…"
}
```

## 5. Web app routes (`apps/web`, Next.js App Router)

| Route | Purpose | Auth |
|---|---|---|
| `/` | pitch + live attack matrix + pilot stats | public |
| `/judge` | **guided 5-minute reviewer path** (see `11_DEMO_AND_SUBMISSION.md`) | public |
| `/dashboard` | vault balance (on-chain), obligations, decisions feed, breaker state | owner (wallet sign-in) |
| `/engagements/new`, `/engagements/[id]` | create/sign; payee signing link `/sign/[token]` | owner / payee |
| `/intents/new` | upload/paste invoice → extraction → decision | owner |
| `/intents/[id]` | decision detail: checks table, agent vs kernel, explanation, approve button | owner |
| `/attack-lab` | run/see ATK-01..24 (+ hold-out summary): Symbolon vs B0/B1/B2 side-by-side, honest corpus stats | public (read) |
| `/blast-radius` | report: bounds per threat model, trials, assumptions; what-if sliders (same `bounds.ts`) | public (read) |
| `/certificate/[vault]` *(v2)* | Loss Bound Certificate: exclusions → generated headline → status chip → horizon table → assumptions → validation → verify command → diff when STALE (`16` §7) | public (read) |
| `/challenge` *(v2)* | "Break the Treasurer": scoreboard, one-click attacks, benign controls, write-your-own, certificate card (`15` §1). **Served from the sandbox web (`NEXT_PUBLIC_PROFILE=challenge`) only** | public |
| `/replay/[bundle]` *(v2)* | static recorded run (RECORDED watermark); automatic fallback for judge pages | public |
| `/security` *(v2)* | `SECURITY.md` rendering: good-faith testing terms, scope, contact | public |
| `/audit` , `/audit/[receiptHash]` | **public verifier**: signature, policy hash, on-chain anchor, explorer link | public |
| `/pilot` | public stats from `public_pilot_stats` and `public_traction_summary` with explorer links | public |
| `/api/extract` | server route: reads doc text via kernel, runs dual extraction, posts intent | owner |

Wallet sign-in: SIWE-style signature with the owner address (viem/wagmi), used only for UI session. **Authority comes from per-action EIP-712 signatures.** *(v2)* The `challenge` build profile contains **no wallet/signing code** and sets no cookies; on that origin only `/`, `/challenge`, `/attack-lab`, `/certificate/*`, `/judge`, `/replay/*`, `/security` exist (INV-15/16).

## 6. Events the kernel indexes (vault)

`ConfigChanged(configHash)` *(v2; constructor, `setGuardian`, `executeKernelSigner`)* · `EngagementRegistered(engagementId, owner, payee, cap, start, end, termsHash)` · `Released(intentId, engagementId, payee, amount, receiptHash)` · `PayeeChangeProposed/Executed` · `Paused/Unpaused(by)` · `KernelSignerProposed/Rotated` · `Withdrawn(to, amount)` · `Deposited(from, amount)` (via token `Transfer`). Index by polling `getLogs` every 5 s plus Circle webhooks; Arc has sub-second finality, so a log is final once it appears (two-state tx model).

## 7. Seed and fixtures
`scripts/seed-demo.ts` creates a **demo tenant (`kind='demo'`)** with 3 engagements and 12 invoices (clean, ambiguous, injected, plus one terms-injection trap). Never counted in public traction. `scripts/seed-challenge.ts` (sandbox only) registers scenarios S-A/S-B/S-C with throwaway-key-signed engagements on the sandbox vault.
