-- 00039_domain_registry.sql
-- Workstream 0 / Artifact D steps 1 + 2:
-- 1. Create the canonical domains registry.
-- 2. Add nullable domain_id FK columns on existing free-text callers.
--
-- Additive only — free-text columns (request_types.domain, location_teams.domain,
-- domain_parents.domain/parent_domain) are kept populated during dual-run.
-- Backfill and cutover live in later migrations (Artifact D steps 3–9).

-- ── 1. Registry table ─────────────────────────────────────────
create table if not exists public.domains (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  key text not null,                            -- canonical lowercased machine key
  display_name text not null,
  parent_domain_id uuid references public.domains(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key),
  check (parent_domain_id is null or parent_domain_id <> id)
);

alter table public.domains enable row level security;

create policy "tenant_isolation" on public.domains
  using (tenant_id = public.current_tenant_id());

create index if not exists idx_domains_tenant_parent
  on public.domains (tenant_id, parent_domain_id);

create index if not exists idx_domains_tenant_active
  on public.domains (tenant_id) where active;

create trigger set_domains_updated_at before update on public.domains
  for each row execute function public.set_updated_at();

comment on table public.domains is
  'Routing Studio v2: canonical domain registry. Replaces free-text domain columns during Workstream 0 migration.';

-- ── 2. Nullable FK columns alongside free-text ────────────────
alter table public.request_types
  add column if not exists domain_id uuid references public.domains(id);

alter table public.location_teams
  add column if not exists domain_id uuid references public.domains(id);

alter table public.domain_parents
  add column if not exists domain_id uuid references public.domains(id),
  add column if not exists parent_domain_id uuid references public.domains(id);

create index if not exists idx_request_types_domain_id
  on public.request_types (domain_id) where domain_id is not null;

create index if not exists idx_location_teams_domain_id
  on public.location_teams (domain_id) where domain_id is not null;

create index if not exists idx_domain_parents_domain_id
  on public.domain_parents (domain_id) where domain_id is not null;
