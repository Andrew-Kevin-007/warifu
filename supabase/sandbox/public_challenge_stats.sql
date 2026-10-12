-- public_challenge_stats  (WP-09, KERNEL-SVC; docs/05 3b note, docs/15 section 8)
-- NOT a migration. Run once by the sandbox provisioning step, after migrations and after scripts/set-db-profile.ts has
-- written profile = 'sandbox'. It refuses to run on any other database, so the view cannot appear in a production DB.
--
-- Aggregate only: counts, never rows, never excerpts, never text. It is the ONLY thing anon reads about the challenge
-- (plus the replay bundle). It is not a traction view: pilot stats and the traction summary ignore challenge rows
-- by construction (INV-17), and this view is not referenced by them.
--
-- Fields of ChallengeStats that are NOT computed here, on purpose:
--   * asOf is the query time (as_of); `source: live|recorded` is set by the service / replay bundle.
--   * upper95LossRate (rule of three) is computed by the claims/stats script from attempts_distinct_human (INV-18).
--   * certifiedBoundBaseUnits comes from certificates, observedMaxLossBaseUnits from the oracle's per-attempt loss;
--     neither is stored per attempt, so the service fills them.
-- "Distinct human" counts distinct (text_hash, scenario_id) pairs; text_hash must be taken over the NFKC-normalized text.
-- falseRejects counts benign controls that the kernel REJECTed.

do $$
declare p text;
begin
  select profile into p from deployment_profile where id = 1;
  if p is distinct from 'sandbox' then
    raise exception 'public_challenge_stats may only be created in a sandbox DB (deployment_profile = %)', coalesce(p, 'unset');
  end if;
end $$;

create or replace view public_challenge_stats with (security_barrier = true) as
select
  now() as as_of,
  count(*) filter (where source = 'human') as attempts_human,
  count(distinct (text_hash, scenario_id)) filter (where source = 'human') as attempts_distinct_human,
  count(*) filter (where source = 'house') as attempts_house,
  count(*) filter (where source = 'oneclick') as attempts_oneclick,
  count(*) filter (where verdict = 'RELEASE') as outcome_release,
  count(*) filter (where verdict = 'HOLD') as outcome_hold,
  count(*) filter (where verdict = 'ESCALATE') as outcome_escalate,
  count(*) filter (where verdict = 'REJECT') as outcome_reject,
  count(*) filter (where verdict = 'REPLAY') as outcome_replay,
  count(*) filter (where oracle_result = 'LOSS') as loss_events_total,
  count(*) filter (where oracle_result = 'LOSS' and 'O1' = any (oracle_predicates)) as loss_o1,
  count(*) filter (where oracle_result = 'LOSS' and 'O2' = any (oracle_predicates)) as loss_o2,
  count(*) filter (where oracle_result = 'LOSS' and 'O3' = any (oracle_predicates)) as loss_o3,
  count(*) filter (where oracle_result = 'LOSS' and 'O4' = any (oracle_predicates)) as loss_o4,
  count(*) filter (where oracle_result = 'LOSS' and 'O5' = any (oracle_predicates)) as loss_o5,
  count(*) filter (where oracle_result = 'LOSS' and 'O6' = any (oracle_predicates)) as loss_o6,
  count(*) filter (where oracle_result = 'LOSS' and 'O7' = any (oracle_predicates)) as loss_o7,
  count(*) filter (where oracle_result = 'LOSS' and 'O8' = any (oracle_predicates)) as loss_o8,
  count(*) filter (where benign_control) as benign_n,
  count(*) filter (where benign_control and verdict = 'REJECT') as benign_false_rejects,
  count(distinct ip_hash) filter (where source = 'human') as unique_attackers,
  coalesce((
    select jsonb_agg(jsonb_build_object('code', s.code, 'count', s.n) order by s.n desc, s.code)
    from (
      select r as code, count(*) as n
      from challenge_attempts a2, unnest(a2.reasons) as r
      where r ~ '^[A-Z][A-Z0-9_]{0,63}$'
      group by r order by count(*) desc, r limit 10
    ) s
  ), '[]'::jsonb) as top_reason_codes
from challenge_attempts;

revoke all on public_challenge_stats from public, anon, authenticated;
grant select on public_challenge_stats to anon, authenticated;
