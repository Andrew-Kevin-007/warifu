-- 0003_hardening.sql  (WP-09, KERNEL-SVC)  APPEND-ONLY.
-- Things docs/05 states or implies but whose SQL it does not give, kept out of 0002 so that 0002 stays
-- statement-for-statement the doc's section 3b. Every item below is listed in docs/QUESTIONS.md (WP-09).
--   1. is_internal is really derived from tenants.kind (05 3b: "kept for compatibility and derived").
--   2. documents.storage_key becomes nullable (05 section 2 Document.storageKey is `string | null`; INV-23: the
--      kernel keeps text plus a blob hash, a pasted invoice has no object).
--   3. deployment_profile is write-once (INV-16: flipping the profile would defeat the guard); search_path pinned.
--   4. Sandbox-only guard on challenge_scenarios / challenge_attempts (SEC-04b: "on a production DB, inserting a
--      challenge_attempts row is refused"; 0002's trigger only covers tenants).
--   5. Shape constraints on challenge_attempts (untrusted text bounded; hashes, verdicts, predicates validated).
--   6. Public views: traction ignores traction_events.internal (AGENTS 6: self-dealing is excluded from public
--      stats); public_attack_latest shows the `core` suite only (hold-out results stay private).
--   7. Atomic LLM budget ledger (INV-21 / RT-04 / 15 section 4: "the check is in the same transaction as the call
--      reservation"): llm_budget_reserve / _commit / _record_cache_hit. Money is integer micro-USD, never float.
--   8. Retention (15 section 9, RT-27/28): challenge_purge_expired() nulls full_text after 30 days and ip_hash
--      after 7 days.

-- 1. is_internal derives from kind.
create function sync_tenant_internal() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.is_internal := (new.kind <> 'pilot');
  return new;
end $$;
create trigger tenants_sync_internal before insert or update of kind, is_internal on tenants
  for each row execute function sync_tenant_internal();
update tenants set is_internal = (kind <> 'pilot') where is_internal is distinct from (kind <> 'pilot');
-- Belt and braces: even with the trigger disabled (replica role, a test that disables triggers), the flag cannot
-- disagree with kind, so no code path that still reads is_internal can count a demo/challenge tenant as a pilot.
alter table tenants add constraint tenants_internal_matches_kind check (is_internal = (kind <> 'pilot'));

-- 2. Pasted text has no stored object.
alter table documents alter column storage_key drop not null;

-- 3. Profile is written once, by provisioning (scripts/set-db-profile.ts), and never changed.
alter function enforce_tenant_kind() set search_path = public, pg_temp;
create function deployment_profile_write_once() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'deployment_profile is write-once (INV-16)';
end $$;
create trigger deployment_profile_immutable before update or delete on deployment_profile
  for each row execute function deployment_profile_write_once();
create trigger deployment_profile_no_truncate before truncate on deployment_profile
  for each statement execute function deployment_profile_write_once();

-- 4. Challenge data lives only in a sandbox DB.
create function enforce_sandbox_only() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare p text;
begin
  select profile into p from deployment_profile where id = 1;
  if p is null then raise exception 'deployment_profile not set'; end if;
  if p <> 'sandbox' then raise exception 'challenge data only in sandbox DB'; end if;
  return new;
end $$;
create trigger challenge_scenarios_sandbox_only before insert or update on challenge_scenarios
  for each row execute function enforce_sandbox_only();
create trigger challenge_attempts_sandbox_only before insert or update on challenge_attempts
  for each row execute function enforce_sandbox_only();

-- 5. Attacker-controlled text is bounded in the database as well as in the service (RT-01/04, INV-15).
alter table challenge_attempts
  add constraint challenge_attempts_excerpt_len check (char_length(excerpt) <= 240),
  add constraint challenge_attempts_text_len check (text_length between 0 and 4096),
  add constraint challenge_attempts_full_text_len check (full_text is null or octet_length(full_text) <= 4096),
  add constraint challenge_attempts_text_hash_fmt check (text_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint challenge_attempts_ip_hash_fmt check (ip_hash is null or ip_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint challenge_attempts_receipt_hash_fmt check (receipt_hash is null or receipt_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint challenge_attempts_tx_hash_fmt check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint challenge_attempts_verdict_enum check (verdict in ('RELEASE','HOLD','ESCALATE','REJECT','REPLAY')),
  add constraint challenge_attempts_predicates_enum check (oracle_predicates <@ array['O1','O2','O3','O4','O5','O6','O7','O8']::text[]);

-- LLM ledger rows are non-negative, and a cache hit never bills.
alter table llm_budget_ledger
  add constraint llm_budget_ledger_nonneg check (tokens_in >= 0 and tokens_out >= 0 and est_usd >= 0),
  add constraint llm_budget_ledger_cache_hit_free check (not cache_hit or est_usd = 0);

-- 6a. Traction views: self-dealing events (traction_events.internal) never count. Same columns as 0002.
create or replace view public_traction_summary as
select
  count(distinct t.id) filter (where t.kind = 'pilot') as businesses_onboarded,
  count(distinct t.id) filter (where t.kind = 'pilot' and t.network = 'mainnet') as businesses_mainnet,
  count(*) filter (where te.kind = 'release' and te.real and not te.internal and t.kind = 'pilot') as real_payments,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and te.real and not te.internal and te.network = 'mainnet' and t.kind = 'pilot'), 0) as mainnet_value_base_units,
  coalesce(sum(te.amount_base_units) filter (where te.kind = 'release' and not te.internal and te.network = 'testnet' and t.kind = 'pilot'), 0) as testnet_value_base_units,
  (select count(*) from blast_reports where tenant_id is null) as audits_run
from tenants t left join traction_events te on te.tenant_id = t.id;

-- 6b. Public attack results: the core suite only. Same columns as 0001.
create or replace view public_attack_latest with (security_barrier = true) as
with latest as (
  select run_id, mode, finished_at, git_sha
  from attack_runs where finished_at is not null and suite = 'core'
  order by finished_at desc limit 1
)
select l.mode, l.finished_at, l.git_sha,
       a.attack_id, a.target, a.outcome, a.loss_base_units, a.checks_fired
from latest l join attack_results a on a.run_id = l.run_id;

-- 6c. public_receipts flags demo/challenge receipts from `kind` (the source of truth), not from the derived flag.
-- Same columns, same order as 0001. After this migration no public view reads tenants.is_internal.
create or replace view public_receipts with (security_barrier = true) as
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
  (t.kind <> 'pilot') as demo
from receipts r
join decisions d on d.decision_id = r.decision_id
join tenants t on t.id = d.tenant_id
left join lateral (
  select x.tx_hash from releases x
  where x.decision_id = d.decision_id and x.status = 'CONFIRMED'
  order by x.confirmed_at nulls last limit 1
) rel on true;

-- 7. Atomic budget ledger. One transaction-scoped advisory lock serializes every reservation, so "check the remaining
-- budget, then book" cannot interleave (no burst overshoots by even one call). The day is the database's UTC date;
-- nothing the caller passes can move or reset the window. Amounts are integer micro-USD (bigint) in, numeric(10,6) USD
-- in the table (1 micro-USD = 0.000001 USD, exact). A refusal returns NULL and writes nothing; the caller then fails
-- closed to replay mode (RT-04). The caller (kernel service, service_role) passes its configured caps.
create function llm_budget_reserve(
  p_principal_hash text, p_role text, p_tokens_in int, p_tokens_out int,
  p_max_cost_micro_usd bigint, p_global_cap_micro_usd bigint, p_principal_cap_micro_usd bigint
) returns bigint language plpgsql set search_path = public, pg_temp as $$
declare
  v_day date;
  v_global numeric;
  v_principal numeric;
  v_id bigint;
begin
  if p_principal_hash is null or p_principal_hash = '' or p_role is null or p_role = '' then
    raise exception 'llm_budget_reserve: principal_hash and role are required';
  end if;
  if p_tokens_in is null or p_tokens_in < 0 or p_tokens_out is null or p_tokens_out < 0 then
    raise exception 'llm_budget_reserve: token counts must be non-negative';
  end if;
  if p_max_cost_micro_usd is null or p_max_cost_micro_usd < 0 or p_max_cost_micro_usd > 9999999999
     or p_global_cap_micro_usd is null or p_global_cap_micro_usd < 0
     or p_principal_cap_micro_usd is null or p_principal_cap_micro_usd < 0 then
    raise exception 'llm_budget_reserve: costs and caps must be non-negative integers (cost below 10000 USD)';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('symbolon.llm_budget', 0));
  v_day := (now() at time zone 'utc')::date;
  select coalesce(sum(est_usd), 0) * 1000000 into v_global from llm_budget_ledger where day = v_day;
  select coalesce(sum(est_usd), 0) * 1000000 into v_principal
    from llm_budget_ledger where day = v_day and principal_hash = p_principal_hash;
  if v_global + p_max_cost_micro_usd > p_global_cap_micro_usd
     or v_principal + p_max_cost_micro_usd > p_principal_cap_micro_usd then
    return null;
  end if;
  insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd, cache_hit)
    values (v_day, p_principal_hash, p_role, p_tokens_in, p_tokens_out, p_max_cost_micro_usd::numeric / 1000000, false)
    returning id into v_id;
  return v_id;
end $$;

-- Settle a reservation to the actual spend. Only ever downwards: the reservation was the maximum possible cost, so
-- a larger "actual" means the caller's bound was wrong; that is an error, never a silent overspend.
create function llm_budget_commit(
  p_id bigint, p_tokens_in int, p_tokens_out int, p_cost_micro_usd bigint
) returns void language plpgsql set search_path = public, pg_temp as $$
declare
  v_reserved numeric;
  v_cache boolean;
begin
  if p_tokens_in is null or p_tokens_in < 0 or p_tokens_out is null or p_tokens_out < 0
     or p_cost_micro_usd is null or p_cost_micro_usd < 0 then
    raise exception 'llm_budget_commit: token counts and cost must be non-negative';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('symbolon.llm_budget', 0));
  select est_usd * 1000000, cache_hit into v_reserved, v_cache from llm_budget_ledger where id = p_id for update;
  if not found then raise exception 'llm_budget_commit: unknown reservation'; end if;
  if v_cache then raise exception 'llm_budget_commit: a cache hit has no reservation'; end if;
  if p_cost_micro_usd > v_reserved then
    raise exception 'llm_budget_commit: actual cost exceeds the reservation';
  end if;
  update llm_budget_ledger
    set tokens_in = p_tokens_in, tokens_out = p_tokens_out, est_usd = p_cost_micro_usd::numeric / 1000000
    where id = p_id;
