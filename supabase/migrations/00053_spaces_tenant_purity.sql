-- 00053_spaces_tenant_purity.sql
-- Portal scope slice: enforce that spaces.parent_id stays within the same tenant.
-- Closure-based expansion (expand_space_closure) trusts the tree; this guards the tree.
-- See docs/portal-scope-slice.md §3.5

create or replace function public.enforce_spaces_parent_tenant()
returns trigger language plpgsql as $$
declare v_parent_tenant uuid;
begin
  if new.parent_id is null then return new; end if;
  select tenant_id into v_parent_tenant from public.spaces where id = new.parent_id;
  if v_parent_tenant is null then
    raise exception 'spaces.parent_id % does not exist', new.parent_id;
  end if;
  if v_parent_tenant <> new.tenant_id then
    raise exception 'tenant mismatch: space.tenant=%, parent.tenant=%', new.tenant_id, v_parent_tenant;
  end if;
  return new;
end;
$$;

create trigger trg_spaces_parent_tenant
  before insert or update of parent_id on public.spaces
  for each row execute function public.enforce_spaces_parent_tenant();
