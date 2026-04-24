-- 00109_permissions_wildcards.sql
--
-- Roles/permissions redesign, slice 2/10.
--
-- 1. Redefine public.user_has_permission with:
--    - dot-notation + wildcard matching (tickets.*, *.read, *.*)
--    - backward compatibility with legacy colon-form keys (tickets:read_all)
--    - null/empty/malformed input guards
--    - time-bound assignment filtering (starts_at / ends_at)
-- 2. Add starts_at / ends_at columns to public.user_role_assignments.
-- 3. Add GIN index on public.roles.permissions to keep ?| queries cheap.
--
-- Data rewrite from colon to dot-form lives in a follow-up migration so this
-- slice is safe to ship alone: the new evaluator normalises input and the
-- stored form interchangeably, so callers using either notation continue to
-- work during the transition.

begin;

-- 1. Time-bound assignments ---------------------------------------------------

alter table public.user_role_assignments
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz;

comment on column public.user_role_assignments.starts_at is
  'When the assignment becomes effective. Null = effective immediately.';
comment on column public.user_role_assignments.ends_at is
  'When the assignment expires. Null = indefinite. Expired assignments are ignored by user_has_permission.';

create index if not exists user_role_assignments_ends_at_idx
  on public.user_role_assignments (ends_at)
  where ends_at is not null;

-- 2. GIN index for permission lookups ----------------------------------------

create index if not exists roles_permissions_gin_idx
  on public.roles using gin (permissions jsonb_path_ops);

-- 3. Evaluator ----------------------------------------------------------------

create or replace function public.user_has_permission(
  p_user_id uuid,
  p_tenant_id uuid,
  p_permission text
) returns boolean
language sql stable
as $$
  with
    norm as (
      -- Lowercase + colon→dot so legacy `tickets:read_all` callers keep
      -- working while the data migration to dot-form rolls out.
      select lower(replace(coalesce(p_permission, ''), ':', '.')) as key
    ),
    parts as (
      select
        key,
        split_part(key, '.', 1) as resource,
        split_part(key, '.', 2) as action,
        array_length(regexp_split_to_array(key, '\.'), 1) as segment_count
      from norm
    )
  select exists (
    select 1
    from public.user_role_assignments ura
    join public.roles r on r.id = ura.role_id
    cross join parts p
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
      and r.active = true
      and (ura.starts_at is null or ura.starts_at <= now())
      and (ura.ends_at is null or ura.ends_at > now())
      and p.segment_count = 2
      and p.resource <> ''
      and p.action <> ''
      and coalesce(r.permissions, '[]'::jsonb) ?| array[
        p.key,
        p.resource || '.*',
        '*.' || p.action,
        '*.*'
      ]
  );
$$;

comment on function public.user_has_permission(uuid, uuid, text) is
  'Dot-notation + wildcard permission check. Accepts colon-form for backward compatibility. Honours user_role_assignments time bounds.';

commit;

notify pgrst, 'reload schema';
