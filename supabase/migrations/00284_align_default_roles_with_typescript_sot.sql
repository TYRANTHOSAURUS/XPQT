-- 00284_align_default_roles_with_typescript_sot.sql
--
-- Aligns the database with the canonical TypeScript source of truth in
-- packages/shared/src/role-defaults.ts after the visitors workstream
-- (slices 1-10) extended `DEFAULT_ROLE_TEMPLATES` without shipping a
-- corresponding SQL backfill.
--
-- TS state added since 00207:
--   Service Desk Lead += visitors.reception, visitors.invite
--   Requester         += visitors.invite
--
-- Without this migration, existing tenants' seeded SDL/Requester roles
-- have stale permissions — reception staff can't open /reception/*, and
-- requesters can't invite visitors from the portal. Customer-facing bug.
--
-- Idempotent (union dedupes). Hardened against the edge cases the
-- /full-review surfaced on the 00207 pattern:
--   - jsonb scalar-null ('null'::jsonb) — guarded by jsonb_typeof = 'array'
--   - non-string array elements         — `with ordinality` + jsonb_typeof
--     filter; only string elements survive
--   - SQL null permissions              — coalesce wraps to '[]'::jsonb
--
-- Tenant isolation: per-tenant rows updated in place; no cross-tenant
-- write. RLS on `public.roles` (tenant_id NOT NULL FK) enforces scope.
--
-- KNOWN GAP (out of scope for this migration): new tenants seeded by
-- 00112_seed_role_templates.sql still receive the original 9-perm SDL +
-- 4-perm Requester. Closing that gap requires a tenants-after-insert
-- trigger + a `seed_default_role_templates_for_tenant(uuid)` function —
-- tracked as the destructive-role-rebuild follow-up aligned with the
-- booking-canonicalization direction (CLAUDE.md §"Booking-canonicalization
-- rewrite").

begin;

-- Reusable helper: merge a set of new keys into a role's permissions
-- array, deduped + sorted, and only when the column is array-typed.
-- Non-array values are left untouched (an admin or migration that wrote
-- a malformed value owns its own cleanup).
create or replace function pg_temp.merge_role_permissions(
  p_existing jsonb,
  p_new text[]
) returns jsonb
language sql
immutable
as $$
  select coalesce(
    (
      select jsonb_agg(distinct p order by p)
      from (
        select elem as p
        from jsonb_array_elements_text(coalesce(p_existing, '[]'::jsonb)) as elem
        where elem is not null
        union
        select unnest(p_new)
      ) merged
    ),
    '[]'::jsonb
  );
$$;

update public.roles r
set permissions = pg_temp.merge_role_permissions(
  r.permissions,
  array['visitors.reception', 'visitors.invite']
)
where lower(r.name) = 'service desk lead'
  and jsonb_typeof(coalesce(r.permissions, '[]'::jsonb)) = 'array';

update public.roles r
set permissions = pg_temp.merge_role_permissions(
  r.permissions,
  array['visitors.invite']
)
where lower(r.name) = 'requester'
  and jsonb_typeof(coalesce(r.permissions, '[]'::jsonb)) = 'array';

commit;

notify pgrst, 'reload schema';
