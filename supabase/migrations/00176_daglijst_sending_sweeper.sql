-- Daglijst Sprint 2 codex review (round 2) — crash-safe state machine.
--
-- Issue: the CAS state machine introduced in 00175 leaves rows stuck in
-- 'sending' if the worker process crashes or fails post-CAS but before
-- the explicit failure rollback (createSignedUrl throw, audit-emit DB
-- failure, OOM, k8s pod kill). Without a sweeper those rows are
-- unrecoverable.
--
-- Fix: track when the CAS to 'sending' happened, and let a periodic
-- sweeper roll rows that have been in 'sending' past a threshold back
-- to 'failed' so the next scheduler tick retries them.

alter table public.vendor_daily_lists
  add column if not exists sending_acquired_at timestamptz;

-- Sweeper hot-path index: only the rows actually stuck in 'sending' get
-- considered. Partial index keeps the index <100 rows in steady-state.
create index if not exists idx_vdl_sending_sweeper
  on public.vendor_daily_lists (sending_acquired_at)
  where email_status = 'sending';

comment on column public.vendor_daily_lists.sending_acquired_at is
  'Timestamp when the CAS UPDATE flipped email_status to ''sending''. '
  'NULL on every other state. The DaglijstService sweeper uses this to '
  'reclaim rows stuck in ''sending'' past a threshold (default 5 min).';
