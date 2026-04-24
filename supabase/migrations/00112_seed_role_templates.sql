-- 00112_seed_role_templates.sql
--
-- Roles/permissions redesign, slice 10/10.
--
-- Seed the six canonical role templates per tenant. Idempotent — re-running
-- this migration is safe; existing roles with the same (tenant_id, name) are
-- skipped via NOT EXISTS so admins may customise or rename them freely.
--
-- Templates:
--   Tenant Admin       — full access (`*.*`).
--   IT Agent           — tickets.* + read access to request types, assets, people.
--   FM Agent           — tickets.* + assets.*, spaces.read, people.read.
--   Service Desk Lead  — agent permissions + team + report management.
--   Requester          — create and read own tickets, browse service catalog.
--   Auditor            — read-only across every module (`*.read`).
--
-- Existing `Admin` / `Agent` / `Employee` roles seeded by 00102 are left
-- untouched — the new templates are additive.

begin;

do $$
declare
  t record;
  tpl record;
begin
  for t in select id as tenant_id from public.tenants loop
    for tpl in
      select *
      from (values
        (
          'Tenant Admin',
          'Full tenant administration — use sparingly.',
          '["*.*"]'::jsonb,
          'admin'::text
        ),
        (
          'IT Agent',
          'Handles IT tickets end-to-end. Grant domain_scope=["it"] on assignment.',
          '["tickets.*","request_types.read","assets.read","people.read","vendors.read"]'::jsonb,
          'agent'
        ),
        (
          'FM Agent',
          'Handles facilities tickets. Grant domain_scope=["fm"] on assignment.',
          '["tickets.*","assets.*","spaces.read","people.read","vendors.read"]'::jsonb,
          'agent'
        ),
        (
          'Service Desk Lead',
          'Agent permissions plus team admin and reporting.',
          '["tickets.*","request_types.read","assets.read","people.read","people.update","teams.*","reports.read","reports.export","routing.read"]'::jsonb,
          'agent'
        ),
        (
          'Requester',
          'Portal-only access. Creates and views their own tickets.',
          '["tickets.create","tickets.read","service_catalog.read","people.read"]'::jsonb,
          'employee'
        ),
        (
          'Auditor',
          'Read-only access across every module — for compliance and reviews.',
          '["*.read"]'::jsonb,
          'agent'
        )
      ) as v(name, description, permissions, type)
    loop
      if not exists (
        select 1 from public.roles r
        where r.tenant_id = t.tenant_id and lower(r.name) = lower(tpl.name)
      ) then
        insert into public.roles (tenant_id, name, description, permissions, type, active)
        values (t.tenant_id, tpl.name, tpl.description, tpl.permissions, tpl.type, true);
      end if;
    end loop;
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';
