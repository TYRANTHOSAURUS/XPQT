-- Sprint 4 — mail-delivery webhook event ingestion.
--
-- Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md §11
--   + docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §6.
--
-- Posts from Postmark (delivery / bounce / complaint) land here, get
-- correlated to the originating vendor_daily_lists row by
-- email_message_id, and update the row's email_status. Raw event body
-- is preserved for audit / dispute resolution.

create table if not exists public.email_delivery_events (
  id                    uuid primary key default gen_random_uuid(),
  /* tenant_id is set when the receiver can correlate the event to a
     known message; events that don't match any known message stay
     tenant-less (NULL) and get a daily reconcile sweep. */
  tenant_id             uuid references public.tenants(id) on delete cascade,
  /* Provider-side message id (vendor_daily_lists.email_message_id /
     vendor magic-link send id). The webhook receiver looks this up to
     resolve the originating row. */
  provider_message_id   text not null,
  /* What kind of correlation we made — drives which downstream service
     gets called to update its row state. */
  correlated_entity_type text not null check (correlated_entity_type in (
    'vendor_daily_list',
    'vendor_user_magic_link',
    'unknown'
  )),
  correlated_entity_id  uuid,
  event_type            text not null check (event_type in (
    'delivered','bounced','complained','failed','queued','sent'
  )),
  bounce_type           text check (bounce_type in ('hard','soft','block','unknown')),
  recipient_email       text,
  reason                text,
  /* Provider's timestamp for the event. */
  occurred_at           timestamptz not null,
  /* When we ingested it. */
  received_at           timestamptz not null default now(),
  /* The raw event body Postmark POSTed — kept for audit + reprocessing. */
  raw_payload           jsonb not null
);

create index if not exists idx_edl_provider_msg
  on public.email_delivery_events (provider_message_id);
create index if not exists idx_edl_tenant_recv
  on public.email_delivery_events (tenant_id, received_at desc);
create index if not exists idx_edl_correlated
  on public.email_delivery_events (correlated_entity_type, correlated_entity_id);

comment on table public.email_delivery_events is
  'Inbound mail-delivery webhook events from Postmark / Resend / etc. '
  'Receiver correlates by provider_message_id, updates the originating '
  'row''s email_status, and emits a domain-specific audit event. '
  'Raw payload preserved for dispute resolution + reprocessing.';

-- RLS: nothing tenant-side reads this table directly — the webhook
-- receiver writes via service role, and downstream services read the
-- aggregate state from vendor_daily_lists.email_status. Lock down to
-- service-role-only.
alter table public.email_delivery_events enable row level security;
drop policy if exists email_delivery_events_service_role
  on public.email_delivery_events;
create policy email_delivery_events_service_role
  on public.email_delivery_events
  for all
  to authenticated
  using (false)
  with check (false);

notify pgrst, 'reload schema';
