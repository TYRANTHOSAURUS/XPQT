-- 00252_visitors_v1_extensions.sql
-- Visitor Management v1 — extend the existing visitors table.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.1, §14.2
--
-- Order is load-bearing:
--   1. Add new columns.
--   2. Backfill primary_host_person_id from legacy host_person_id (existing
--      rows already have host_person_id NOT NULL; new code writes both).
--   3. Backfill status into the v1 enum BEFORE the new CHECK is applied,
--      so 00015 rows with pre_registered/approved/checked_in survive the swap.
--   4. Drop the old check, add the wider one (incl. pending_approval/expected/
--      arrived/in_meeting/denied).
--   5. Add invariant CHECKs (logged_after_arrived, checkout_source_required).
--   6. Belt-and-braces: re-run the host_person_id backfill from primary_host_person_id
--      (no-op for existing rows; documents the invariant for future writes per §14.2).
--   7. Add FK indexes.
--   8. Add spaces.timezone (per-building local TZ for the EOD sweep, §4.8).
--
-- The visitors_pkey_tenant UNIQUE constraint already shipped in 00249 (it
-- was needed earlier for visitor_pass_pool composite FKs). It is not
-- re-added here.

-- ---------------------------------------------------------------------------
-- 1. Add new columns. visitor_pass_id and visitor_type_id reference tables
--    that landed in 00248 / 00249 — those migrations must run first.
-- ---------------------------------------------------------------------------
alter table public.visitors
  add column if not exists expected_at      timestamptz,
  add column if not exists expected_until   timestamptz,
  add column if not exists building_id      uuid references public.spaces(id),
  add column if not exists auto_checked_out boolean not null default false,
  add column if not exists visitor_pass_id  uuid references public.visitor_pass_pool(id),
  add column if not exists primary_host_person_id uuid references public.persons(id),
  add column if not exists visitor_type_id  uuid references public.visitor_types(id),
  add column if not exists booking_bundle_id uuid references public.booking_bundles(id),
  add column if not exists reservation_id   uuid references public.reservations(id),
  add column if not exists checkout_source  text,
  add column if not exists logged_at        timestamptz,
  -- The legacy 00015 schema named the arrival timestamp `checked_in_at`; the
  -- v1 status machine uses `arrived` and reads/writes `arrived_at`. Both
  -- columns are kept in sync — already-shipped migrations populate
  -- checked_in_at; v1 code writes both.
  add column if not exists arrived_at       timestamptz;

-- Backfill arrived_at from legacy checked_in_at (BEFORE check constraints
-- below reference the column).
update public.visitors
   set arrived_at = checked_in_at
 where arrived_at is null
   and checked_in_at is not null;

-- ---------------------------------------------------------------------------
-- 2. Backfill primary_host_person_id from existing host_person_id so the
--    GDPR adapter (visitor-records.adapter.ts:43) and downstream consumers
--    can read either column for legacy rows. Going forward, app code writes
--    both (per spec §14.2 path (a)).
-- ---------------------------------------------------------------------------
update public.visitors
   set primary_host_person_id = host_person_id
 where primary_host_person_id is null
   and host_person_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Status backfill (BEFORE swapping the CHECK constraint — critical).
-- ---------------------------------------------------------------------------
update public.visitors
   set status = case
     when status = 'pre_registered' then 'expected'
     when status = 'approved'       then 'expected'
     when status = 'checked_in'     then 'arrived'
     else status
   end;

-- ---------------------------------------------------------------------------
-- 4. Swap the CHECK constraint to the v1 enum.
-- ---------------------------------------------------------------------------
alter table public.visitors
  drop constraint if exists visitors_status_check;

alter table public.visitors
  add constraint visitors_status_check
    check (status in ('pending_approval','expected','arrived','in_meeting','checked_out','no_show','cancelled','denied'));

