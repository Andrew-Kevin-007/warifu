-- 0004_service_token_nonces.sql  (WP-10, KERNEL-SVC)  APPEND-ONLY.
-- Replay protection for web -> kernel service tokens (RT-31, SEC-14). The nonce store is the database, so a token
-- captured on one kernel instance cannot be replayed against another, and a restart forgets nothing. The service
-- keeps an in-memory cache only as a fast first check. Service-owned: the API roles get no access at all.
--
-- claim_service_token_nonce() answers 'OK' exactly once per nonce (INSERT ... ON CONFLICT DO NOTHING, row count 1);
-- 'REPLAYED' means the nonce was already used. It also purges expired rows (bounded batch, 5 minute grace
-- over the token's own expiry), so the table cannot grow without bound. Any error is the caller's to treat as a reject.

create table service_token_nonces (
  nonce text primary key check (length(nonce) between 16 and 64),
  tenant_id uuid not null,
  expires_at timestamptz not null,
  claimed_at timestamptz not null default now()
);
create index service_token_nonces_expires_at_idx on service_token_nonces (expires_at);
alter table service_token_nonces enable row level security;

-- The DATABASE clock is authoritative at claim time. The app judges a token's expiry with its own clock, but a nonce
-- row is purged by this clock, so a claim is accepted only while the token is live by THIS clock and its stated life
-- is within the 60 s ceiling plus 5 s skew allowance. A row can therefore be purged only after its token has expired
-- by the same clock that claimed it: an app clock that lags the database cannot resurrect a purged nonce, because the
-- claim itself would then answer EXPIRED. Result: 'OK' (first use), 'REPLAYED', 'EXPIRED' or 'TTL_TOO_LONG'.
create function claim_service_token_nonce(p_nonce text, p_tenant uuid, p_expires timestamptz)
returns text language plpgsql set search_path = public, pg_temp as $$
declare
  v_rows int;
  v_now timestamptz := clock_timestamp();
begin
  if p_nonce is null or p_tenant is null or p_expires is null then
    raise exception 'claim_service_token_nonce: nonce, tenant and expiry are required';
  end if;
  if p_expires <= v_now then return 'EXPIRED'; end if;
  if p_expires > v_now + interval '65 seconds' then return 'TTL_TOO_LONG'; end if;
  delete from service_token_nonces
   where nonce in (select nonce from service_token_nonces where expires_at < v_now - interval '5 minutes' order by expires_at limit 200);
  insert into service_token_nonces (nonce, tenant_id, expires_at) values (p_nonce, p_tenant, p_expires)
    on conflict (nonce) do nothing;
  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'OK' else 'REPLAYED' end;
end $$;

-- Same lockdown pattern as 0001-0003: nothing for the API roles.
revoke all on table service_token_nonces from public, anon, authenticated;
revoke all on function claim_service_token_nonce(text, uuid, timestamptz) from public, anon, authenticated;
