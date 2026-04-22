create or replace function public.tickets_distinct_tags(tenant uuid)
returns table(tag text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct t.tag::text as tag
  from tickets, lateral unnest(coalesce(tags, array[]::text[])) as t(tag)
  where tenant_id = tenant
    and t.tag is not null
    and length(trim(t.tag)) > 0
  order by tag
$$;

grant execute on function public.tickets_distinct_tags(uuid) to service_role, authenticated;
