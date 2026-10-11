-- 0001_init.sql  (WP-09, KERNEL-SVC)  docs/05 section 3.  APPEND-ONLY: never edit this file once applied anywhere;
-- later changes go in a new numbered migration (0002_v2.sql is docs/05 section 3b, 0003 is the WP-09 hardening layer).
--
-- Layout: (1) default-privilege lockdown, (2) the section 3 DDL verbatim, (3) supplementary indexes and the
-- public_amounts opt-in column, (4) RLS on every table, (5) the sanitized public views, (6) grants.
--
-- Supabase facts this file relies on (VERIFY(V-15): not checked on a real Supabase project, local Postgres is not
-- Supabase; CI's `supabase db reset` is authoritative):
--   * migrations run as role `postgres`, which owns the tables; roles anon / authenticated / service_role exist;
--   * Supabase's default privileges GRANT ALL on new public tables to anon, authenticated and service_role, so
--     RLS alone would be the only wall. We remove those default grants (defense in depth) and then enable RLS
--     with NO policies: anon and authenticated can read nothing in a base table, even if a grant came back;
--   * service_role has BYPASSRLS: the kernel service is the only writer and reader of base tables;
--   * public views are owned by postgres and are deliberately NOT security_invoker: they run with the owner's
--     rights (the owner is not subject to RLS because RLS is not FORCEd), which is how anon can read sanitized
--     aggregates but no base table. Supabase's linter flags SECURITY DEFINER views (lint 0010); this is the
--     intended pattern here, and each view lists exactly the columns it exposes.

-- (1) Nothing created from here on is granted to the API roles by default.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- (2) docs/05 section 3, verbatim.
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

-- (3) Supplementary, not in docs/05: foreign-key indexes for the views and the kernel's hot paths, and the
-- per-tenant opt-in that docs/05 section 3 requires for amounts on public_receipts ("amounts only if tenant opted in").
alter table tenants add column public_amounts boolean not null default false;
create index on engagements (tenant_id);
create index on milestones (engagement_id);
create index on intents (tenant_id, created_at desc);
create index on evidence (milestone_id);
create index on approvals (intent_id);
create index on releases (decision_id);
create index on chain_events (tenant_id);
create index on traction_events (tenant_id);
create index on attack_results (run_id);
create index on blast_reports (created_at desc);

-- (4) RLS: enabled on every table, NO policies. anon and authenticated are denied; service_role bypasses.
-- Not FORCEd on purpose (see header): the owning role must still read the tables on behalf of the views.
alter table tenants enable row level security;
alter table engagements enable row level security;
alter table milestones enable row level security;
alter table documents enable row level security;
alter table intents enable row level security;
alter table decisions enable row level security;
alter table receipts enable row level security;
alter table evidence enable row level security;
alter table approvals enable row level security;
alter table releases enable row level security;
alter table chain_events enable row level security;
alter table reconciliations enable row level security;
alter table breaker_state enable row level security;
alter table receipt_acks enable row level security;
alter table agent_calls enable row level security;
alter table attack_runs enable row level security;
alter table attack_results enable row level security;
alter table blast_reports enable row level security;
alter table traction_events enable row level security;
alter table audit_log enable row level security;

-- (5) Public views: the ONLY thing anon can read. Allow-listed columns, no free text from untrusted sources.
-- Anything that originates outside our trust boundary (invoice text, payee labels, detail strings, LLM prose,
-- evidence payloads, raw documents) is never selected; identifiers coming from jsonb are re-validated against a
-- strict pattern so a hostile value becomes NULL instead of reaching a page (INV-15).

-- Receipts: hash, verdict, check ids/status/codes, reason codes, policy hash, tx hash; amounts only if the tenant opted in.
create view public_receipts with (security_barrier = true) as
select
  r.receipt_hash,
  case when d.verdict in ('RELEASE','HOLD','ESCALATE','REJECT','REPLAY') then d.verdict end as verdict,
  coalesce((
    select jsonb_agg(jsonb_build_object(
             'id',     case when c.v ->> 'id'     ~ '^K-[0-9A-Z]{1,8}$'       then c.v ->> 'id' end,
             'status', case when c.v ->> 'status' in ('PASS','FAIL','SKIP')   then c.v ->> 'status' end,
             'code',   case when c.v ->> 'code'   ~ '^[A-Z][A-Z0-9_]{0,63}$'  then c.v ->> 'code' end)
           order by c.ord)
    from jsonb_array_elements(case when jsonb_typeof(d.checks) = 'array' then d.checks else '[]'::jsonb end)
         with ordinality as c(v, ord)
  ), '[]'::jsonb) as checks,
  array(select x from unnest(d.reasons) as x where x ~ '^[A-Z][A-Z0-9_]{0,63}$') as reasons,
  d.policy_hash,
  rel.tx_hash,
  case when t.public_amounts then d.amount_base_units end as amount_base_units,
  r.issued_at,
  t.network,
  t.is_internal as demo
from receipts r
join decisions d on d.decision_id = r.decision_id
join tenants t on t.id = d.tenant_id
left join lateral (
  select x.tx_hash from releases x
  where x.decision_id = d.decision_id and x.status = 'CONFIRMED'
  order by x.confirmed_at nulls last limit 1
) rel on true;

-- Pilot traction, v1 form (is_internal based). 0002_v2.sql drops and rebuilds it on tenants.kind (INV-17).
create view public_pilot_stats as
select t.network,
       count(distinct t.id) as businesses,
       count(rel.release_id) as releases,
       coalesce(sum(d.amount_base_units) filter (where rel.release_id is not null), 0) as value_base_units
from tenants t
left join decisions d on d.tenant_id = t.id
left join releases rel on rel.decision_id = d.decision_id and rel.status = 'CONFIRMED'
where not t.is_internal
group by t.network;

create view public_traction_summary as
select
  count(distinct t.id) filter (where not t.is_internal) as businesses_onboarded,
  count(distinct t.id) filter (where not t.is_internal and t.network = 'mainnet') as businesses_mainnet,
  count(*) filter (where te.kind = 'release' and te.real and not t.is_internal) as real_payments,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.real and te.network = 'mainnet' and not t.is_internal), 0) as mainnet_value_base_units,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.network = 'testnet' and not t.is_internal), 0) as testnet_value_base_units,
  (select count(*) from blast_reports where tenant_id is null) as audits_run
from tenants t left join traction_events te on te.tenant_id = t.id;

-- Latest finished attack run: per attack and target, outcome and loss. No `detail` jsonb (may carry fixture text).
create view public_attack_latest with (security_barrier = true) as
with latest as (
  select run_id, mode, finished_at, git_sha
  from attack_runs where finished_at is not null
  order by finished_at desc limit 1
)
select l.run_id, l.mode, l.finished_at, l.git_sha,
       a.attack_id, a.target, a.outcome, a.loss_base_units, a.checks_fired
from latest l join attack_results a on a.run_id = l.run_id;

-- Latest Blast Radius audit per threat model, tenant-less (sample / public) reports only. No vault_config, no report body.
create view public_blast_latest with (security_barrier = true) as
select distinct on (b.threat_model)
       b.threat_model, b.policy_hash, b.bound_24h, b.bound_7d, b.trials, b.violations, b.created_at
from blast_reports b
where b.tenant_id is null
order by b.threat_model, b.created_at desc;

-- (6) Grants: the API roles get SELECT on the public views and nothing else.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant select on public_receipts, public_pilot_stats, public_traction_summary, public_attack_latest, public_blast_latest
  to anon, authenticated;
