-- 00263_visitor_invite_mail_delivery_events.sql
-- Visitor Management v1 — extend email_delivery_events for visitor invite emails.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.10
-- Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.10
--
-- The mail-delivery webhook ingestion already exists (00183_mail_delivery_events.sql)
-- for vendor portal emails. Visitor invite emails follow the same pattern:
-- when the email provider POSTs a delivery / bounce event, the receiver
-- correlates by provider_message_id and writes a row keyed by
-- (correlated_entity_type='visitor_invite', correlated_entity_id=visitor.id).
--
-- v1 adds 'visitor_invite' to the existing CHECK constraint enum. That's
-- the entire schema delta — the table shape is unchanged, the receiver
-- gets a new branch, and ReceptionService can join visitors → these rows
-- on (correlated_entity_id = visitor.id, correlated_entity_type = 'visitor_invite').

alter table public.email_delivery_events
  drop constraint if exists email_delivery_events_correlated_entity_type_check;

alter table public.email_delivery_events
  add constraint email_delivery_events_correlated_entity_type_check
  check (correlated_entity_type in (
    'vendor_daily_list',
    'vendor_user_magic_link',
    'visitor_invite',
    'unknown'
  ));

comment on column public.email_delivery_events.correlated_entity_type is
  'What kind of entity this delivery event correlates to. visitor_invite added in 00263 for the v1 visitor management module — Reception''s "yesterday''s loose ends" tile JOINs visitors → events on this column + correlated_entity_id.';

notify pgrst, 'reload schema';
