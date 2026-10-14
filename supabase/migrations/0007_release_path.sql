-- 0007_release_path.sql  (WP-14, KERNEL-SVC)  APPEND-ONLY. Do not edit 0001-0006.
-- Scheduler, TOCTOU re-evaluation at payAt, attestation signing, release relay, owner approvals, plan offers.
--
-- A RELEASE decision is a schedule, not a payment (docs/04 s5). The scheduler re-evaluates it at payAt against fresh context;
-- only an identical fresh RELEASE yields a signed Attestation, which is written to `releases` (one row per intent) BEFORE it is
-- relayed (claim-then-send), so a crash between signing and sending cannot lose or duplicate it (the vault's used[intentId] is
-- the on-chain backstop). A release row becomes CONFIRMED only from an indexed `Released` event that matches the decision
-- (K-15 trusts chain events, never a webhook or a relayer's word). Everything here is service-owned: the API roles get nothing.

-- --- decisions: kernel outputs needed after the fact -------------------------------------------------------------------
-- The ESCALATE findings an owner approval may resolve (Evaluation.approvableFindings), so POST /approvals and the payAt
-- re-evaluation can pass them back as ctx.approvedEscalation without re-deriving anything.
alter table decisions add column approvable_findings jsonb not null default '[]'::jsonb
  check (jsonb_typeof(approvable_findings) = 'array');
-- The scheduled plan {planId, mode, payAt, discountValue} (ApprovalView.planSummary); null when nothing is scheduled.
alter table decisions add column plan_summary jsonb check (plan_summary is null or jsonb_typeof(plan_summary) = 'object');
create index decisions_supersedes_idx on decisions (supersedes) where supersedes is not null;
create index decisions_release_due_idx on decisions (tenant_id, pay_at) where verdict = 'RELEASE';

-- --- approvals: bound to the escalation receipt the owner reviewed (docs/05 s2, docs/04 K-12) ---------------------------
alter table approvals add column tenant_id uuid references tenants(id);
alter table approvals add column receipt_hash text check (receipt_hash is null or receipt_hash ~ '^0x[0-9a-f]{64}$');
alter table approvals add column decision_id uuid references decisions(decision_id);
alter table approvals add constraint approvals_signature_shape check (signature ~ '^0x[0-9a-f]+$' and length(signature) <= 4098);
alter table approvals add constraint approvals_amount_positive check (amount_base_units > 0);
create unique index approvals_one_per_signature on approvals (intent_id, signature);

-- --- releases: the attestation lifecycle --------------------------------------------------------------------------------
-- QUEUED     attestation signed and stored; not known to be on chain
-- SUBMITTED  the relayer returned a transaction hash (a pointer, not proof)
-- CONFIRMED  an indexed Released event matched intentId, payee, amount and receiptHash
-- FAILED     refused by the vault's simulation, expired, reverted or dropped; retried with a FRESH re-evaluation until
--            `attempts` reaches the limit (docs/02 s6: N=3, then nothing more is sent and a finding is raised)
alter table releases add column tenant_id uuid references tenants(id);
alter table releases add column attempts int not null default 0 check (attempts >= 0);
alter table releases add column next_attempt_at timestamptz;
alter table releases add column deadline timestamptz;
alter table releases add column updated_at timestamptz not null default now();
alter table releases add constraint releases_status_check check (status in ('QUEUED','SUBMITTED','CONFIRMED','FAILED'));
alter table releases add constraint releases_tx_hash_shape check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$');
alter table releases add constraint releases_error_len check (error is null or length(error) <= 200);
alter table releases add constraint releases_confirmed_has_tx check (status <> 'CONFIRMED' or (tx_hash is not null and confirmed_at is not null));
create index releases_tenant_status_idx on releases (tenant_id, status);

-- --- plan offers: the plan set a planner was shown (ctx.planningAsOf, docs/04 K-14) ---------------------------------------
create table plan_offers (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  intent_id text not null references intents(intent_id),
  as_of timestamptz not null,
  plan_ids text[] not null,
  created_at timestamptz not null default now()
);
create index plan_offers_lookup_idx on plan_offers (tenant_id, intent_id, as_of desc);
alter table plan_offers enable row level security;

-- --- automatic re-evaluation of HOLD heads (docs/04 s1: "auto re-evaluated when the missing thing changes") ---------------
create table decision_rechecks (
  decision_id uuid primary key references decisions(decision_id),
  tenant_id uuid not null references tenants(id),
  checked_at timestamptz not null,
  checks int not null default 1 check (checks >= 0)
);
alter table decision_rechecks enable row level security;

-- Same lockdown pattern as 0001-0006: nothing for the API roles.
revoke all on table plan_offers from public, anon, authenticated;
revoke all on sequence plan_offers_id_seq from public, anon, authenticated;
revoke all on table decision_rechecks from public, anon, authenticated;
