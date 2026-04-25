-- 00120_spaces_room_booking_columns.sql
-- Operational config per room for the room booking module.
-- Reuses public.business_hours_calendars (00006) for default_calendar_id.

alter table public.spaces
  add column if not exists min_attendees int,
  add column if not exists setup_buffer_minutes int not null default 0,
  add column if not exists teardown_buffer_minutes int not null default 0,
  add column if not exists check_in_required boolean not null default false,
  add column if not exists check_in_grace_minutes int not null default 15,
  add column if not exists cost_per_hour numeric(10,2),                       -- chargeback stub
  add column if not exists default_calendar_id uuid references public.business_hours_calendars(id),
  add column if not exists default_search_keywords text[] not null default '{}',
  add column if not exists calendar_sync_mode text not null default 'pattern_a'
    check (calendar_sync_mode in ('pattern_a','pattern_b')),
  add column if not exists external_calendar_id text,
  add column if not exists external_calendar_provider text
    check (external_calendar_provider in ('outlook')),
  add column if not exists external_calendar_subscription_id text,
  add column if not exists external_calendar_subscription_expires_at timestamptz,
  add column if not exists external_calendar_last_full_sync_at timestamptz,
  add column if not exists floor_plan_polygon jsonb;

create index if not exists idx_spaces_external_calendar
  on public.spaces (external_calendar_subscription_expires_at)
  where calendar_sync_mode = 'pattern_a' and external_calendar_subscription_id is not null;

notify pgrst, 'reload schema';
