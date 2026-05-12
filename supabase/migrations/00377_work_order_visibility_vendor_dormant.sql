-- 00377_work_order_visibility_vendor_dormant.sql
--
-- Security hotfix + perf follow-up to 00374.
--
-- Codex review of Slice B (planning board) flagged that 00374's vendor
-- branch reintroduced the exact cross-vendor leak that 00035 hotfixed for
-- tickets: `persons.external_source='vendor'` is not tied to a SPECIFIC
-- vendor, so any vendor-linked person could see every vendor-assigned
-- work_order in the tenant via the planning endpoint. Mirror 00035's
-- dormancy until Phase 4 formalizes the person ↔ vendor link.
--
-- Additionally: 00374 added the visibility indexes (requester, watchers,
-- domain-location) but not the planned-window indexes the planning board
-- actually queries on (`planned_start_at >= from AND planned_start_at < to`,
-- optionally narrowed by `assigned_team_id`). Add the partial indexes here
-- so the cron / read path has a hash-join driver, not a seq scan.

begin;

-- ── Vendor-participant dormancy ────────────────────────────────────────
-- Replace the leaky vendor clause with `(false and ...)`, matching 00035's
-- shape verbatim. To re-enable correctly: join `vendors.id` to a
-- per-person vendor_id column once Phase 4 ships, then replace the
-- `false` below.
create or replace function public.work_order_visibility_ids(
  p_user_id uuid,
  p_tenant_id uuid
) returns setof uuid
language sql stable
as $$
  with
    actor as (
      select u.id as user_id, u.person_id
      from public.users u
      where u.id = p_user_id and u.tenant_id = p_tenant_id
    ),
    team_ids as (
      select tm.team_id
      from public.team_members tm
      where tm.tenant_id = p_tenant_id and tm.user_id = p_user_id
    ),
    role_paths as (
      select
        coalesce(ura.domain_scope, '{}'::text[]) as domain_scope,
        coalesce(ura.location_scope, '{}'::uuid[]) as location_scope
      from public.user_role_assignments ura
      where ura.user_id = p_user_id
        and ura.tenant_id = p_tenant_id
        and ura.active = true
    ),
    role_location_closures as (
      select
        r.domain_scope,
        case
          when array_length(r.location_scope, 1) is null then '{}'::uuid[]
          else (select array_agg(x) from public.expand_space_closure(r.location_scope) x)
        end as location_closure
      from role_paths r
    ),
    base as (
      select w.id, w.requester_person_id, w.assigned_user_id, w.assigned_team_id,
             w.assigned_vendor_id, w.watchers, w.location_id,
             rt.domain
      from public.work_orders w
      left join public.request_types rt on rt.id = w.ticket_type_id
      where w.tenant_id = p_tenant_id
    )
  select distinct b.id
  from base b
  cross join actor a
  where
    b.requester_person_id = a.person_id
    or b.assigned_user_id = a.user_id
    or a.person_id = any(b.watchers)
    or b.assigned_team_id in (select team_id from team_ids)
    -- Vendor-participant path is dormant until Phase 4 formalizes person ↔
    -- vendor linking. The 00374 version matched any vendor for any
    -- vendor-external person, a cross-vendor leak (codex review 2026-05-12).
    -- Mirror 00035's pattern for tickets: keep the predicate shape but make
    -- it return zero rows. Re-enable by joining `vendors.id` to a per-person
    -- `vendor_id` once that schema exists.
    or (false and b.assigned_vendor_id is not null)
    or exists (
      select 1 from role_location_closures rc
      where
        (array_length(rc.domain_scope, 1) is null or b.domain = any(rc.domain_scope))
        and (
          array_length(rc.location_closure, 1) is null
          or b.location_id = any(rc.location_closure)
          or b.location_id is null
        )
    );
$$;

comment on function public.work_order_visibility_ids(uuid, uuid) is
  'Set of work_order ids visible to a user inside a tenant. Mirrors public.ticket_visibility_ids; same three-tier model. Vendor-participant path is dormant pending Phase 4 person ↔ vendor schema (mirrors 00035 for tickets).';

-- ── Planning-board partial indexes ─────────────────────────────────────
-- The planning service queries the window with
-- `planned_start_at >= from AND planned_start_at < to`, plus optional
-- assigned_team_id / status filters. Add the partial indexes the planner
-- needs as a hash-join driver.
create index if not exists idx_work_orders_planned
  on public.work_orders (tenant_id, planned_start_at)
  where planned_start_at is not null;

create index if not exists idx_work_orders_planned_assignee
  on public.work_orders (tenant_id, assigned_user_id, planned_start_at)
  where planned_start_at is not null and assigned_user_id is not null;

create index if not exists idx_work_orders_planned_vendor
  on public.work_orders (tenant_id, assigned_vendor_id, planned_start_at)
  where planned_start_at is not null and assigned_vendor_id is not null;

create index if not exists idx_work_orders_planned_team
  on public.work_orders (tenant_id, assigned_team_id, planned_start_at)
  where planned_start_at is not null and assigned_team_id is not null;

-- Index for the unscheduled rail query (planned_start_at IS NULL, open
-- status_category, optional team filter). Without this the unscheduled
-- query seq-scans the whole tenant's work_orders.
create index if not exists idx_work_orders_unscheduled_open
  on public.work_orders (tenant_id, status_category, assigned_team_id)
  where planned_start_at is null
    and status_category in ('new', 'assigned', 'in_progress', 'waiting');

commit;

notify pgrst, 'reload schema';
