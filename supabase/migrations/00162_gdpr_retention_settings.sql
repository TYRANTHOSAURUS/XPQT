-- GDPR baseline · Wave 0 Sprint 1
-- Per-tenant per-category retention configuration with LIA documentation.
--
-- Spec: docs/superpowers/specs/2026-04-27-gdpr-baseline-design.md §3.

create table if not exists public.tenant_retention_settings (
  id                            uuid        primary key default gen_random_uuid(),
  tenant_id                     uuid        not null references public.tenants(id) on delete cascade,
  data_category                 text        not null,                  -- matches DataCategoryAdapter.category
  retention_days                int         not null,
  cap_retention_days            int,                                    -- null = no cap
  lia_text                      text,                                   -- Legitimate Interest Assessment justification
  lia_text_updated_at           timestamptz,
  lia_text_updated_by_user_id   uuid        references public.users(id),
  legal_basis                   text        not null,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),

  constraint trs_unique_per_tenant_category unique (tenant_id, data_category),
  constraint trs_retention_nonneg            check (retention_days >= 0),
  constraint trs_cap_respects_retention      check (cap_retention_days is null or retention_days <= cap_retention_days),
  constraint trs_legal_basis_enum            check (legal_basis in (
    'legitimate_interest','consent','legal_obligation','contract','none'
  ))
);

create index if not exists idx_trs_tenant on public.tenant_retention_settings (tenant_id);

alter table public.tenant_retention_settings enable row level security;

drop policy if exists tenant_isolation on public.tenant_retention_settings;
create policy tenant_isolation on public.tenant_retention_settings
  using (tenant_id = public.current_tenant_id());

drop trigger if exists set_trs_updated_at on public.tenant_retention_settings;
create trigger set_trs_updated_at before update on public.tenant_retention_settings
  for each row execute function public.set_updated_at();

-- Seed the canonical category set for a tenant. Idempotent (on-conflict do-nothing).
-- Defaults are the v1 table from gdpr-baseline-design.md §3 "Default retention windows".
-- Adding a new category later: extend this function AND register a DataCategoryAdapter.
create or replace function public.seed_default_retention_for_tenant(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.tenant_retention_settings
    (tenant_id, data_category,                retention_days, cap_retention_days, legal_basis)
  values
    (p_tenant_id, 'visitor_records',                   180,                365, 'legitimate_interest'),
    (p_tenant_id, 'visitor_photos_ids',                 90,                180, 'legitimate_interest'),
    (p_tenant_id, 'cctv_footage',                       28,                 28, 'legitimate_interest'),
    (p_tenant_id, 'person_preferences',                 30,                 30, 'contract'),
    (p_tenant_id, 'person_ref_in_past_records',         90,                 90, 'contract'),
    (p_tenant_id, 'past_bookings',                    2555,               null, 'legal_obligation'),
    (p_tenant_id, 'past_orders',                      2555,               null, 'legal_obligation'),
    (p_tenant_id, 'audit_events',                     2555,               null, 'legal_obligation'),
    (p_tenant_id, 'personal_data_access_logs',         365,                730, 'legitimate_interest'),
    (p_tenant_id, 'calendar_event_content',              0,                  0, 'none'),
    (p_tenant_id, 'calendar_attendees_snapshot',        90,                365, 'legitimate_interest'),
    (p_tenant_id, 'daglijst_pdfs',                      90,                365, 'legitimate_interest'),
    (p_tenant_id, 'email_notifications',                30,                365, 'legitimate_interest'),
    (p_tenant_id, 'webhook_notifications',              30,                365, 'legitimate_interest'),
    (p_tenant_id, 'ghost_persons',                     365,                730, 'legitimate_interest'),
    (p_tenant_id, 'vendor_user_data',                  730,               1825, 'contract')
  on conflict (tenant_id, data_category) do nothing;
end;
$$;

comment on function public.seed_default_retention_for_tenant(uuid) is
  'Idempotent. Seeds the canonical 16 retention categories with defaults from gdpr-baseline-design.md §3. Call from tenant-create flow + use to backfill new categories on existing tenants.';

-- Backfill existing tenants. Idempotent — re-running this migration is safe.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_retention_for_tenant(t.id);
  end loop;
end
$$;

notify pgrst, 'reload schema';
