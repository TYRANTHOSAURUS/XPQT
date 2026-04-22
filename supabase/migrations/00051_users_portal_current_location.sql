-- 00051_users_portal_current_location.sql
-- Portal scope slice: server-canonical current portal location per user.
-- Authorization (must be in caller's authorized set) is enforced at the service layer
-- via PATCH /portal/me; a DB-level check would require walking grants/default, which
-- is slow to maintain as onboarding evolves.
-- See docs/portal-scope-slice.md §3.4

alter table public.users
  add column portal_current_location_id uuid references public.spaces(id);

create or replace function public.enforce_user_portal_current_location_tenant()
returns trigger language plpgsql as $$
declare v_tenant uuid; v_active boolean;
begin
  if new.portal_current_location_id is null then return new; end if;
  select tenant_id, active into v_tenant, v_active
  from public.spaces where id = new.portal_current_location_id;
  if v_tenant is null then
    raise exception 'users.portal_current_location_id % does not exist', new.portal_current_location_id;
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: users.tenant=%, space.tenant=%', new.tenant_id, v_tenant;
  end if;
  if not v_active then
    raise exception 'users.portal_current_location_id must reference an active space';
  end if;
  return new;
end;
$$;

create trigger trg_users_portal_current_location_tenant
  before insert or update of portal_current_location_id on public.users
  for each row execute function public.enforce_user_portal_current_location_tenant();
