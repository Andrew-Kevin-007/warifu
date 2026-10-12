-- 0004_service_token_nonces.sql  (WP-10, KERNEL-SVC)  APPEND-ONLY.
-- Replay protection for web -> kernel service tokens (RT-31, SEC-14). The nonce store is the database, so a token
-- captured on one kernel instance cannot be replayed against another, and a restart forgets nothing. The service
-- keeps an in-memory cache only as a fast first check. Service-owned: the API roles get no access at all.
--
-- claim_service_token_nonce() returns true exactly once per nonce (INSERT ... ON CONFLICT DO NOTHING, row count 1);
-- false means the nonce was already used (REPLAYED). It also purges expired rows (bounded batch, 5 minute grace
-- over the token's own expiry), so the table cannot grow without bound. Any error is the caller's to treat as a reject.

create table service_token_nonces (
  nonce text primary key check (length(nonce) between 16 and 64),
  tenant_id uuid not null,
  expires_at timestamptz not null,
  claimed_at timestamptz not null default now()
);
create index service_token_nonces_expires_at_idx on service_token_nonces (expires_at);
alter table service_token_nonces enable row level security;

create function claim_service_token_nonce(p_nonce text, p_tenant uuid, p_expires timestamptz)
returns boolean language plpgsql set search_path = public, pg_temp as $$
declare v_rows int;
begin
  if p_nonce is null or p_tenant is null or p_expires is null then
    raise exception 'claim_service_token_nonce: nonce, tenant and expiry are required';
  end if;
  delete from service_token_nonces
   where nonce in (select nonce from service_token_nonces where expires_at < now() - interval '5 minutes' order by expires_at limit 200);
  insert into service_token_nonces (nonce, tenant_id, expires_at) values (p_nonce, p_tenant, p_expires)
    on conflict (nonce) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end $$;

-- Same lockdown pattern as 0001-0003: nothing for the API roles.
revoke all on table service_token_nonces from public, anon, authenticated;
revoke all on function claim_service_token_nonce(text, uuid, timestamptz) from public, anon, authenticated;
