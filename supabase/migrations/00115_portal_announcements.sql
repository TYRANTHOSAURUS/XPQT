-- 00115_portal_announcements.sql
-- Per-location announcements surfaced on the portal home. One active
-- announcement per location at a time.

create table public.portal_announcements (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references public.tenants(id) on delete cascade,
  location_id  uuid        not null references public.spaces(id)  on delete cascade,
  title        text        not null check (length(title) between 1 and 120),
  body         text        not null check (length(body)  between 1 and 1000),
  published_at timestamptz not null default now(),
  expires_at   timestamptz,
  created_by   uuid        references public.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- "One active per location": an announcement is active iff expires_at is
-- null OR expires_at > now().
-- Enforce via a partial unique index on (expires_at IS NULL), which ensures
-- at most one announcement per location with no expiry. For temporarily expired
-- announcements (expires_at in the past), the application queries only
-- records where expires_at IS NULL OR expires_at > now(), maintaining the
-- one-active-per-location semantic at the query layer.
create unique index portal_announcements_one_active_per_location
  on public.portal_announcements (tenant_id, location_id)
  where (expires_at is null);

create index portal_announcements_tenant_location_published_idx
  on public.portal_announcements (tenant_id, location_id, published_at desc);

alter table public.portal_announcements enable row level security;

create policy "portal_announcements tenant read"
  on public.portal_announcements for select
  using (
    tenant_id = public.current_tenant_id()
  );

comment on table public.portal_announcements is
  'Per-location announcements for the portal home. One active per location at a time.';