-- ---------------------------------------------------------------------------
-- 5. Invariant CHECK constraints. Idempotent via DO block (re-applying the
--    migration on a partially-applied DB is a developer-experience need;
--    `add constraint` lacks IF NOT EXISTS in current Postgres).
-- ---------------------------------------------------------------------------
do $$
begin
  -- Backdated arrival audit: logged_at >= arrived_at.
  if not exists (
    select 1 from pg_constraint
    where conname = 'visitors_logged_after_arrived'
      and conrelid = 'public.visitors'::regclass
  ) then
    alter table public.visitors
      add constraint visitors_logged_after_arrived
        check (logged_at is null or arrived_at is null or logged_at >= arrived_at);
  end if;

  -- checkout_source enum.
  if not exists (
    select 1 from pg_constraint
    where conname = 'visitors_checkout_source_enum'
      and conrelid = 'public.visitors'::regclass
  ) then
    alter table public.visitors
      add constraint visitors_checkout_source_enum
        check (checkout_source is null or checkout_source in ('reception','host','eod_sweep'));
  end if;

  -- checkout_source required when status='checked_out'.
  if not exists (
    select 1 from pg_constraint
    where conname = 'visitors_checkout_source_required'
      and conrelid = 'public.visitors'::regclass
  ) then
    alter table public.visitors
      add constraint visitors_checkout_source_required
        check (status != 'checked_out' or checkout_source is not null);
  end if;
end$$;

-- ---------------------------------------------------------------------------
-- 6. Belt-and-braces: keep host_person_id populated for legacy adapter reads
--    (per spec §14.2). For existing rows host_person_id is already NOT NULL,
--    so this is a documented no-op; the invariant is on future writes.
-- ---------------------------------------------------------------------------
update public.visitors
   set host_person_id = primary_host_person_id
 where host_person_id is null
   and primary_host_person_id is not null;

-- ---------------------------------------------------------------------------
-- 7. FK indexes (reviewer C12).
-- ---------------------------------------------------------------------------
create index if not exists idx_visitors_building
  on public.visitors (tenant_id, building_id)
  where building_id is not null;
create index if not exists idx_visitors_booking_bundle
  on public.visitors (tenant_id, booking_bundle_id)
  where booking_bundle_id is not null;
create index if not exists idx_visitors_reservation
  on public.visitors (tenant_id, reservation_id)
  where reservation_id is not null;
create index if not exists idx_visitors_pass
  on public.visitors (tenant_id, visitor_pass_id)
  where visitor_pass_id is not null;
create index if not exists idx_visitors_primary_host
  on public.visitors (tenant_id, primary_host_person_id)
  where primary_host_person_id is not null;
create index if not exists idx_visitors_visitor_type
  on public.visitors (tenant_id, visitor_type_id)
  where visitor_type_id is not null;
create index if not exists idx_visitors_expected_at
  on public.visitors (tenant_id, expected_at)
  where status in ('expected','arrived','in_meeting');

-- ---------------------------------------------------------------------------
-- 8. spaces.timezone — per-building local TZ for the EOD sweep (§4.8, §12).
-- ---------------------------------------------------------------------------
alter table public.spaces
  add column if not exists timezone text default 'Europe/Amsterdam';

comment on column public.spaces.timezone is
  'Per-building local timezone for visitor EOD sweep + occupancy reports. Defaults to Europe/Amsterdam (Benelux primary market). Only meaningful for type=building rows.';

-- ---------------------------------------------------------------------------
-- Replace the legacy idx_visitors_status partial index (only references
-- pre_registered/approved/checked_in, all renamed by the backfill above).
-- ---------------------------------------------------------------------------
drop index if exists public.idx_visitors_status;
create index idx_visitors_status
  on public.visitors (tenant_id, status)
  where status in ('pending_approval','expected','arrived','in_meeting');

comment on column public.visitors.primary_host_person_id is
  'Canonical primary host (single source of truth). visitor_hosts junction holds primary + co-hosts for fan-out. host_person_id is the legacy alias kept in sync for the GDPR adapter (see spec §14.2).';
comment on column public.visitors.checkout_source is
  'Who/what triggered the checkout. Required when status=''checked_out''. One of reception | host | eod_sweep.';
comment on column public.visitors.logged_at is
  'When reception entered the visitor record (vs arrived_at = actual arrival). Backdated entries: logged_at >= arrived_at.';
comment on column public.visitors.auto_checked_out is
  'TRUE when the EOD sweep automatically transitioned this visitor to checked_out (visitor never explicitly checked out).';

notify pgrst, 'reload schema';
