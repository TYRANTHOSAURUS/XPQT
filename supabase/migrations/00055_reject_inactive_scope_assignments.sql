-- 00055_reject_inactive_scope_assignments.sql
-- Portal scope slice — codex follow-up review: harden the triggers so admins
-- can't assign an inactive space as a person's default or grant.
-- The portal runtime already filters inactive roots in SQL; this migration makes
-- the invariant enforceable at write time, matching the behavior we document.

create or replace function public.enforce_person_default_location_type()
returns trigger language plpgsql as $$
declare v_type text; v_tenant uuid; v_active boolean;
begin
  if new.default_location_id is null then return new; end if;
  select type, tenant_id, active into v_type, v_tenant, v_active
  from public.spaces where id = new.default_location_id;

  if v_type is null then
    raise exception 'persons.default_location_id % does not exist', new.default_location_id;
  end if;
  if v_type not in ('site','building') then
    raise exception 'persons.default_location_id must be site or building (got %)', v_type;
  end if;
  if v_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: persons.tenant=%, space.tenant=%', new.tenant_id, v_tenant;
  end if;
  if not v_active then
    raise exception 'persons.default_location_id must reference an active space';
  end if;
  return new;
end;
$$;

create or replace function public.enforce_person_location_grant_integrity()
returns trigger language plpgsql as $$
declare v_space_type text; v_space_tenant uuid; v_space_active boolean;
        v_person_tenant uuid; v_granter_tenant uuid;
begin
  select type, tenant_id, active into v_space_type, v_space_tenant, v_space_active
  from public.spaces where id = new.space_id;
  if v_space_type is null then
    raise exception 'grant space_id % does not exist', new.space_id;
  end if;
  if v_space_type not in ('site','building') then
    raise exception 'grant target must be site or building (got %)', v_space_type;
  end if;
  if v_space_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: space.tenant=%, grant.tenant=%', v_space_tenant, new.tenant_id;
  end if;
  if not v_space_active then
    raise exception 'grant target must reference an active space';
  end if;

  select tenant_id into v_person_tenant from public.persons where id = new.person_id;
  if v_person_tenant is null then
    raise exception 'grant person_id % does not exist', new.person_id;
  end if;
  if v_person_tenant <> new.tenant_id then
    raise exception 'grant tenant mismatch: person.tenant=%, grant.tenant=%', v_person_tenant, new.tenant_id;
  end if;

  if new.granted_by_user_id is not null then
    select tenant_id into v_granter_tenant from public.users where id = new.granted_by_user_id;
    if v_granter_tenant is null then
      raise exception 'grant granted_by_user_id % does not exist', new.granted_by_user_id;
    end if;
    if v_granter_tenant <> new.tenant_id then
      raise exception 'grant tenant mismatch: granter.tenant=%, grant.tenant=%', v_granter_tenant, new.tenant_id;
    end if;
  end if;

  return new;
end;
$$;
