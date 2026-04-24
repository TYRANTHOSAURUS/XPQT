-- 00107_centralised_example_asset_normalization.sql
-- Normalize central example asset naming/tagging:
-- - personal assets do not include person names
-- - tags are unique and derived from asset ids, not person ids
-- - fixed asset names use room/building codes so they are unique and readable

do $$
declare
  t constant uuid := '00000000-0000-0000-0000-000000000001';
begin
  update public.assets a
  set
    name = case at.name
      when 'Laptop' then 'Corporate Laptop ' || upper(substr(replace(a.id::text, '-', ''), 1, 6))
      when 'Dock' then 'USB-C Dock ' || upper(substr(replace(a.id::text, '-', ''), 1, 6))
      when 'Monitor' then 'Desk Monitor ' || upper(substr(replace(a.id::text, '-', ''), 1, 6))
      else a.name
    end,
    tag = case at.name
      when 'Laptop' then 'LAP-' || upper(substr(replace(a.id::text, '-', ''), 1, 8))
      when 'Dock' then 'DCK-' || upper(substr(replace(a.id::text, '-', ''), 1, 8))
      when 'Monitor' then 'MON-' || upper(substr(replace(a.id::text, '-', ''), 1, 8))
      else a.tag
    end,
    updated_at = now()
  from public.asset_types at
  where a.tenant_id = t
    and at.id = a.asset_type_id
    and a.asset_role = 'personal'
    and at.name in ('Laptop', 'Dock', 'Monitor');

  update public.assets a
  set
    name = 'Meeting Room Display ' || s.code,
    updated_at = now()
  from public.asset_types at, public.spaces s
  where a.tenant_id = t
    and at.id = a.asset_type_id
    and at.name = 'Meeting Room Display'
    and s.id = a.assigned_space_id
    and s.tenant_id = t;

  update public.assets a
  set
    name = 'AV Kit ' || s.code,
    updated_at = now()
  from public.asset_types at, public.spaces s
  where a.tenant_id = t
    and at.id = a.asset_type_id
    and at.name = 'AV Kit'
    and s.id = a.assigned_space_id
    and s.tenant_id = t;

  update public.assets a
  set
    name = 'Printer ' || s.code,
    updated_at = now()
  from public.asset_types at, public.spaces s
  where a.tenant_id = t
    and at.id = a.asset_type_id
    and at.name = 'Printer'
    and s.id = a.assigned_space_id
    and s.tenant_id = t;

  update public.assets a
  set
    name = case at.name
      when 'HVAC Unit' then 'HVAC Unit ' || s.code || '-' || right(coalesce(a.tag, ''), 1)
      when 'Elevator' then 'Lift ' || s.code
      when 'Door Controller' then 'Door Controller ' || s.code
      else a.name
    end,
    updated_at = now()
  from public.asset_types at, public.spaces s
  where a.tenant_id = t
    and at.id = a.asset_type_id
    and at.name in ('HVAC Unit', 'Elevator', 'Door Controller')
    and s.id = a.assigned_space_id
    and s.tenant_id = t;
end $$;

notify pgrst, 'reload schema';
