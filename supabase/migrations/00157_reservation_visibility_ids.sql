-- Per-user reservation visibility predicate. Mirrors ticket_visibility_ids
-- (00033) so set-based read paths can filter without N+1 round-trips.
--
-- Three-tier model from ReservationVisibilityService:
--   1. Participant: requester_person_id, host_person_id,
--      attendee_person_ids contains person_id, booked_by_user_id = user.id.
--   2. Operator: rooms.read_all permission on a role assignment.
--   3. Admin:    rooms.admin permission on a role assignment.
--
-- The TS-side ReservationVisibilityService remains the canonical enforcement
-- point for API CRUD; this function exists as a SQL-side predicate for
-- integrations that need to filter reservations in one query (the global
-- search RPC is the immediate caller).

create or replace function public.reservation_visibility_ids(
  p_user_id uuid,
  p_tenant_id uuid
)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select u.id as user_id, u.person_id
    from public.users u
    where u.id = p_user_id and u.tenant_id = p_tenant_id
  ),
  has_admin as (
    select coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'rooms.admin'), false) as v
  ),
  has_read_all as (
    select coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'rooms.read_all'), false) as v
  )
  select r.id
  from public.reservations r, me, has_admin, has_read_all
  where r.tenant_id = p_tenant_id
    and (
      has_admin.v
      or has_read_all.v
      or r.requester_person_id = me.person_id
      or r.host_person_id = me.person_id
      or r.booked_by_user_id = me.user_id
      or me.person_id = any(r.attendee_person_ids)
    );
$$;

revoke all on function public.reservation_visibility_ids(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reservation_visibility_ids(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
