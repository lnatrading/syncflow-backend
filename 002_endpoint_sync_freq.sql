-- ============================================================
--  Migration 002 — Per-endpoint sync frequency
--  Run this against your Supabase project via the SQL editor
--  or Supabase CLI: supabase db push
-- ============================================================

-- Add per-endpoint frequency columns to supplier_endpoints
alter table public.supplier_endpoints
  add column if not exists sync_freq_minutes  integer,
  add column if not exists last_synced_at     timestamptz;

comment on column public.supplier_endpoints.sync_freq_minutes is
  'Optional override: fetch this endpoint only when this many minutes have elapsed since last_synced_at. '
  'NULL = always run with parent supplier. '
  'Use case: Mediamax fast feed (NULL = every 30 min) + complete catalog (1440 = once a day).';

comment on column public.supplier_endpoints.last_synced_at is
  'Timestamp of the last successful fetch of this endpoint. '
  'Used by syncEngine to determine if a per-endpoint schedule is due.';
