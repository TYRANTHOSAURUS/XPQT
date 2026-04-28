-- Daglijst Phase A · Sprint 2 codex fix
-- Adds 'sending' to vendor_daily_lists.email_status so the scheduler can
-- CAS-acquire a row from never_sent → sending atomically (codex review
-- finding #1: advisory lock alone wasn't enough because generate()/send()
-- ran in different transactions; the lock got released between them and
-- a second worker could mint v2 while v1 was still being mailed).
--
-- The CAS on email_status enforces "exactly one worker per row at a time"
-- without any additional advisory locking — Postgres handles it via the
-- row's MVCC snapshot + serialized UPDATE. The scheduler's per-bucket
-- advisory lock stays as a coarser belt-and-braces against double-version
-- creation.

alter table public.vendor_daily_lists
  drop constraint if exists daglijst_email_status_chk;

alter table public.vendor_daily_lists
  add constraint daglijst_email_status_chk check (
    email_status is null or email_status in
      ('queued','sending','sent','delivered','bounced','failed','never_sent')
  );

comment on column public.vendor_daily_lists.email_status is
  'Email-delivery state machine. never_sent → sending → sent (success) | failed (terminal). '
  'queued/delivered/bounced added for Sprint 4 provider-callback path. '
  'CAS transitions enforce exactly-one-sender per row; see DaglijstSchedulerService.';

notify pgrst, 'reload schema';
