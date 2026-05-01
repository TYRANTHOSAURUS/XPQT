-- 00257_seed_default_visitor_types.sql
-- Visitor Management v1 — six default visitor types per tenant.
--
-- Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §4.2, §11.4
--
-- Defaults seeded for:
--   - Every existing tenant on this migration (idempotent ON CONFLICT DO NOTHING).
--   - Every new tenant via after-insert trigger (mirroring the GDPR pattern in 00165).
--
-- Per-type config matrix (default values; tenants edit via /admin/visitors/types):
--   guest       — requires_approval=false  allow_walk_up=true
--   contractor  — requires_approval=false  allow_walk_up=true
--   interview   — requires_approval=false  allow_walk_up=false  (HR doesn't accept walk-ups)
--   delivery    — requires_approval=false  allow_walk_up=true
--   vendor      — requires_approval=false  allow_walk_up=true
--   other       — requires_approval=false  allow_walk_up=true
--
-- Reviewer Q3 lock D — walk-up + approval is mutually exclusive at the type
-- level: any tenant that turns on requires_approval is expected to turn off
-- allow_walk_up. The application layer enforces this combo at type edit time.

create or replace function public.seed_default_visitor_types_for_tenant(p_tenant_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.visitor_types (tenant_id, type_key, display_name, description, requires_approval, allow_walk_up, default_expected_until_offset_minutes)
  values
    (p_tenant_id, 'guest',      'Guest',      'External guest visiting the office.',                        false, true,  240),
    (p_tenant_id, 'contractor', 'Contractor', 'Vendor or service provider on site for work.',               false, true,  480),
    (p_tenant_id, 'interview',  'Interview',  'Candidate visiting for an interview.',                       false, false, 180),
    (p_tenant_id, 'delivery',   'Delivery',   'Courier or delivery driver dropping off / picking up.',      false, true,  60),
    (p_tenant_id, 'vendor',     'Vendor',     'Established vendor representative.',                          false, true,  240),
    (p_tenant_id, 'other',      'Other',      'Visitor type that does not match the catch-all categories.', false, true,  240)
  on conflict (tenant_id, type_key) do nothing;
$$;

-- Seed for all currently-existing tenants.
do $$
declare
  t record;
begin
  for t in select id from public.tenants loop
    perform public.seed_default_visitor_types_for_tenant(t.id);
  end loop;
end$$;

-- Trigger: auto-seed for every new tenant (mirrors 00165_gdpr_tenant_seed_trigger.sql).
create or replace function public.tenants_seed_visitor_types_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_visitor_types_for_tenant(new.id);
  return new;
end;
$$;

drop trigger if exists trg_tenants_seed_visitor_types on public.tenants;
create trigger trg_tenants_seed_visitor_types
  after insert on public.tenants
  for each row execute function public.tenants_seed_visitor_types_after_insert();

comment on function public.seed_default_visitor_types_for_tenant(uuid) is
  'Seed the six default visitor types for a tenant (idempotent via ON CONFLICT). Called automatically by trg_tenants_seed_visitor_types and once during 00257 backfill.';

notify pgrst, 'reload schema';
