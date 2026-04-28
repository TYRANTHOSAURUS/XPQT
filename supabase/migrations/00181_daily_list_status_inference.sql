-- Daily-list Sprint 4 — status inference for paper-only vendors.
--
-- Spec §8: paper-only vendors don't self-report fulfillment status, so
-- vendor scorecards (booking-services-roadmap §9.1.3) are blank for
-- ~50% of NL/BE vendors. The Sprint 4 status-inference worker auto-
-- transitions order_line_items.fulfillment_status based on the
-- delivery time clock:
--
--   ordered    → preparing  when now() >= delivery_time - 1h
--   preparing  → delivered  when now() >= delivery_time + grace_minutes
--
-- Override: desk operators (or vendors via portal in hybrid mode) can
-- change status manually at any time. Manual changes set
-- manual_status_set_at; the inference worker skips rows where it's
-- non-null so a manual decision is final.
--
-- Audit: every inferred transition is emitted with
-- event_source='inferred' (vs 'manual' / 'portal' / 'webhook' for
-- self-reported transitions). Scorecards use this to surface the
-- distinction so FM directors don't conflate inferred-on-time with
-- self-reported-on-time.
--
-- Sprint 4 follow-up (separate slice): scorecards integration to
-- weight inferred vs self-reported.

alter table public.order_line_items
  add column if not exists manual_status_set_at  timestamptz,
  add column if not exists status_inferred_at    timestamptz,
  /* Populated when fulfillment_status is changed by the inference
     worker. NULL on rows that have only been touched by manual /
     portal / webhook updates. */
  add column if not exists status_event_source   text;

-- Constrain status_event_source to a small enum at the column level.
-- Adopting a CHECK rather than an enum type keeps later additions
-- (e.g. 'mobile' for the vendor app) cheap.
alter table public.order_line_items
  drop constraint if exists oli_status_event_source_chk;
alter table public.order_line_items
  add constraint oli_status_event_source_chk check (
    status_event_source is null
    or status_event_source in ('manual','portal','webhook','inferred','migration')
  );

-- Backfill: rows that already have a non-default status are 'manual'
-- (legacy edits via the desk UI). Ones still in 'ordered' stay null
-- so the inference worker can pick them up if eligible.
update public.order_line_items
   set status_event_source = 'manual'
 where status_event_source is null
   and fulfillment_status not in ('ordered');

-- Worker hot-path index — only the rows actually eligible for
-- inference: paper_only vendor + non-manual + service_window set.
-- The worker JOINs vendors so we filter there rather than materialise
-- the predicate in this index.
create index if not exists idx_oli_status_inference_pending
  on public.order_line_items (tenant_id, fulfillment_status, service_window_start_at)
  where manual_status_set_at is null
    and fulfillment_status in ('ordered','preparing')
    and service_window_start_at is not null;

comment on column public.order_line_items.manual_status_set_at is
  'When the fulfillment_status was last set by a human (desk operator) '
  'or vendor self-report. The Sprint 4 inference worker SKIPs rows where '
  'this is non-null so manual decisions are final.';
comment on column public.order_line_items.status_inferred_at is
  'When the fulfillment_status was last set by the Sprint 4 inference '
  'worker for paper_only vendors. Matched 1:1 to the audit_outbox row '
  'with event_source=''inferred''.';
comment on column public.order_line_items.status_event_source is
  'Provenance of the most recent fulfillment_status mutation: manual, '
  'portal, webhook, inferred, or migration (legacy backfill).';

notify pgrst, 'reload schema';
