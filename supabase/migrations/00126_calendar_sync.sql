-- 00126_calendar_sync.sql
-- Microsoft Graph (Outlook) calendar sync state + reconciliation.
-- Google support is deliberately excluded from v1; CHECK constraints lock provider to 'outlook'.

-- Per-user OAuth links (the user's own calendar, not the room mailbox)
create table if not exists public.calendar_sync_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.users(id),
  provider text not null check (provider in ('outlook')),
  access_token_encrypted text not null,             -- pgcrypto / vault wrap
  refresh_token_encrypted text not null,
  expires_at timestamptz,
  external_calendar_id text not null,
  sync_status text not null default 'active' check (sync_status in ('active','error','disabled')),
  last_synced_at timestamptz,
  last_error text,
  webhook_subscription_id text,
  webhook_expires_at timestamptz,
  unique (user_id, provider)
);

alter table public.calendar_sync_links enable row level security;
-- Tenant isolation
drop policy if exists "tenant_isolation" on public.calendar_sync_links;
create policy "tenant_isolation" on public.calendar_sync_links
  using (tenant_id = public.current_tenant_id());
-- Owner-or-admin read (service role bypasses RLS via app).
-- Non-admin users only see their own links.
drop policy if exists "owner_select" on public.calendar_sync_links;
create policy "owner_select" on public.calendar_sync_links
  for select using (user_id = public.current_user_id());

create index if not exists idx_calendar_sync_links_active
  on public.calendar_sync_links (provider, sync_status, last_synced_at)
  where sync_status = 'active';

-- Mapping table: reservation ↔ external event
create table if not exists public.calendar_sync_events (
  reservation_id uuid not null references public.reservations(id) on delete cascade,
  provider text not null check (provider in ('outlook')),
  external_event_id text not null,
  external_etag text,
  sync_direction text not null check (sync_direction in ('in','out','both')),
  last_synced_at timestamptz not null default now(),
  primary key (reservation_id, provider)
);

alter table public.calendar_sync_events enable row level security;
drop policy if exists "tenant_isolation_via_reservation" on public.calendar_sync_events;
create policy "tenant_isolation_via_reservation" on public.calendar_sync_events
  using (exists (
    select 1 from public.reservations r
    where r.id = reservation_id and r.tenant_id = public.current_tenant_id()
  ));

create index if not exists idx_calendar_sync_events_external
  on public.calendar_sync_events (external_event_id, provider);

-- Conflicts inbox (admin sync-health surface)
create table if not exists public.room_calendar_conflicts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_id uuid not null references public.spaces(id),
  detected_at timestamptz not null default now(),
  conflict_type text not null check (conflict_type in
    ('etag_mismatch','recurrence_drift','orphan_external','orphan_internal','webhook_miss_recovered')),
  reservation_id uuid references public.reservations(id),
  external_event_id text,
  external_event_payload jsonb,
  resolution_status text not null default 'open'
    check (resolution_status in ('open','auto_resolved','admin_resolved','wont_fix')),
  resolution_action text,
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);

alter table public.room_calendar_conflicts enable row level security;
drop policy if exists "tenant_isolation" on public.room_calendar_conflicts;
create policy "tenant_isolation" on public.room_calendar_conflicts
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_room_calendar_conflicts_open
  on public.room_calendar_conflicts (tenant_id, resolution_status, detected_at)
  where resolution_status = 'open';

notify pgrst, 'reload schema';
