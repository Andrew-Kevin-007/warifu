-- supabase/seed.sql  (WP-09)  LOCAL DEVELOPMENT ONLY: runs after the migrations on `supabase db reset`.
-- Everything here is DEMO data (tenants.kind = 'demo', demo:true in the name). It is never counted as traction:
-- public_pilot_stats and public_traction_summary read kind = 'pilot' only (INV-17), and the seed contains no pilot.
-- No keys, no real addresses, no real tx hashes. Addresses are obviously synthetic; the policy is a placeholder
-- that the policy loader would reject (the real canonical policy and its hash come from packages/policy).
--
-- Real projects get their profile from scripts/set-db-profile.ts at provisioning, never from this file. A local reset
-- is not a deployment, so it is labelled 'production' here only so that a local production-profile kernel can boot
-- against it; on a project that already has a profile this insert does nothing.

insert into deployment_profile (id, profile) values (1, 'production') on conflict (id) do nothing;

insert into tenants (id, name, owner_address, chain_id, network, kind, policy, policy_hash)
values (
  '00000000-0000-4000-8000-00000000d3a0',
  'DEMO (demo:true) Acme Studio',
  '0x00000000000000000000000000000000000d3a01',
  31337,
  'local',
  'demo',
  '{"demo": true, "note": "placeholder, not a valid policy"}'::jsonb,
  '0x0000000000000000000000000000000000000000000000000000000000000000'
)
on conflict (id) do nothing;
