-- 00374_work_orders_visibility.sql
--
-- Set-based visibility predicate for `work_orders`, the sibling of
-- `ticket_visibility_ids` + `tickets_visible_for_actor` shipped in
-- 00033 / 00187. Same three-tier model (participant · operator · override),
-- same six paths (requester · assigned user · watcher · assigned vendor ·
-- assigned team member · role-domain+location match) — applied to the
-- post-1c.10c `work_orders` base table.
--
-- The planning board (`GET /work-orders/planning`) is the first set-based
-- read on this table; the single-row `assertCanPlan` flow that the
-- command surface uses today is point-and-shoot and doesn't need the
-- function. Adding it now (rather than emulating in TS) honours the
-- `feedback_visibility_gate_lateral` rule — visibility stays in SQL where
-- the planner can use it as a hash-join driver against the dimension
-- tables, and there's no LATERAL projection past the gate.
--
-- The function shape mirrors 00033 / 00187 verbatim so future audits can
-- diff the two predicates and confirm they stay in lock-step.

begin;

-- Supporting indexes for the 6 visibility paths (mirrors 00033's tickets indexes).
-- `assigned_user_id` and `assigned_team_id` already have composite indexes from
-- the 1c.10c cutover; add the participant + GIN coverage explicitly.
create index if not exists idx_work_orders_requester_tenant
  on public.work_orders (tenant_id, requester_person_id);
create index if not exists idx_work_orders_watchers_gin
  on public.work_orders using gin (watchers);
create index if not exists idx_work_orders_tenant_domain_loc
  on public.work_orders (tenant_id, ticket_type_id, location_id);

-- Main visibility predicate for work_orders. Same shape as
-- `public.ticket_visibility_ids` (00033) so the audit story is symmetric.
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
    or b.assigned_vendor_id in (
      select v.id from public.vendors v
      join public.persons p on p.id = a.person_id
      where v.tenant_id = p_tenant_id and p.external_source = 'vendor'
    )
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
  'Set of work_order ids visible to a user inside a tenant. Mirrors public.ticket_visibility_ids; same three-tier model.';

-- Wrapper that returns the full row set so PostgREST can chain filters /
-- sort / pagination directly. `p_has_read_all` skips the predicate join
-- when the caller already resolved `tickets.read_all` (same permission key
-- gates both tables — work_orders inherits the same admin override).
create or replace function public.work_orders_visible_for_actor(
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
        select v.id from public.work_order_visibility_ids(p_user_id, p_tenant_id) v(id)
      )
    );
$$;

comment on function public.work_orders_visible_for_actor(uuid, uuid, boolean) is
  'Visibility-filtered work_orders for an actor. Wraps work_order_visibility_ids; lets PostgREST chain filters/sort/pagination instead of forcing the API to materialize the visible id set in Node. Returns the same row shape as `work_orders`. Mirrors public.tickets_visible_for_actor (00187).';

commit;

notify pgrst, 'reload schema';
