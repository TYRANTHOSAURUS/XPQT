-- Helper function to extract tenant_id from the JWT
-- Supabase Auth JWTs carry app_metadata which we'll use to store tenant_id
-- RLS policies reference this function for zero-join tenant filtering

create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select coalesce(
    (current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'tenant_id')::uuid,
    (current_setting('request.jwt.claims', true)::jsonb ->> 'tenant_id')::uuid
  )
$$;

-- Helper to get current user ID from JWT
create or replace function public.current_user_id()
returns uuid
language sql
stable
as $$
  select (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
$$;

-- Updated_at trigger function — reusable across all tables
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;
