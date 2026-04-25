-- 00122_reservations_room_booking_columns.sql
-- The big reservations upgrade. Snapshots, status enum, recurrence, calendar sync, multi-room.
-- Effective window (effective_start_at/end_at + time_range) is maintained by a BEFORE trigger
-- because timestamptz arithmetic with interval is STABLE (not IMMUTABLE), which Postgres
-- requires for GENERATED ALWAYS expressions.
-- The trigger runs before INSERT/UPDATE so the conflict guard (00123) sees a current time_range.

-- Migrate existing seed data first: rows with old status='pending' become 'pending_approval'.
update public.reservations set status = 'pending_approval' where status = 'pending';

-- Status enum upgrade (full blueprint set).
alter table public.reservations
  drop constraint if exists reservations_status_check;

alter table public.reservations
  add constraint reservations_status_check
  check (status in ('draft','pending_approval','confirmed','checked_in','released','cancelled','completed'));

-- New columns (idempotent; non-generated)
alter table public.reservations
  add column if not exists setup_buffer_minutes int not null default 0,
  add column if not exists teardown_buffer_minutes int not null default 0,
  add column if not exists effective_start_at timestamptz,
  add column if not exists effective_end_at timestamptz,
  add column if not exists time_range tstzrange,

  add column if not exists check_in_required boolean not null default false,
  add column if not exists check_in_grace_minutes int not null default 15,
  add column if not exists checked_in_at timestamptz,
  add column if not exists released_at timestamptz,

  add column if not exists cancellation_grace_until timestamptz,

  add column if not exists policy_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists applied_rule_ids uuid[] not null default '{}',
  add column if not exists source text not null default 'portal'
    check (source in ('portal','desk','api','calendar_sync','auto','reception')),
  add column if not exists booked_by_user_id uuid references public.users(id),
  add column if not exists cost_amount_snapshot numeric(10,2),

  add column if not exists attendee_person_ids uuid[] not null default '{}',

  add column if not exists multi_room_group_id uuid,    -- FK added in 00125

  add column if not exists recurrence_master_id uuid references public.reservations(id),
  add column if not exists recurrence_index int,
  add column if not exists recurrence_overridden boolean not null default false,
  add column if not exists recurrence_skipped boolean not null default false,

  add column if not exists calendar_event_id text,
  add column if not exists calendar_provider text check (calendar_provider in ('outlook')),
  add column if not exists calendar_etag text,
  add column if not exists calendar_last_synced_at timestamptz,

  add column if not exists booking_bundle_id uuid;       -- FK added in sub-project 2

-- Trigger to maintain effective_start_at / effective_end_at / time_range from start_at + buffers.
create or replace function public.reservations_compute_effective_window()
returns trigger
language plpgsql
as $$
begin
  new.effective_start_at :=
    new.start_at - (interval '1 minute' * coalesce(new.setup_buffer_minutes, 0));
  new.effective_end_at :=
    new.end_at   + (interval '1 minute' * coalesce(new.teardown_buffer_minutes, 0));
  new.time_range := tstzrange(new.effective_start_at, new.effective_end_at, '[)');
  return new;
end;
$$;

drop trigger if exists set_reservations_effective_window on public.reservations;
create trigger set_reservations_effective_window
  before insert or update on public.reservations
  for each row execute function public.reservations_compute_effective_window();

-- Backfill existing rows so time_range is populated for the conflict guard.
update public.reservations
   set effective_start_at = start_at - (interval '1 minute' * coalesce(setup_buffer_minutes, 0)),
       effective_end_at   = end_at   + (interval '1 minute' * coalesce(teardown_buffer_minutes, 0))
 where effective_start_at is null;

update public.reservations
   set time_range = tstzrange(effective_start_at, effective_end_at, '[)')
 where time_range is null;

notify pgrst, 'reload schema';
