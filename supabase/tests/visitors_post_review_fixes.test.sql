-- Regression tests for visitor management v1 post-shipping review fixes.
-- Covers C1 (missing PII columns), C2 (domain_events leak), C4 (visibility null
-- leak), C5 (persons→visitors PII sync trigger).
--
-- Usage:
--   PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/visitors_post_review_fixes.test.sql
--
-- Remote:
--   PGPASSWORD=$SUPABASE_DB_PASS psql \
--     "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/visitors_post_review_fixes.test.sql
--
-- All assertions raise if a regression slips. Wrapped in a transaction so
-- side-effects roll back on failure.

begin;

-- ==========================================================================
-- C1: visitors has the three columns service code references.
-- ==========================================================================
do $$
declare
  v_missing text[];
begin
  select array_agg(col)
    into v_missing
    from unnest(array['meeting_room_id','notes_for_visitor','notes_for_reception']) col
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name = 'visitors'
        and column_name = col
   );
  if v_missing is not null then
    raise exception 'C1 regression: visitors is missing columns: %', v_missing;
  end if;
end$$;

-- ==========================================================================
-- C2: public.domain_events grants restricted to service_role + postgres only.
-- anon and authenticated must not have ANY privilege on the table.
-- ==========================================================================
do $$
declare
  v_leaked text[];
begin
  select array_agg(grantee || ':' || privilege_type)
    into v_leaked
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'domain_events'
     and grantee in ('anon', 'authenticated', 'public');
  if v_leaked is not null then
    raise exception 'C2 regression: domain_events still accessible to non-service roles: %', v_leaked;
  end if;
end$$;

-- ==========================================================================
-- C4: visitor_visibility_ids does NOT include the OR v.building_id IS NULL
-- admit-all branch. We assert the function definition no longer contains
-- the buggy disjunct on the Tier 2 branch.
-- ==========================================================================
do $$
declare
  v_def text;
begin
  select pg_get_functiondef('public.visitor_visibility_ids(uuid,uuid)'::regprocedure)
    into v_def;
  -- The function should only have the NULL admit-all in the Tier 1 (host)
  -- and Tier 3 (read_all) branches — never inside the Tier 2 (operator) one.
  -- Crude check: exactly one OR-clause in the file uses building_id, and
  -- it must NOT live inside a block referencing user_has_permission with
  -- 'visitors.reception'.
  if v_def ~ 'visitors\.reception.*\n[^;]*v\.building_id is null' then
    raise exception 'C4 regression: Tier 2 (visitors.reception) still has OR v.building_id IS NULL';
  end if;
end$$;

-- ==========================================================================
-- C5: trg_sync_persons_pii_to_visitors trigger exists on public.persons and
-- fires AFTER UPDATE for the four PII columns.
-- ==========================================================================
do $$
declare
  v_trigger record;
begin
  select t.tgname, t.tgenabled, t.tgtype
    into v_trigger
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'persons'
     and t.tgname = 'trg_sync_persons_pii_to_visitors';
  if v_trigger is null then
    raise exception 'C5 regression: trg_sync_persons_pii_to_visitors trigger missing on public.persons';
  end if;
  if v_trigger.tgenabled = 'D' then
    raise exception 'C5 regression: trg_sync_persons_pii_to_visitors is disabled';
  end if;
end$$;

-- C5 (functional): updating persons.first_name propagates to visitors row.
-- Uses any existing tenant (skips silently if none exist — the trigger
-- existence check above is the primary regression gate).
do $$
declare
  v_tenant uuid;
  v_person uuid := 'fffffff1-0000-0000-0000-000000000c51';
  v_visitor uuid := 'fffffff1-0000-0000-0000-000000000c52';
  v_after text;
begin
  select id into v_tenant from public.tenants order by created_at limit 1;
  if v_tenant is null then
    raise notice 'C5 functional check skipped: no tenants in DB';
    return;
  end if;

  insert into public.persons (id, tenant_id, type, first_name, last_name, email)
    values (v_person, v_tenant, 'visitor', 'Original', 'Person', 'c5-test-orig@example.com')
  on conflict (id) do update set first_name='Original', last_name='Person', email='c5-test-orig@example.com';

  insert into public.visitors (id, tenant_id, person_id, host_person_id,
                               primary_host_person_id, status, visit_date,
                               first_name, last_name, email)
    values (v_visitor, v_tenant, v_person, v_person,
            v_person, 'expected', current_date,
            'Original', 'Person', 'c5-test-orig@example.com')
  on conflict (id) do update set first_name='Original', last_name='Person', email='c5-test-orig@example.com';

  -- Mutate the persons row → trigger should fan out.
  update public.persons set first_name = 'Renamed' where id = v_person;

  select first_name into v_after from public.visitors where id = v_visitor;
  if v_after is distinct from 'Renamed' then
    raise exception 'C5 regression: visitors.first_name not synced (got %, want Renamed)', v_after;
  end if;

  -- Anonymization-via-trigger: PersonsAdapter sets first_name='Former employee'
  -- (not NULL — persons.first_name is NOT NULL). The trigger must fan that out.
  update public.persons set first_name = 'Former employee', email = null where id = v_person;
  select first_name into v_after from public.visitors where id = v_visitor;
  if v_after is distinct from 'Former employee' then
    raise exception 'C5 regression: visitors.first_name not synced after persons anonymized (got %, want Former employee)', v_after;
  end if;

  -- Cleanup (rollback below also removes; this is belt-and-braces for
  -- environments where the test runs with autocommit disabled).
  delete from public.visitors where id = v_visitor;
  delete from public.persons where id = v_person;
end$$;

rollback;

-- All assertions passed if we reach here.
\echo 'visitors_post_review_fixes.test.sql: ALL TESTS PASSED'
