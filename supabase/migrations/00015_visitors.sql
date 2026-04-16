-- Visitor management

create table public.visitors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  person_id uuid not null references public.persons(id), -- visitor's person record
  host_person_id uuid not null references public.persons(id),
  visit_date date not null,
  site_id uuid references public.spaces(id), -- the site they're visiting
  status text not null default 'pre_registered' check (status in ('pre_registered', 'approved', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  badge_id text,
  pre_registered boolean not null default true,
  approval_id uuid references public.approvals(id),
  checked_in_at timestamptz,
  checked_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.visitors enable row level security;
create policy "tenant_isolation" on public.visitors
  using (tenant_id = public.current_tenant_id());

create index idx_visitors_tenant on public.visitors (tenant_id);
create index idx_visitors_date_site on public.visitors (tenant_id, visit_date, site_id);
create index idx_visitors_host on public.visitors (host_person_id);
create index idx_visitors_status on public.visitors (tenant_id, status) where status in ('pre_registered', 'approved', 'checked_in');

create trigger set_visitors_updated_at before update on public.visitors
  for each row execute function public.set_updated_at();
