-- Outbox foundation amendment — outbox_shadow_results FK ON DELETE SET NULL
--
-- Spec: docs/superpowers/specs/2026-05-04-domain-outbox-design.md §13.1 (purge),
--       §5.2 (shadow gate).
-- Codex v3 review finding: I1 — `outbox_shadow_results.outbox_event_id`
-- previously referenced `outbox.events(id)` with default `NO ACTION`.
-- The worker's purge cron (`apps/api/src/modules/outbox/outbox.worker.ts:113`)
-- deletes processed events older than `OUTBOX_PURGE_AFTER_DAYS`. Once any
-- shadow row points at a processed event, purge fails with FK violation
-- forever — the only way out is hand-cleaning the shadow table or never
-- purging.
--
-- Fix: switch the FK to `ON DELETE SET NULL`. Shadow rows are diagnostic; the
-- (event_type, aggregate_id, recorded_at) triple plus the inline/shadow
-- outcomes are still useful even after the source event is purged. The audit
-- value is in the *comparison*, not the link to a long-gone row.

alter table public.outbox_shadow_results
  drop constraint if exists outbox_shadow_results_outbox_event_id_fkey;

alter table public.outbox_shadow_results
  add constraint outbox_shadow_results_outbox_event_id_fkey
  foreign key (outbox_event_id)
  references outbox.events(id)
  on delete set null;

comment on column public.outbox_shadow_results.outbox_event_id is
  'Optional back-link to the source outbox event. Nullable because the purge cron may have removed the source row; the diagnostic value is in the inline_outcome vs shadow_outcome comparison, not the link.';

notify pgrst, 'reload schema';
