-- 00266_visitors_v1_remaining_columns.sql
-- Visitor management v1 — three columns that service code already references
-- but no migration ever added.
--
-- Post-shipping review C1:
--   invitation.service.ts INSERT writes meeting_room_id, notes_for_visitor,
--   notes_for_reception. visitors.controller.ts SELECTs them. The email
--   templates render them. The reminder worker reads them. None of those
--   were tested against the live schema (the 391/391 backend test suite
--   uses mocked Supabase clients), and shipping migrations 00248-00265
--   missed all three. Endpoints currently 500 with
--   `column visitors.<col> does not exist` on remote.
--
-- No backfill needed — none of the existing rows ever had these.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.1
--   (denorm-on-visitors pattern — visitor-facing notes + reception-only
--    notes + meeting room are PII / operational data carried on the row
--    itself, not derived).

-- ---------------------------------------------------------------------------
-- 1. Columns. All nullable: an invite may have no meeting room (e.g. lobby
--    pickup), no visitor-facing note, and no reception-only note.
-- ---------------------------------------------------------------------------
alter table public.visitors
  add column if not exists meeting_room_id      uuid references public.spaces(id),
  add column if not exists notes_for_visitor    text,
  add column if not exists notes_for_reception  text;

comment on column public.visitors.meeting_room_id is
  'Optional meeting room (a public.spaces row, type=room) where the host will meet the visitor. Drives the email rendering ("Meet me in Room 3.14") and the reception arrival hint. Nullable: lobby pickup is a valid pattern.';
comment on column public.visitors.notes_for_visitor is
  'Optional note rendered into the visitor-facing invitation email. Visible to the visitor (plain text, no HTML). Treat as PII — anonymized by VisitorRecordsAdapter (00269).';
comment on column public.visitors.notes_for_reception is
  'Optional note shown to reception only — never to the visitor. Useful for context (allergy, VIP, dietary, accessibility). Treat as PII; same retention as notes_for_visitor.';

-- ---------------------------------------------------------------------------
-- 2. FK index for meeting_room_id. Partial — most rows are null.
-- ---------------------------------------------------------------------------
create index if not exists idx_visitors_meeting_room
  on public.visitors (tenant_id, meeting_room_id)
  where meeting_room_id is not null;

notify pgrst, 'reload schema';
