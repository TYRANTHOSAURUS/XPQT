-- Add type classification to roles so route guards don't depend on role names.
-- Types:
--   admin    → full configuration access (/admin)
--   agent    → service-desk/fulfillment access (/desk)
--   employee → portal-only (default)

alter table public.roles
  add column type text not null default 'employee'
    check (type in ('admin', 'agent', 'employee'));

-- Backfill existing roles from their names using common conventions.
update public.roles
  set type = case
    when lower(name) ~ '(admin|administrator)' then 'admin'
    when lower(name) ~ '(agent|service ?desk|helpdesk|dispatcher|fulfiller)' then 'agent'
    else 'employee'
  end;

create index idx_roles_tenant_type on public.roles (tenant_id, type);
