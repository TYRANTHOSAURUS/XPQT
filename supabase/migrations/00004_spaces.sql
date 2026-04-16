-- Location hierarchy: Sites → Buildings → Floors → Rooms/Desks/Spaces

create table public.spaces (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  parent_id uuid references public.spaces(id),
  type text not null check (type in ('site', 'building', 'floor', 'room', 'desk', 'meeting_room', 'common_area', 'storage_room', 'technical_room', 'parking_space')),
  code text,
  name text not null,
  capacity integer,
  amenities text[] default '{}', -- simple amenities (whiteboard, wheelchair_accessible, etc.)
  attributes jsonb default '{}'::jsonb, -- additional metadata
  reservable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.spaces enable row level security;
create policy "tenant_isolation" on public.spaces
  using (tenant_id = public.current_tenant_id());

create index idx_spaces_tenant on public.spaces (tenant_id);
create index idx_spaces_parent on public.spaces (parent_id);
create index idx_spaces_tenant_type on public.spaces (tenant_id, type);
create index idx_spaces_tenant_reservable on public.spaces (tenant_id, reservable) where reservable = true;

create trigger set_spaces_updated_at before update on public.spaces
  for each row execute function public.set_updated_at();
