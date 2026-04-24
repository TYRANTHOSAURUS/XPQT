-- 00114_portal_appearance.sql
-- Per-location visual settings for the employee portal. A hero image + greeting
-- copy + time-of-day greeting toggle, resolved by walking up the spaces tree
-- (see apps/api/src/modules/portal-appearance/portal-appearance.service.ts).

create table public.portal_appearance (
  tenant_id         uuid        not null references public.tenants(id) on delete cascade,
  location_id       uuid        not null references public.spaces(id)  on delete cascade,
  hero_image_url    text,
  welcome_headline  text,
  supporting_line   text,
  greeting_enabled  boolean     not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (tenant_id, location_id)
);

create index portal_appearance_tenant_idx
  on public.portal_appearance (tenant_id);

-- updated_at trigger
create trigger portal_appearance_set_updated_at
  before update on public.portal_appearance
  for each row execute function public.set_updated_at();

-- RLS: tenant-scoped read for any authenticated caller of that tenant.
-- Writes go through the NestJS API under the service role, so no write policy
-- is required for anon/auth.
alter table public.portal_appearance enable row level security;

create policy "portal_appearance tenant read"
  on public.portal_appearance for select
  using (
    tenant_id = public.current_tenant_id()
  );

comment on table public.portal_appearance is
  'Per-location portal appearance: hero image, greeting copy, time-of-day toggle. Resolver walks up spaces.parent_id.';
