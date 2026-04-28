-- Daglijst Sprint 2 codex round-3 review — lease fencing + backfill stuck rows.
--
-- Round-2 fix introduced sending_acquired_at + a sweeper but did not fence
-- the post-CAS UPDATEs against lease revocation. Cross-instance race:
--   - worker A CASes the row, mailer hangs (>5 min)
--   - sweeper on worker B reclaims A's row to 'failed'
--   - worker A's mailer finally returns; A then UPDATEs to 'sent'
--   - worker B's retry has already CAS-acquired and may be mid-mailer too
--   - we lose state authority.
--
-- Fix at the application layer (this migration only needs to support it):
-- the CAS UPDATE returns sending_acquired_at (the "lease timestamp"); every
-- subsequent UPDATE conditions on `email_status='sending' AND
-- sending_acquired_at = $LEASE_TS`. If the predicate fails (sweeper or
-- another worker has moved on), the late writer's UPDATE matches 0 rows
-- and the application abandons it — no state corruption. The mail
-- provider's idempotency-key (stable per (id, version)) handles
-- accidental double-sends.
--
-- Migration only addresses the data-side gaps:
--
-- 1. Backfill: rows that are already in 'sending' with NULL
--    sending_acquired_at (created before 00176) would never be picked up
--    by the sweeper because the predicate requires `is not null`. Set
--    them to a far-past timestamp so the next sweeper tick reclaims them.
--
-- 2. (No new column.) The lease token is just sending_acquired_at itself —
--    set on every CAS, returned, and used as the fence on subsequent
--    writes. Adding a uuid token would be safer in theory but the
--    timestamp is already monotonically incremented per CAS attempt and
--    is sufficient for the realistic concurrency model (≤2 scheduler
--    instances + occasional admin "send now").

update public.vendor_daily_lists
   set sending_acquired_at = '1970-01-01T00:00:00Z'
 where email_status = 'sending'
   and sending_acquired_at is null;

comment on column public.vendor_daily_lists.sending_acquired_at is
  'Timestamp when the CAS UPDATE flipped email_status to ''sending''. '
  'Doubles as the fencing token: post-CAS UPDATEs (success/failure) '
  'condition on email_status=''sending'' AND sending_acquired_at=$lease '
  'so a stale worker cannot overwrite state after the sweeper or another '
  'worker has moved on. NULL on every other state.';
