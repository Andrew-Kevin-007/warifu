-- 0006_circle_webhooks.sql  (WP-11, KERNEL-SVC)  APPEND-ONLY.
-- Idempotency + audit for the Circle webhook receiver (RT-30, SEC-12). One row per verified notification, keyed by the
-- notificationId Circle signs inside the body. A webhook only TRIGGERS an indexer pass (docs/06 B.2): this table never
-- confirms a release (K-15 trusts chain events), it only remembers which notifications were seen and whether the trigger
-- ran, so a replay of the same notification is a no-op and a failed trigger is retried by Circle's own redelivery.
-- Service-owned: the API roles get no access.

create table circle_webhook_events (
  notification_id text primary key check (length(notification_id) between 1 and 128),
  notification_type text not null check (length(notification_type) between 1 and 80),
  circle_tx_id text check (circle_tx_id is null or length(circle_tx_id) <= 64),
  state text check (state is null or length(state) <= 40),
  tx_hash text check (tx_hash is null or tx_hash ~ '^0x[0-9a-f]{64}$'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  event_at timestamptz not null,
  received_at timestamptz not null default now(),
  triggered_at timestamptz
);
create index circle_webhook_events_received_idx on circle_webhook_events (received_at);
alter table circle_webhook_events enable row level security;

revoke all on table circle_webhook_events from public, anon, authenticated;