end $$;

-- A content-hash cache hit is recorded (so it is visible) but costs nothing.
create function llm_budget_record_cache_hit(p_principal_hash text, p_role text) returns bigint
language plpgsql set search_path = public, pg_temp as $$
declare v_id bigint;
begin
  if p_principal_hash is null or p_principal_hash = '' or p_role is null or p_role = '' then
    raise exception 'llm_budget_record_cache_hit: principal_hash and role are required';
  end if;
  insert into llm_budget_ledger (day, principal_hash, role, tokens_in, tokens_out, est_usd, cache_hit)
    values ((now() at time zone 'utc')::date, p_principal_hash, p_role, 0, 0, 0, true)
    returning id into v_id;
  return v_id;
end $$;

-- 8. Retention. Run daily by the sandbox kernel (service_role). Returns how many rows each rule touched.
create function challenge_purge_expired(p_now timestamptz default now())
returns table (full_text_purged bigint, ip_hash_purged bigint)
language plpgsql set search_path = public, pg_temp as $$
declare a bigint; b bigint;
begin
  update challenge_attempts set full_text = null
    where full_text is not null and created_at < p_now - interval '30 days';
  get diagnostics a = row_count;
  update challenge_attempts set ip_hash = null
    where ip_hash is not null and created_at < p_now - interval '7 days';
  get diagnostics b = row_count;
  return query select a, b;
end $$;

-- Every relation, sequence and function in public is closed to the API roles; then the explicit allow-list below is
-- re-opened. (Supabase's default privileges grant ALL on new relations, views included, to anon / authenticated;
-- an owner-run view would otherwise leak past RLS. The tests apply those defaults before the migrations.)
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
-- Only the kernel service calls these.
revoke all on function llm_budget_reserve(text, text, int, int, bigint, bigint, bigint) from public, anon, authenticated;
revoke all on function llm_budget_commit(bigint, int, int, bigint) from public, anon, authenticated;
revoke all on function llm_budget_record_cache_hit(text, text) from public, anon, authenticated;
revoke all on function challenge_purge_expired(timestamptz) from public, anon, authenticated;
grant execute on function llm_budget_reserve(text, text, int, int, bigint, bigint, bigint) to service_role;
grant execute on function llm_budget_commit(bigint, int, int, bigint) to service_role;
grant execute on function llm_budget_record_cache_hit(text, text) to service_role;
grant execute on function challenge_purge_expired(timestamptz) to service_role;

grant select on public_receipts, public_pilot_stats, public_traction_summary, public_attack_latest, public_blast_latest
  to anon, authenticated;
