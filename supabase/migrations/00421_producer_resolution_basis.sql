-- Audit 03 producer determinism: persist the canonical resolution basis for
-- idempotency-hashed booking producers. A retry of the same logical command
-- must reuse the first attempt's "now" when evaluating lead-time predicates;
-- otherwise a same-body retry can cross a rule boundary and trip
-- attach_operations.payload_mismatch.

create table if not exists public.producer_resolution_bases (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  idempotency_key text not null,
  basis_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (tenant_id, idempotency_key)
);

alter table public.producer_resolution_bases enable row level security;

drop policy if exists producer_resolution_bases_service_role_all
  on public.producer_resolution_bases;
create policy producer_resolution_bases_service_role_all
  on public.producer_resolution_bases
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create or replace function public.claim_producer_resolution_basis(
  p_tenant_id uuid,
  p_idempotency_key text
) returns timestamptz
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_basis_at timestamptz;
begin
  if p_tenant_id is null then
    raise exception 'claim_producer_resolution_basis: p_tenant_id required'
      using errcode = '22023';
  end if;
  if nullif(btrim(p_idempotency_key), '') is null then
    raise exception 'claim_producer_resolution_basis: p_idempotency_key required'
      using errcode = '22023';
  end if;

  insert into public.producer_resolution_bases (
    tenant_id,
    idempotency_key
  ) values (
    p_tenant_id,
    p_idempotency_key
  )
  on conflict (tenant_id, idempotency_key) do nothing;

  select basis_at
    into v_basis_at
    from public.producer_resolution_bases
   where tenant_id = p_tenant_id
     and idempotency_key = p_idempotency_key;

  if v_basis_at is null then
    raise exception 'claim_producer_resolution_basis: basis not found'
      using errcode = 'P0001';
  end if;

  return v_basis_at;
end;
$$;

revoke execute on function public.claim_producer_resolution_basis(uuid, text)
  from public;
grant execute on function public.claim_producer_resolution_basis(uuid, text)
  to service_role;

comment on table public.producer_resolution_bases is
  'Stable per-idempotency-key resolution timestamps for booking/attach plan producers. Prevents same-intent retries from changing lead-time rule outcomes.';
comment on function public.claim_producer_resolution_basis(uuid, text) is
  'Returns the first basis_at for (tenant_id, idempotency_key), inserting one on first use.';

notify pgrst, 'reload schema';
