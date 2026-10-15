-- 0008_reconciler.sql  (WP-15, KERNEL-SVC)  APPEND-ONLY. Do not edit 0001-0007.
-- K-15 chain-side reconciliation, K-16 circuit breaker bookkeeping and the guardian pause.
--
-- The reconciler trusts CHAIN state only (indexed Released/Withdrawn events, token balance at a block, token Transfer logs); a
-- webhook merely asks it to run a pass. A HIGH finding trips the breaker (breaker_state.halted) and the guardian key pauses the
-- vault. Only the owner (a signed, reasoned request) clears the breaker. Everything here is service-owned: API roles get nothing.

-- --- findings: who resolved them and when ----------------------------------------------------------------------------------
alter table reconciliations add column resolved_at timestamptz;
alter table reconciliations add column resolved_by text check (resolved_by is null or length(resolved_by) <= 64);
create index reconciliations_open_idx on reconciliations (tenant_id, severity) where not resolved;

-- --- breaker: how the current halt started and how it ended ------------------------------------------------------------------
-- `since` (0001) is the instant the CURRENT halt began; the owner's unfreeze signature is bound to it (one halt, one unfreeze).
alter table breaker_state add column finding_id uuid references reconciliations(id);
alter table breaker_state add column pause_tx text check (pause_tx is null or pause_tx ~ '^0x[0-9a-f]{64}$');
alter table breaker_state add column pause_error text check (pause_error is null or length(pause_error) <= 200);
alter table breaker_state add column resolved_at timestamptz;
alter table breaker_state add column resolved_reason text check (resolved_reason is null or length(resolved_reason) <= 200);

-- --- balance identity: incremental deposit ledger ------------------------------------------------------------------------------
-- deposits = sum of token Transfer(to = vault) logs in [start, scanned_through]. Scanned once, then incrementally.
create table reconciler_ledger (
  tenant_id uuid primary key references tenants(id),
  vault_address text not null,
  token_address text not null,
  scanned_through bigint not null check (scanned_through >= -1),
  deposits_base_units numeric(78,0) not null check (deposits_base_units >= 0),
  updated_at timestamptz not null default now()
);
alter table reconciler_ledger enable row level security;
revoke all on table reconciler_ledger from public, anon, authenticated;
