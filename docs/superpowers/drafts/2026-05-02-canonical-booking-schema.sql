-- ============================================================================
-- DRAFT — End-state canonical booking schema
-- ============================================================================
-- Status: NOT FOR APPLICATION YET — this is the design contract for the
-- booking-canonicalization rewrite (2026-05-02).
--
-- Approach: code-first. This file is the single-source-of-truth for the
-- target schema. Every implementation slice maps changes against this file.
-- Each column is cited from the source migration that introduced it (or
-- marked NEW where it didn't exist before).
--
-- Strategy: destructive rewrite. Old tables (`reservations`, `booking_bundles`,
-- `multi_room_groups`) get DROP CASCADE'd; this file's tables replace them.
-- All app code (services, controllers, hooks, components) is updated in the
-- same atomic deploy — see the slice plan in the companion design doc.
--
-- Renames (clean nouns, locked):
--   booking_bundles  -> bookings
--   reservations     -> booking_slots
--
-- Drops (legacy that doesn't earn its keep):
--   multi_room_groups          (collapsed into booking_id grouping)
--   bookings.bundle_type       (redundant with request_type / space_kind)
--   booking_slots.recurrence_master_id  (recurrence belongs on booking, not slot)
--   booking_slots.calendar_*   (calendar sync anchors on booking, not slot)
--   bookings.primary_reservation_id  (no longer needed; slot→booking is single-direction FK)
--
-- Adds:
--   bookings.title             NEW — was the original ship blocker
--   bookings.description       NEW
--   bookings.timezone          NEW — missing on reservations today (real bug)
--
-- Cyclic FK eliminated: slot.booking_id → bookings.id (single direction).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- bookings — the canonical "Booking" entity (replaces booking_bundles)
-- Sources: 00140_booking_bundles_and_templates.sql:6-35 +
--          lifted from 00122_reservations_room_booking_columns.sql where the
--          attribute is booking-level rather than slot-level.
-- ----------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),

  -- Identity (NEW — finally giving the booking a name)
  title text,                                                       -- NEW
  description text,                                                 -- NEW

  -- People
  requester_person_id uuid not null references public.persons(id),  -- 00140:11
  host_person_id      uuid references public.persons(id),           -- 00140:12 (nullable; derives to requester in app)
  booked_by_user_id   uuid references public.users(id),             -- 00122:38 (operator on behalf-of bookings)

  -- Time window (the booking's overall span; slots are inside this)
  start_at timestamptz not null,                                    -- 00140:18
  end_at   timestamptz not null,                                    -- 00140:19
  timezone text not null default 'UTC',                             -- NEW (00122 missing this — real bug)

  -- Status (booking-level; per-slot status lives on booking_slots)
  status text not null default 'confirmed' check (status in (
    'draft','pending_approval','confirmed','checked_in','released','cancelled','completed'
  )),                                                               -- 00122:17 lifted

  -- Source / provenance
  source text not null check (source in (
    'portal','desk','api','calendar_sync','reception','auto'
  )),                                                               -- unified from 00140:21-22 + 00122:36-37

  -- Cost + approvals
  cost_center_id        uuid references public.cost_centers(id),    -- 00140:23, FK at 00140:99
  cost_amount_snapshot  numeric(10,2),                              -- 00122:39
  policy_snapshot       jsonb not null default '{}'::jsonb,         -- 00122:34 + 00140:30 unified
  applied_rule_ids      uuid[] not null default '{}',               -- 00122:35
  config_release_id     uuid,                                       -- 00140:31

  -- Calendar sync (single canonical surface — was duplicated on bundle + reservation)
  calendar_event_id        text,                                    -- 00140:26 (canonical) + 00122:50 (deduped)
  calendar_provider        text check (calendar_provider in ('outlook') or calendar_provider is null),
  calendar_etag            text,                                    -- 00140:28 + 00122:52
  calendar_last_synced_at  timestamptz,                             -- 00140:29 + 00122:53

  -- Recurrence (each occurrence is its own booking; series links them)
  recurrence_series_id  uuid references public.recurrence_series(id),  -- recurrence_series from 00124
  recurrence_index      int,                                        -- 00122:46
  recurrence_overridden boolean not null default false,             -- 00122:47
  recurrence_skipped    boolean not null default false,             -- 00122:48

  -- Template provenance
  template_id uuid references public.bundle_templates(id),          -- 00140:24, FK at 00140:101
                                                                    -- (table itself stays; it's a config table)

  -- Audit
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_at > start_at)
);

alter table public.bookings enable row level security;
create policy "tenant_isolation" on public.bookings
  using (tenant_id = public.current_tenant_id());

create index idx_bookings_tenant            on public.bookings (tenant_id);
create index idx_bookings_requester         on public.bookings (requester_person_id);
create index idx_bookings_host              on public.bookings (host_person_id) where host_person_id is not null;
create index idx_bookings_window            on public.bookings (tenant_id, start_at);
create index idx_bookings_status            on public.bookings (tenant_id, status);
create index idx_bookings_recurrence_series on public.bookings (recurrence_series_id) where recurrence_series_id is not null;
create index idx_bookings_calendar_event    on public.bookings (calendar_event_id) where calendar_event_id is not null;

create trigger set_bookings_updated_at before update on public.bookings
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- booking_slots — the per-resource holdings (replaces reservations)
-- One booking has N slots: 1 for single-room, N for multi-room, etc.
-- Sources: 00014_reservations.sql + 00122_reservations_room_booking_columns.sql
--          (multi_room_groups concept dropped — booking_id replaces it)
-- ----------------------------------------------------------------------------
create table public.booking_slots (
  id uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants(id),
  booking_id uuid not null references public.bookings(id) on delete cascade,

  -- What's being held (one of room/desk/asset/parking; space_id always set; specific FKs follow space type)
  slot_type text not null check (slot_type in ('room','desk','asset','parking')),
                                                                    -- 00014:6 (was reservation_type)
  space_id  uuid not null references public.spaces(id),             -- 00014:7

  -- Time (within booking's window; usually equals it but can differ — e.g., room held longer than meeting)
  start_at timestamptz not null,                                    -- 00014:10
  end_at   timestamptz not null,                                    -- 00014:11

  -- Buffers (per-slot — different rooms have different setup needs)
  setup_buffer_minutes    int not null default 0,                   -- 00122:21
  teardown_buffer_minutes int not null default 0,                   -- 00122:22
  effective_start_at      timestamptz,                              -- maintained by trigger, see below
  effective_end_at        timestamptz,
  time_range              tstzrange,                                -- conflict guard target (00123)

  -- Per-slot capacity (separate from booking-level if needed; usually mirrored)
  attendee_count      integer,                                      -- 00014:12
  attendee_person_ids uuid[] not null default '{}',                 -- 00122:41

  -- Per-slot status (multi-room can have one slot cancelled while others continue)
  status text not null default 'confirmed' check (status in (
    'draft','pending_approval','confirmed','checked_in','released','cancelled','completed'
  )),                                                               -- mirrors booking.status enum

  -- Check-in (per-slot — operator checks each room in independently)
  check_in_required        boolean not null default false,          -- 00122:27
  check_in_grace_minutes   int not null default 15,                 -- 00122:28
  checked_in_at            timestamptz,                             -- 00122:29
  released_at              timestamptz,                             -- 00122:30
  cancellation_grace_until timestamptz,                             -- 00122:32

  -- Display order in multi-room groups (stable rendering; primary = lowest)
  display_order int not null default 0,                             -- NEW (was implicit via primary_reservation_id)

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  check (end_at > start_at)
);

alter table public.booking_slots enable row level security;
create policy "tenant_isolation" on public.booking_slots
  using (tenant_id = public.current_tenant_id());

-- Tenant + booking lookups
create index idx_slots_booking on public.booking_slots (booking_id);
create index idx_slots_tenant  on public.booking_slots (tenant_id);
-- Conflict-detection / scheduler reads
create index idx_slots_space_time on public.booking_slots (space_id, start_at, end_at)
  where status not in ('cancelled','released');
-- Status scans (auto-release worker, daglijst)
create index idx_slots_status on public.booking_slots (tenant_id, status);

create trigger set_slots_updated_at before update on public.booking_slots
  for each row execute function public.set_updated_at();

-- Maintain effective window from start_at + buffers (was 00122:58-75 trigger).
-- Same logic; renamed function to match new table name.
create or replace function public.booking_slots_compute_effective_window()
returns trigger language plpgsql as $$
begin
  new.effective_start_at := new.start_at - (interval '1 minute' * coalesce(new.setup_buffer_minutes, 0));
  new.effective_end_at   := new.end_at   + (interval '1 minute' * coalesce(new.teardown_buffer_minutes, 0));
  new.time_range         := tstzrange(new.effective_start_at, new.effective_end_at, '[)');
  return new;
end;
$$;

create trigger set_slots_effective_window
  before insert or update on public.booking_slots
  for each row execute function public.booking_slots_compute_effective_window();

-- ----------------------------------------------------------------------------
-- Atomic creation primitive — single function, single source of truth.
-- ----------------------------------------------------------------------------
-- Replaces today's "BookingFlowService.create -> insert reservation -> maybe
-- lazyCreateBundle" choreography. One booking + N slots inserted atomically.
--
-- Caller passes:
--   - Booking attributes (title, host, time window, source, etc.)
--   - Array of slot specs (slot_type, space_id, start/end_at, attendees, buffers)
-- Function returns: { booking_id, slot_ids[] }
--
-- For multi-room: pass N slot specs in one call.
-- For recurrence: caller invokes per occurrence (each occurrence is its own booking).
-- ----------------------------------------------------------------------------
create or replace function public.create_booking(
  p_tenant_id              uuid,
  p_requester_person_id    uuid,
  p_host_person_id         uuid,
  p_title                  text,
  p_description            text,
  p_start_at               timestamptz,
  p_end_at                 timestamptz,
  p_timezone               text,
  p_source                 text,
  p_status                 text,                       -- 'confirmed' | 'pending_approval'
  p_booked_by_user_id      uuid,
  p_cost_center_id         uuid,
  p_policy_snapshot        jsonb,
  p_applied_rule_ids       uuid[],
  p_recurrence_series_id   uuid,
  p_recurrence_index       int,
  p_template_id            uuid,
  p_slots                  jsonb                       -- array of {slot_type, space_id, start_at, end_at, attendee_count, attendee_person_ids[], setup_buffer_minutes, teardown_buffer_minutes, check_in_required, check_in_grace_minutes, display_order}
) returns table (booking_id uuid, slot_ids uuid[])
language plpgsql
security invoker
as $$
declare
  v_booking_id uuid;
  v_slot_ids uuid[] := '{}';
  v_slot jsonb;
  v_slot_id uuid;
begin
  -- 1. Insert the booking
  insert into public.bookings (
    tenant_id, title, description,
    requester_person_id, host_person_id, booked_by_user_id,
    start_at, end_at, timezone,
    status, source,
    cost_center_id, policy_snapshot, applied_rule_ids,
    recurrence_series_id, recurrence_index, template_id
  ) values (
    p_tenant_id, p_title, p_description,
    p_requester_person_id, p_host_person_id, p_booked_by_user_id,
    p_start_at, p_end_at, coalesce(p_timezone, 'UTC'),
    p_status, p_source,
    p_cost_center_id, coalesce(p_policy_snapshot, '{}'::jsonb), coalesce(p_applied_rule_ids, '{}'),
    p_recurrence_series_id, p_recurrence_index, p_template_id
  ) returning id into v_booking_id;

  -- 2. Insert each slot, keyed to the new booking
  for v_slot in select * from jsonb_array_elements(p_slots)
  loop
    insert into public.booking_slots (
      tenant_id, booking_id,
      slot_type, space_id,
      start_at, end_at,
      attendee_count, attendee_person_ids,
      setup_buffer_minutes, teardown_buffer_minutes,
      status,
      check_in_required, check_in_grace_minutes,
      display_order
    ) values (
      p_tenant_id, v_booking_id,
      (v_slot->>'slot_type')::text,
      (v_slot->>'space_id')::uuid,
      (v_slot->>'start_at')::timestamptz,
      (v_slot->>'end_at')::timestamptz,
      (v_slot->>'attendee_count')::integer,
      coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(v_slot->'attendee_person_ids')), '{}'),
      coalesce((v_slot->>'setup_buffer_minutes')::integer, 0),
      coalesce((v_slot->>'teardown_buffer_minutes')::integer, 0),
      p_status,                                                    -- slot status mirrors booking on create
      coalesce((v_slot->>'check_in_required')::boolean, false),
      coalesce((v_slot->>'check_in_grace_minutes')::integer, 15),
      coalesce((v_slot->>'display_order')::integer, 0)
    ) returning id into v_slot_id;

    v_slot_ids := array_append(v_slot_ids, v_slot_id);
  end loop;

  return query select v_booking_id, v_slot_ids;
