-- 0005_engagement_service.sql  (WP-12, KERNEL-SVC)  APPEND-ONLY. Do not edit 0001-0004.
-- Engagement sign flows, on-chain registration relay, vault event indexer and the payee-change flow.
--
-- An engagement is ACTIVE only after the chain says so: the indexer sets ACTIVE (and registered_tx) when it reads a
-- confirmed EngagementRegistered whose termsHash, owner, payee, cap and window equal the stored signed terms. Nothing the
-- API receives can set that status. Everything here is service-owned: the API roles get no access at all (same
-- revoke-all pattern as 0001-0004).

-- --- engagements: a closed status set and relay bookkeeping -----------------------------------------------------------
alter table engagements add constraint engagements_status_check
  check (status in ('DRAFT','AWAITING_PAYEE','REGISTERING','ACTIVE','CLOSED','CANCELLED'));
-- The tx the relayer submitted (not yet proof of anything: registered_tx is set only by the indexer, from the event).
alter table engagements add column submitted_tx text check (submitted_tx is null or submitted_tx ~ '^0x[0-9a-f]{64}$');
alter table engagements add column registration_error text check (registration_error is null or length(registration_error) <= 200);
alter table engagements add column registration_attempts int not null default 0 check (registration_attempts >= 0);
alter table engagements add column submitted_at timestamptz;
-- An ACTIVE engagement always carries both signatures and the registration tx the indexer saw (fail closed even if a
-- buggy writer forgets one of them).
alter table engagements add constraint engagements_active_is_registered
  check (status <> 'ACTIVE' or (owner_sig is not null and payee_sig is not null and registered_tx is not null));

-- --- chain_events: reorg-safe indexing ---------------------------------------------------------------------------------
-- (tx_hash, log_index) stays unique. block_hash records which block the log was read from; a row whose block was later
-- replaced is marked REORGED (and its effects undone) and is revived, not duplicated, if the same tx is mined again.
alter table chain_events add column block_hash text check (block_hash is null or block_hash ~ '^0x[0-9a-f]{64}$');
alter table chain_events add column status text not null default 'CONFIRMED' check (status in ('CONFIRMED','REORGED'));
alter table chain_events add column indexed_at timestamptz not null default now();
alter table chain_events add column reorged_at timestamptz;
create index chain_events_engagement_idx on chain_events (tenant_id, event, ((data ->> 'engagementId')));

-- One cursor per tenant vault: the next block to scan. The indexer only reads up to head - confirmations.
create table chain_cursors (
  tenant_id uuid primary key references tenants(id),
  chain_id bigint not null,
  vault_address text not null,
  next_block bigint not null check (next_block >= 0),
  updated_at timestamptz not null default now()
);
alter table chain_cursors enable row level security;

-- --- payee changes (3 signatures, vault delay) --------------------------------------------------------------------------
create table payee_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  engagement_id text not null references engagements(engagement_id),
  old_payee text not null,
  new_payee text not null,
  nonce numeric(40,0) not null check (nonce > 0),
  owner_sig text, old_sig text, new_sig text,
  status text not null check (status in ('COLLECTING','SUBMITTING','SUBMITTED','PROPOSED','EXECUTING','EXECUTED','CANCELLED','FAILED')),
  source text not null default 'KERNEL' check (source in ('KERNEL','CHAIN')),
  submitted_tx text check (submitted_tx is null or submitted_tx ~ '^0x[0-9a-f]{64}$'),
  proposed_tx text check (proposed_tx is null or proposed_tx ~ '^0x[0-9a-f]{64}$'),
  executed_tx text check (executed_tx is null or executed_tx ~ '^0x[0-9a-f]{64}$'),
  eta_epoch bigint,
  error text check (error is null or length(error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (engagement_id, nonce)
);
-- At most one open change per engagement.
create unique index payee_changes_one_open on payee_changes (engagement_id)
  where status in ('COLLECTING','SUBMITTING','SUBMITTED','PROPOSED','EXECUTING');
create index payee_changes_tenant_idx on payee_changes (tenant_id, engagement_id);
alter table payee_changes enable row level security;

-- --- reconciliations: one row per distinct finding -----------------------------------------------------------------------
-- The indexer re-runs; a finding that carries detail.dedupeKey is recorded once per (tenant, kind, key).
create unique index reconciliations_dedupe on reconciliations (tenant_id, kind, ((detail ->> 'dedupeKey')))
  where (detail ->> 'dedupeKey') is not null;

-- Same lockdown pattern as 0001-0004: nothing for the API roles.
revoke all on table chain_cursors from public, anon, authenticated;
revoke all on table payee_changes from public, anon, authenticated;
