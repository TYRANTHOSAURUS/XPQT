-- 00385 — defense-in-depth tenant filter on the request_types join inside
-- work_orders_visible_to_operator (00380).
--
-- Spec: ai/handoff-planning-board-cleanup.md (codex remediation, IMPORTANT).
--
-- Codex flagged that the LEFT JOIN at 00380:73
--   `left join request_types rt on rt.id = w.ticket_type_id`
-- joins by id only. Schema FKs SHOULD enforce that `request_types.tenant_id
-- = work_orders.tenant_id`, but a belt-and-braces filter on every dimension
-- table by tenant_id is the canonical XPQT visibility-predicate pattern
-- (memory: feedback_tenant_id_ultimate_rule). Adding it here removes any
-- coupling on the FK-correctness invariant and matches the shape of the
-- six other tenant_id filters in this function.
--
-- The function body is otherwise byte-for-byte identical to 00380. The
-- planning wrapper (`work_orders_planning_visible_for_actor`) is
-- unaffected — it calls `work_orders_visible_to_operator(...)` by name,
-- so a CREATE OR REPLACE picks up the new body automatically.

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
      left join public.request_types rt
        on rt.id = w.ticket_type_id
       and rt.tenant_id = p_tenant_id
      where w.tenant_id = p_tenant_id
    )
  select distinct b.id
  from base b
  cross join actor a
  where
    b.assigned_user_id = a.user_id
    or b.assigned_team_id in (select team_id from team_ids)
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

comment on function public.work_orders_visible_to_operator(uuid, uuid) is
  'Operator-only visibility predicate for work_orders. Same six-path model as work_order_visibility_ids minus the requester + watcher branches (and minus readonly role scopes — the planning board is a write surface, readonly cross-domain roles get no rows). 00385 codex remediation: the request_types join now filters on tenant_id explicitly (belt-and-braces — the FK should enforce this, but every other dimension in this predicate filters by tenant_id and consistency is the point). Used exclusively by the planning-board read path so requesters/watchers cannot see plandate fields for WOs where their only visibility path is the requester or watcher tier.';

notify pgrst, 'reload schema';
