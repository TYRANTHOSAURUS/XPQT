-- 00380_work_orders_planning_visibility.sql
--
-- Security hotfix to the planning-board read path
-- (`GET /work-orders/planning`).
--
-- Codex architecture review of Slice B flagged that
-- `work_orders_visible_for_actor` (00374 + 00377) includes the
-- requester and watcher paths — correct for the general ticket
-- visibility contract, but WRONG for the planning board. Per
-- `project_plandate_not_for_requester`: plandate is operator/desk-only;
-- a requester or watcher must NOT see `planned_start_at` /
-- `planned_duration_minutes` for a work_order via the dispatcher
-- surface.
--
-- The desk-side frontend gates `/desk/planning` behind
-- `ProtectedRoute requiredRole="agent"`, but that is a UX gate, not a
-- security gate. An authenticated requester with a valid JWT can hit
-- `GET /work-orders/planning` directly and read plandate fields for any
-- WO where they are the requester or a watcher.
--
-- Fix: add a parallel SQL function with a narrower predicate that drops
-- the requester + watcher branches. The general predicate
-- (`work_order_visibility_ids` / `work_orders_visible_for_actor`) stays
-- intact for the rest of the WO surface. The planning service swaps to
-- this operator-only wrapper.

begin;

-- Operator-only visibility predicate for work_orders. Same as
-- `work_order_visibility_ids` minus the requester + watcher branches.
-- Vendor path stays dormant (mirrors 00377).
create or replace function public.work_orders_visible_to_operator(
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
        and ura.read_only_cross_domain = false
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
      select w.id, w.assigned_user_id, w.assigned_team_id,
             w.assigned_vendor_id, w.location_id,
             rt.domain
      from public.work_orders w
      left join public.request_types rt on rt.id = w.ticket_type_id
      where w.tenant_id = p_tenant_id
    )
  select distinct b.id
  from base b
  cross join actor a
  where
    -- Operator paths only — explicitly NO requester / NO watcher.
    b.assigned_user_id = a.user_id
    or b.assigned_team_id in (select team_id from team_ids)
    or (false and b.assigned_vendor_id is not null)  -- dormant (mirrors 00377)
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

comment on function public.work_orders_visible_to_operator(uuid, uuid) is
  'Operator-only visibility predicate for work_orders. Same six-path model as work_order_visibility_ids minus the requester + watcher branches (and minus readonly role scopes — the planning board is a write surface, readonly cross-domain roles get no rows). Used exclusively by the planning-board read path so requesters/watchers cannot see plandate fields for WOs where their only visibility path is the requester or watcher tier.';

-- Wrapper that returns the full row set so PostgREST can chain filters
-- directly. Same shape as 00374's `work_orders_visible_for_actor`.
create or replace function public.work_orders_planning_visible_for_actor(
  p_user_id uuid,
  p_tenant_id uuid,
  p_has_read_all boolean default false
) returns setof public.work_orders
language sql stable
as $$
  select w.*
  from public.work_orders w
  where w.tenant_id = p_tenant_id
    and (
      p_has_read_all
      or w.id in (
        select v.id from public.work_orders_visible_to_operator(p_user_id, p_tenant_id) v(id)
      )
    );
$$;

comment on function public.work_orders_planning_visible_for_actor(uuid, uuid, boolean) is
  'Operator-scoped wrapper around work_orders_visible_to_operator. Drop-in replacement for work_orders_visible_for_actor (00374) on the planning-board read path. Returns the full row set so PostgREST / the API can chain filters. tickets.read_all override still applies (admins see everything regardless of operator path).';

commit;

notify pgrst, 'reload schema';
