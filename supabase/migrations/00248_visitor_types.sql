-- 00248_visitor_types.sql
-- Visitor Management v1 — tenant-configurable visitor type lookup.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.2
--
-- Six default types are seeded per existing tenant (and via trigger for new
-- tenants) in migration 00257. This migration ships only the schema + RLS
-- so that subsequent migrations (pass pool, visitors table extensions) can
-- reference visitor_types(id).

create table public.visitor_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  type_key text not null,                                          -- guest | contractor | interview | delivery | vendor | other | <custom>
  display_name text not null,
  description text,
  -- per-type config matrix
  requires_approval boolean not null default false,
  allow_walk_up boolean not null default true,
  -- v2 fields, present-but-unused
  requires_id_scan boolean not null default false,
  requires_nda boolean not null default false,
  requires_photo boolean not null default false,
  default_expected_until_offset_minutes int default 240,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type_key)
);

alter table public.visitor_types enable row level security;

-- Per-verb policies (mirroring 00160 hardening pattern).
drop policy if exists tenant_isolation on public.visitor_types;
create policy "visitor_types_select" on public.visitor_types
  for select using (tenant_id = public.current_tenant_id());
create policy "visitor_types_insert" on public.visitor_types
  for insert with check (tenant_id = public.current_tenant_id());
create policy "visitor_types_update" on public.visitor_types
  for update
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());
create policy "visitor_types_delete" on public.visitor_types
  for delete using (tenant_id = public.current_tenant_id());

revoke all on public.visitor_types from public, anon, authenticated;
grant select, insert, update, delete on public.visitor_types to service_role;

create index idx_visitor_types_tenant_active on public.visitor_types (tenant_id) where active = true;

create trigger set_visitor_types_updated_at before update on public.visitor_types
  for each row execute function public.set_updated_at();

comment on table public.visitor_types is
  'Tenant-configurable visitor type lookup. Six defaults seeded via 00257 + tenant-creation trigger. '
  'Drives walk-up policy, approval routing, and per-type defaults. See visitor-management-v1-design.md §4.2.';

notify pgrst, 'reload schema';
