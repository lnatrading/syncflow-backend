-- ============================================================
--  AB.pl address cache (safeguard #5 — see orderClients/ABClient.js)
--  regaddr is async (ticket_id -> poll checkticket -> address_code),
--  so addresses are pre-registered ahead of time and cached here
--  rather than resolved inline during order placement.
--
--  Run this manually against Supabase (SQL editor or migration tool) —
--  Syncflow has no tracked migration system yet (flagged as an open
--  process-hygiene item in the Aug 2026 handover notes).
-- ============================================================
create table if not exists ab_addresses (
  id            bigserial primary key,
  address_hash  text unique not null,
  label         text,
  ticket_id     text,
  address_code  text,
  status        text not null default 'pending', -- pending | ready | failed
  raw_address   jsonb not null,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_ab_addresses_status on ab_addresses (status);
