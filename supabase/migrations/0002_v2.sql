-- 0002_v2.sql  (WP-09, KERNEL-SVC)  docs/05 section 3b.  APPEND-ONLY.
-- Everything between "BEGIN docs/05 3b" and "END docs/05 3b" is the section 3b SQL, statement for statement
-- (services/kernel/test/db/migration-static.test.ts compares it with the doc). The only additions inside are the
-- `releases_public` helper view that the doc's note asks for. After it: RLS and grants for the new objects, which
-- docs/05 states in prose ("RLS (v2): all new tables are RLS-enabled with no anon policy").
-- Not created here by design: `public_challenge_stats` (sandbox DB only, supabase/sandbox/public_challenge_stats.sql).

-- BEGIN docs/05 3b
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

-- helper view named in the doc's note: confirmed releases with tenant and the amount that actually left the vault
-- (the planner's discounted release amount when present, else the gross amount). Not granted to the API roles.
create view releases_public as
  select d.tenant_id, r.release_id, coalesce(d.release_amount_base_units, d.amount_base_units) as amount_base_units,
         r.tx_hash, r.confirmed_at
  from releases r join decisions d on d.decision_id = r.decision_id
  where r.status = 'CONFIRMED';

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
-- END docs/05 3b

-- RLS (v2): every new table is RLS-enabled with no policy for anon / authenticated; the kernel uses service_role.
alter table deployment_profile enable row level security;
alter table llm_budget_ledger enable row level security;
alter table challenge_scenarios enable row level security;
alter table challenge_attempts enable row level security;
alter table certificates enable row level security;
alter table replay_bundles enable row level security;

-- Grants: dropping and recreating a view drops its grants, so restate them. releases_public stays internal.
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
grant select on public_receipts, public_pilot_stats, public_traction_summary, public_attack_latest, public_blast_latest
  to anon, authenticated;