end;
$$;

-- ----------------------------------------------------------------------------
-- Sibling table updates (FKs that pointed at old tables now point at bookings)
-- ----------------------------------------------------------------------------
-- These tables exist today; their relationships shift in the rewrite:
--
-- visitors:
--   DROP visitors.reservation_id  (single-direction is bad — was a denormalized cache)
--   DROP visitors.booking_bundle_id (rename to visitors.booking_id, single FK)
--   ADD  visitors.booking_id uuid references public.bookings(id) on delete cascade
--   Source: 00252_visitors_v1_extensions.sql:36-37 dual-link pattern
--
-- tickets / work_orders:
--   tickets.booking_bundle_id    -> tickets.booking_id    (rename, FK retarget)
--   work_orders.booking_bundle_id -> work_orders.booking_id (rename, FK retarget)
--   Sources: 00145_tickets_bundle_columns.sql + 00213_step1c1_work_orders_new_table.sql
--
-- orders:
--   orders.booking_bundle_id -> orders.booking_id (rename, FK retarget)
--   orders.linked_reservation_id -> orders.linked_slot_id (rename, FK retarget to booking_slots)
--   Source: 00144_orders_bundle_columns.sql + 00014:35-38
--
-- approvals:
--   approvals.target_entity_type values constrain to ('booking','order','ticket','visitor_invite')
--   No more 'reservation' — bookings own approval state
--   Source: approval.service.ts:329-347 dispatcher
--
-- audit_events:
--   New events use entity_type='booking' for booking-lifecycle events.
--   Per-slot events (check-in, auto-release) use entity_type='booking_slot'.
--   Historical 'reservation'/'booking_bundle' rows stay (immutable; 7-yr retention).
--   Source: reservation.service.ts:359/389/454/540 + check-in.service.ts:80-95/174-185
--
-- asset_reservations:
--   asset_reservations.booking_bundle_id -> asset_reservations.booking_id
--   Source: 00142_asset_reservations.sql
--
-- multi_room_groups: DROPPED entirely (replaced by booking_id grouping)
--   Source: 00125_multi_room_groups.sql
-- ----------------------------------------------------------------------------

-- (FK reshape statements not included in this contract file; they belong in
-- the per-table migration slices that come after the bookings/booking_slots
-- create-table slice. The sequence is in the companion design doc.)

notify pgrst, 'reload schema';
