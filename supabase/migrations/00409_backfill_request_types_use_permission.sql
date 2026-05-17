-- 00409_backfill_request_types_use_permission.sql
--
-- RLS audit Slice 11.4 (docs/follow-ups/audits/04-rls-security.md,
-- 2026-05-16, codex DECISION A). Aligns existing tenants' seeded role
-- permissions with the TypeScript source of truth in
-- packages/shared/src/role-defaults.ts.
--
-- Why: Slice 11.3 re-gated config-entity.controller.ts off blanket
-- @UseGuards(AdminGuard) onto @RequirePermission. `GET /config-entities/:id`
-- fetches a request type's form schema and is on the REQUESTER portal
-- critical path (apps/web/.../portal/submit-request.tsx) AND the desk
-- create-ticket dialog (apps/web/.../desk/create-ticket-dialog.tsx).
-- It was class-level AdminGuard pre-11.3 (so a Requester / non-admin
-- agent was ALREADY 403'd — a pre-existing latent defect the /full-review
-- surfaced, NOT a Slice-11 regression). Slice 11.4 introduces a
-- portal-reachable `request_types.use` action and re-gates that single
-- GET to it. Without this backfill, every existing tenant's seeded
-- Requester / IT Agent / FM Agent / Service Desk Lead roles lack the new
-- key and the portal/desk form render keeps 403ing.
--
-- TS state added in Slice 11.4 (role-defaults.ts):
--   Requester         += request_types.use
--   IT Agent          += request_types.use
--   FM Agent          += request_types.use
--   Service Desk Lead += request_types.use
--
-- Mirrors 00393's idempotent pg_temp.merge_role_permissions pattern so a
-- replay is a no-op. Union-dedupes; jsonb_typeof guard skips rows that
-- ever held a non-array value. Additive only — no key removed.
--
-- Tenant isolation: per-tenant rows updated in place; no cross-tenant
-- write. RLS on public.roles (tenant_id NOT NULL FK) enforces scope.
--
-- KNOWN GAP (carried over from 00284/00393): new tenants seeded by
-- 00112_seed_role_templates.sql still receive the pre-slice template.
-- Tracked as the destructive-role-rebuild follow-up.

begin;

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
  array['request_types.use']
)
where lower(r.name) in ('requester', 'it agent', 'fm agent', 'service desk lead')
  and jsonb_typeof(coalesce(r.permissions, '[]'::jsonb)) = 'array';

commit;

notify pgrst, 'reload schema';
