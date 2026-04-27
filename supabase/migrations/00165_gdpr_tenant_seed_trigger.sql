-- GDPR baseline · Wave 0 Sprint 1
-- Auto-seed retention defaults whenever a new tenant is inserted.
-- Belt-and-braces: app code can also call seed_default_retention_for_tenant()
-- explicitly, but this trigger guarantees the seed regardless of insertion
-- path (API, Supabase dashboard, manual psql, future migration tooling).

create or replace function public.tenants_seed_retention_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.seed_default_retention_for_tenant(new.id);
  return new;
end;
$$;

drop trigger if exists trg_tenants_seed_retention on public.tenants;
create trigger trg_tenants_seed_retention
  after insert on public.tenants
  for each row execute function public.tenants_seed_retention_after_insert();

comment on function public.tenants_seed_retention_after_insert() is
  'Trigger function: seeds default retention categories for a freshly-created tenant. See gdpr-baseline-design.md §3.';

notify pgrst, 'reload schema';
