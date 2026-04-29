-- 00187_tickets_visible_for_actor.sql
--
-- Wrap `ticket_visibility_ids` in a `SETOF tickets` RPC so the API can chain
-- filters/sort/pagination on top in PostgREST instead of materializing the
-- full visible-ticket-id set in Node and feeding it back as `.in('id', ids)`.
-- The latter is pathological for tenants with large visible sets — it sends
-- megabytes of UUIDs over the wire and forces Postgres to plan a giant IN
-- list. With this RPC, the predicate stays in SQL where the planner can use
-- it as a hash-join driver against the inner tickets scan.
--
-- `p_has_read_all` lets callers that already resolved the read-all override
-- (via `user_has_permission('tickets.read_all')`) skip the visibility join
-- entirely without making a second RPC round-trip.

begin;

create or replace function public.tickets_visible_for_actor(
  p_user_id uuid,
  p_tenant_id uuid,
  p_has_read_all boolean default false
) returns setof public.tickets
language sql
stable
as $$
  -- ticket_visibility_ids() returns SETOF uuid, not TABLE(id uuid), so the
  -- subquery must alias the scalar set as `v(id)` — same shape used in
  -- 00136 / 00151 / 00158. Plain `select id from …` would not parse.
  select t.*
  from public.tickets t
  where t.tenant_id = p_tenant_id
    and (
      p_has_read_all
      or t.id in (
        select v.id from public.ticket_visibility_ids(p_user_id, p_tenant_id) v(id)
      )
    );
$$;

comment on function public.tickets_visible_for_actor(uuid, uuid, boolean) is
  'Visibility-filtered tickets for an actor. Wraps ticket_visibility_ids; lets PostgREST chain filters/sort/pagination instead of forcing the API to materialize the visible ID set in Node. Returns the same row shape as `tickets`.';

commit;

notify pgrst, 'reload schema';
