-- 00247_backfill_assign_and_priority_permissions.sql
--
-- Backfill `tickets.assign` and `tickets.change_priority` onto every existing
-- role that currently grants `tickets.update` but does NOT already grant the
-- broad override `tickets.write_all`.
--
-- Rationale (security alignment slice):
--
-- Pre-1c.10c, the case-side (parent ticket) update + reassign code paths
-- enforced authorization with `assertVisible('write')` only. The work-order
-- side (child fulfilment) layered the per-action keys
-- `tickets.change_priority` and `tickets.assign` on top of the same
-- visibility floor — that's the canonical pattern documented in the
-- permission catalog (packages/shared/src/permissions.ts).
--
-- This commit aligns case-side with work-order-side. Without this migration,
-- existing tenants with custom roles holding `tickets.update` (but not
-- `tickets.assign` or `tickets.change_priority`) would LOSE the ability to
-- reassign or change priority on cases the moment the new code ships — a
-- silent permission regression.
--
-- Mitigation: grandfather every role that already has `tickets.update` into
-- both per-action keys. Roles with `tickets.write_all` already bypass these
-- checks at the service layer (ctx.has_write_all short-circuit), so we
-- skip them — keeping the "real" permission set lean for new tenants seeded
-- post-migration.
--
-- Idempotent: uses `jsonb_agg(distinct …)` so re-running this migration is a
-- no-op for roles that already carry both keys. Safe to re-apply via
-- `pnpm db:reset`.
--
-- Tenant isolation: `roles` is per-tenant (tenant_id NOT NULL FK + RLS).
-- This migration touches each tenant's rows independently — no cross-tenant
-- data movement.
--
-- Post-state assertion: see DO block at the bottom. Raises if any role with
-- `tickets.update` still lacks `tickets.assign` or `tickets.change_priority`
-- after the update. Catches the case where the merge logic regresses or a
-- tenant's permissions array carries a non-string element that breaks the
-- jsonb_array_elements_text expansion.

begin;

update public.roles r
set permissions = coalesce(
  (
    select jsonb_agg(distinct p order by p)
    from (
      select jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as p
      union
      select unnest(array['tickets.assign', 'tickets.change_priority'])
    ) merged
  ),
  '[]'::jsonb
),
updated_at = now()
where exists (
  select 1
  from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
  where elem = 'tickets.update'
)
and not exists (
  select 1
  from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
  where elem = 'tickets.write_all'
);

-- Inline post-state assertion. If any role still violates the invariant
-- "has tickets.update => has tickets.assign AND tickets.change_priority
-- (unless it has tickets.write_all)", abort the migration.
do $$
declare
  v_offender record;
  v_count integer := 0;
begin
  for v_offender in
    select r.id, r.tenant_id, r.name
    from public.roles r
    where exists (
      select 1
      from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
      where elem = 'tickets.update'
    )
    and not exists (
      select 1
      from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
      where elem = 'tickets.write_all'
    )
    and (
      not exists (
        select 1
        from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
        where elem = 'tickets.assign'
      )
      or not exists (
        select 1
        from jsonb_array_elements_text(coalesce(r.permissions, '[]'::jsonb)) as elem
        where elem = 'tickets.change_priority'
      )
    )
  loop
    v_count := v_count + 1;
    raise warning '00247: role % (tenant=%, name=%) still missing tickets.assign or tickets.change_priority after backfill',
      v_offender.id, v_offender.tenant_id, v_offender.name;
  end loop;

  if v_count > 0 then
    raise exception '00247_backfill_assign_and_priority_permissions: % role(s) still violate the grandfather invariant after backfill — aborting', v_count;
  end if;
end;
$$;

commit;

notify pgrst, 'reload schema';
