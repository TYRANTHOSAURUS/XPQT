-- 00110_permissions_colon_to_dot.sql
--
-- Roles/permissions redesign, slice 3/10.
--
-- Two-pass canonicalisation of roles.permissions:
--   1. Syntax: lower-case, colon→dot (`tickets:read_all` → `tickets.read_all`).
--   2. Semantics: remap legacy coarse keys to the new resource.* convention
--      (`people.manage` → `people.*`, `routing_studio.access` → `routing.*`).
--
-- Idempotent. Historical seed migrations (00034, 00054, 00067, 00081, 00097,
-- 00102, 00108) still emit colon-form — this migration normalises whatever
-- state they leave behind on both `supabase db reset` and remote pushes.

begin;

-- Pass 1: syntax — colon → dot, lower-case. --------------------------------

update public.roles
set permissions = (
  select jsonb_agg(
    case
      when jsonb_typeof(elem) <> 'string' then elem
      else to_jsonb(lower(replace(elem #>> '{}', ':', '.')))
    end
  )
  from jsonb_array_elements(permissions) as elem
),
    updated_at = now()
where permissions is not null
  and jsonb_typeof(permissions) = 'array'
  and exists (
    select 1 from jsonb_array_elements(permissions) e
    where jsonb_typeof(e) = 'string'
      and ((e #>> '{}') like '%:%' or (e #>> '{}') <> lower(e #>> '{}'))
  );

-- Pass 2: semantics — legacy module:manage / routing_studio aliases. -------
-- The `.manage` convention is replaced by explicit actions; roles that
-- historically held `module.manage` should now hold `module.*` so they
-- continue to grant equivalent access.

update public.roles
set permissions = (
  select jsonb_agg(distinct
    case (elem #>> '{}')
      when 'people.manage' then to_jsonb('people.*'::text)
      when 'request_types.manage' then to_jsonb('request_types.*'::text)
      when 'organisations.manage' then to_jsonb('organisations.*'::text)
      when 'service_catalog.manage' then to_jsonb('service_catalog.*'::text)
      when 'criteria_sets.manage' then to_jsonb('criteria_sets.*'::text)
      when 'routing_studio.access' then to_jsonb('routing.*'::text)
      else elem
    end
  )
  from jsonb_array_elements(permissions) as elem
),
    updated_at = now()
where permissions is not null
  and jsonb_typeof(permissions) = 'array'
  and permissions ?| array[
    'people.manage',
    'request_types.manage',
    'organisations.manage',
    'service_catalog.manage',
    'criteria_sets.manage',
    'routing_studio.access'
  ];

-- Belt-and-braces: dedupe after both passes.
update public.roles
set permissions = (
  select jsonb_agg(distinct elem)
  from jsonb_array_elements_text(permissions) elem
),
    updated_at = now()
where permissions is not null
  and jsonb_typeof(permissions) = 'array'
  and jsonb_array_length(permissions) > 0;

commit;

notify pgrst, 'reload schema';
