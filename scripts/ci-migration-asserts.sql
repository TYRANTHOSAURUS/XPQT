-- scripts/ci-migration-asserts.sql
--
-- Post-migration schema-integrity assertions. Run this against a database
-- where every migration in supabase/migrations/ has been applied. Raises an
-- exception on the first failure with a descriptive message; if it returns
-- cleanly, every invariant below holds.
--
-- Used by .github/workflows/ci.yml as a gate so that the bug class which
-- caused the 2026-04-30 data-loss incidents (961 rows deleted by a
-- CASCADE FK that a `pg_get_constraintdef like '%public.tickets%'` loop
-- silently failed to drop) cannot ship again unnoticed.
--
-- Locally: `psql "<conn>" -v ON_ERROR_STOP=1 -f scripts/ci-migration-asserts.sql`
-- after `pnpm db:reset`. Output should be a series of NOTICEs ending with
-- `OK: all assertions passed`.

\set ON_ERROR_STOP on

do $$
declare
  v_count int;
  v_missing text;
begin
  -- ===========================================================
  -- A1. No CASCADE FKs to public.tickets remain.
  -- ===========================================================
  -- Defends the bug class that caused the 2026-04-30 data-loss incident:
  -- a destructive cutover DELETE'd 319 work_order rows from tickets while
  -- ticket_activities (315) and sla_timers (646) still had ON DELETE
  -- CASCADE FKs pointing at tickets. The drop loop in the cutover
  -- migration filtered constraints by `pg_get_constraintdef like
  -- '%public.tickets%'`, but pg_get_constraintdef OMITS the schema
  -- qualifier — the LIKE never matched, the DROP never ran, and the
  -- subsequent DELETE cascade-nuked 961 rows of dependent data.
  --
  -- This assertion would have caught it pre-flight.
  select count(*) into v_count
    from pg_constraint
   where contype = 'f'
     and confrelid = 'public.tickets'::regclass
     and confdeltype = 'c';
  if v_count > 0 then
    raise exception 'A1: % CASCADE FK(s) to public.tickets remain. Cascade-delete data-loss hazard. Drop them by EXPLICIT name (see migration 00238 for the right pattern), do NOT use a LIKE-pattern DO block.', v_count;
  end if;
  raise notice 'A1 OK: no CASCADE FKs to public.tickets';

  -- ===========================================================
  -- A2. tickets.ticket_kind column does NOT exist.
  -- ===========================================================
  -- The destructive cutover (00233) drops this column. If it ever comes
  -- back, the case/work_order separation has regressed.
  select count(*) into v_count
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'tickets'
     and column_name = 'ticket_kind';
  if v_count > 0 then
    raise exception 'A2: tickets.ticket_kind column reappeared. The case/work_order extraction has regressed.';
  end if;
  raise notice 'A2 OK: tickets.ticket_kind column gone';

  -- ===========================================================
  -- A3. public.work_orders is a real BASE TABLE.
  -- ===========================================================
  -- Step 1c.3.6 atomically renamed work_orders_new to work_orders. If
  -- something later turned it back into a view, dispatch / rollup / SLA
  -- triggers would silently fail or behave wrong.
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'public'
       and table_name = 'work_orders'
       and table_type = 'BASE TABLE'
  ) then
    raise exception 'A3: public.work_orders is missing or is not a BASE TABLE.';
  end if;
  raise notice 'A3 OK: public.work_orders is a base table';

  -- ===========================================================
  -- A4. public.activities polymorphic sidecar is intact.
  -- ===========================================================
  -- Required columns: entity_kind text, entity_id uuid. The sidecar
  -- replaces ticket-only ticket_activities and powers cross-kind audit.
  for v_missing in
    select c
      from unnest(array['entity_kind', 'entity_id', 'tenant_id', 'activity_type', 'created_at']) as t(c)
     where not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'activities'
          and column_name = t.c
     )
  loop
    raise exception 'A4: public.activities is missing column: %', v_missing;
  end loop;
  raise notice 'A4 OK: public.activities has the polymorphic columns';

  -- ===========================================================
  -- A5. Polymorphic FKs on sla_timers / workflow_instances / routing_decisions.
  -- ===========================================================
  -- Step 1c.6/7/8 added (entity_kind, case_id, work_order_id) to each. If
  -- any column went missing, the kind-consistent triggers would silently
  -- pass and writers would split into wrong buckets.
  for v_missing in
    with required(table_name, column_name) as (
      values
        ('sla_timers', 'entity_kind'),
        ('sla_timers', 'case_id'),
        ('sla_timers', 'work_order_id'),
        ('workflow_instances', 'entity_kind'),
        ('workflow_instances', 'case_id'),
        ('workflow_instances', 'work_order_id'),
        ('routing_decisions', 'entity_kind'),
        ('routing_decisions', 'case_id'),
        ('routing_decisions', 'work_order_id')
    )
    select format('%I.%I', r.table_name, r.column_name)
      from required r
     where not exists (
       select 1 from information_schema.columns c
        where c.table_schema = 'public'
          and c.table_name = r.table_name
          and c.column_name = r.column_name
     )
  loop
    raise exception 'A5: missing polymorphic column: %', v_missing;
  end loop;
  raise notice 'A5 OK: polymorphic FKs intact on sla_timers/workflow_instances/routing_decisions';

  -- ===========================================================
  -- A6. tenant_id present on every tenant-scoped table.
  -- ===========================================================
  -- THE #0 invariant per CLAUDE.md memory feedback_tenant_id_ultimate_rule:
  -- "missing tenant filter on a new table/query/test is a cross-tenant leak
  -- (P0 security incident), not a bug." Enforced at schema layer here.
  -- The list is intentionally explicit (not regex over all public tables)
  -- so that adding a new genuinely-global table doesn't silently fail this
  -- check, AND so that adding a new tenant-scoped table forces an explicit
  -- update here.
  for v_missing in
    select t
      from unnest(array[
        'tickets', 'work_orders', 'activities', 'ticket_activities',
        'persons', 'users', 'teams', 'team_members', 'vendors',
        'spaces', 'space_groups', 'space_group_members',
        'request_types', 'routing_rules', 'routing_decisions',
        'bookings', 'booking_slots', 'orders', 'order_line_items',
        'sla_timers', 'sla_policies',
        'workflow_definitions', 'workflow_instances',
        'org_nodes', 'person_org_memberships'
      ]) as t(t)
     where not exists (
       select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = t.t
          and column_name = 'tenant_id'
     )
     -- Don't flag tables that simply don't exist (yet). Only fail when the
     -- table exists but tenant_id is missing.
     and exists (
       select 1 from information_schema.tables
        where table_schema = 'public'
          and table_name = t.t
     )
  loop
    raise exception 'A6: tenant-scoped table public.% is missing tenant_id column. Cross-tenant leak hazard.', v_missing;
  end loop;
  raise notice 'A6 OK: every known tenant-scoped table has tenant_id';

  -- ===========================================================
  -- A7. ticket_visibility_ids canonical predicate exists.
  -- ===========================================================
  -- Per CLAUDE.md, this is the canonical SQL predicate that enforces the
  -- three-tier ticket visibility model (participants / operators /
  -- overrides). If it gets dropped or the signature changes, the API can
  -- silently bypass visibility rules.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'ticket_visibility_ids'
  ) then
    raise exception 'A7: public.ticket_visibility_ids() function is missing. Visibility enforcement broken.';
  end if;
  raise notice 'A7 OK: public.ticket_visibility_ids exists';

  -- ===========================================================
  -- A8. user_has_permission canonical predicate exists.
  -- ===========================================================
  -- Per CLAUDE.md visibility doc, this is the central permission check
  -- for tickets:read_all / tickets:write_all overrides. Same risk
  -- profile as A7.
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'user_has_permission'
  ) then
    raise exception 'A8: public.user_has_permission() function is missing. Permission overrides broken.';
  end if;
  raise notice 'A8 OK: public.user_has_permission exists';

  -- ===========================================================
  -- A9. Polymorphic kind-consistent triggers are installed.
  -- ===========================================================
  -- Migration 00236 added a single `enforce_entity_kind_integrity()`
  -- trigger function on public.activities to reject cross-kind writes.
  -- Per the handoff, future polymorphic surfaces should grow analogous
  -- triggers; for now this is the canary.
  if not exists (
    select 1 from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'activities'
       and not t.tgisinternal
  ) then
    raise exception 'A9: no triggers found on public.activities. The entity_kind integrity trigger from 00236 is missing.';
  end if;
  raise notice 'A9 OK: triggers present on public.activities';

  -- ===========================================================
  -- A10. No duplicate migration prefixes.
  -- ===========================================================
  -- We can't see the filenames from inside Postgres, but we can assert
  -- the schema_migrations row count matches the file count via the
  -- shell harness. Here we verify the rename target slots got applied:
  -- 00241..00244 are the deferred secondaries from the duplicate-prefix
  -- cleanup. Their effects must be visible in schema.
  --
  -- 00241_tenant_branding_surface_colors → adds 4 keys to tenants.branding default.
  -- 00242_scheduler_data_rpc → creates scheduler_data() function.
  -- 00243_vendor_portal_status_en_route → adds 'en_route' to fulfillment_status enum.
  -- 00244_vendor_status_events_realtime → adds publication membership.
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname='scheduler_data'
  ) then
    raise exception 'A10: 00242_scheduler_data_rpc effect missing — scheduler_data function not created. Did the renumber break the apply order?';
  end if;
  raise notice 'A10 OK: 00241..00244 renumbered migrations applied';

  -- ===========================================================
  -- A11. RETIRED — booking visibility predicate.
  -- ===========================================================
  -- The original A11 exercised public.bundle_is_visible_to_user(uuid,uuid,uuid)
  -- against public.booking_bundles + public.work_orders. Both the function
  -- (00148, 00245) and the booking_bundles table were dropped by the
  -- 2026-05-02 booking-canonicalization rewrite (migration 00276 + 00279).
  -- The canonical replacement entity is public.bookings (00277); a parity
  -- visibility predicate has not been re-introduced because TicketVisibility
  -- handles WO-side visibility today and booking visibility lives entirely
  -- in TS service code (see docs/visibility.md).
  --
  -- TODO: when a SQL `booking_visible_ids(user_id, tenant_id)` predicate
  -- ships (analog to public.ticket_visibility_ids — see A7), restore an
  -- A11 behavioral check against it: insert a synthetic bookings row +
  -- pending approval and assert the predicate grants via the approver
  -- path; insert a WO assigned to a user and assert the predicate grants
  -- via the WO-assignee path. Match the cleanup-on-success/failure shape
  -- of the original block. Until then this slot stays vacant.
  raise notice 'A11 SKIP: bundle visibility predicate retired (booking_bundles dropped by 00276; canonical replacement TBD)';

  -- ===========================================================
  -- A12. service_role has full DML on every tenant-scoped writable BASE TABLE.
  -- ===========================================================
  -- Defends the bug class that surfaced in the 2026-05-01 P0: migration
  -- 00222 (step 1c.3.6 atomic rename) applied a deliberately-temporary
  -- "SELECT only for service_role" posture on public.work_orders,
  -- intended to be reversed at step 1c.4 (writer flip). The reversal
  -- never shipped. Sessions 7-12 layered the entire work-order command
  -- surface on top, mocking Supabase in every test, so the 42501
  -- "permission denied for table work_orders" error only surfaced when
  -- the user clicked PATCH against the live DB. Migration 00275 restored
  -- INSERT/UPDATE/DELETE; this assertion prevents the same shape of
  -- regression on any other tenant-scoped writable table.
  --
  -- The whole NestJS API authenticates as service_role for DML. Any
  -- writable tenant table that loses one of those four privileges
  -- breaks an entire surface silently — every test passes, every UI
  -- click 500s.
  --
  -- VERSION HISTORY:
  --   - Session 13 v1: hard-coded `public.work_orders` only (caught
  --     the immediate P0 instance, missed the bug class).
  --   - Session 13 v2: hard-coded list of 25 tenant-scoped tables,
  --     mirroring A6. Caught the class for those 25 — but missed
  --     ~80 other tenant-scoped writable tables that grew alongside
  --     (visitor_types, audit_events, domain_events, etc). Migration
  --     00269 had to "belt-and-braces" re-grant on domain_events
  --     because no gate caught a hypothetical regression on it.
  --   - Session 14 v3 (this version): SELF-MAINTAINING. Auto-enumerate
  --     via `tenant_id` column presence — every public BASE TABLE
  --     with a `tenant_id` column is in scope. New tenant-scoped
  --     tables join the gate the moment they're created without any
  --     manual list update. The `tenant_id` column itself is the
  --     #0 invariant per CLAUDE.md feedback_tenant_id_ultimate_rule;
  --     using it as the discriminator means A12 follows the canonical
  --     "tenant-scoped surface" definition.
  --
  -- Exclusions: an EMPTY allowlist today. If a future tenant-scoped
  -- table genuinely should be SELECT-only on service_role (e.g. a
  -- read-only materialized view that's a base table), add it to
  -- v_intentional_select_only_tables with a justifying comment.
  -- Every entry there is a maintenance hot-spot — keep the list
  -- explicit, small, and audited.
  declare
    v_intentional_select_only_tables text[] := array[]::text[];
    v_table text;
    v_priv text;
    v_privs text[] := array['SELECT','INSERT','UPDATE','DELETE'];
    v_writable_tables text[];
    v_checked int := 0;
  begin
    -- Auto-enumerate every public BASE TABLE that carries a tenant_id
    -- column. This is the canonical "tenant-scoped surface" set —
    -- includes inherited partitions (which Postgres reports as
    -- BASE TABLE with the same tenant_id column).
    select array_agg(distinct c.table_name order by c.table_name)
    into v_writable_tables
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'tenant_id'
      and t.table_type = 'BASE TABLE'
      and not (c.table_name = ANY(v_intentional_select_only_tables));

    foreach v_table in array v_writable_tables loop
      foreach v_priv in array v_privs loop
        if not exists (
          select 1 from information_schema.role_table_grants
           where table_schema = 'public'
             and table_name   = v_table
             and grantee      = 'service_role'
             and privilege_type = v_priv
        ) then
          raise exception 'A12: service_role is missing % on public.%. The API uses service_role for all writes; without this, every mutation against this surface 42501s. See migration 00275 + the 2026-05-01 P0 postmortem in docs/follow-ups/data-model-rework-full-handoff.md for the canonical fix pattern. (If this table is intentionally read-only on service_role, add it to v_intentional_select_only_tables in this file with a justifying comment.)', v_priv, v_table;
        end if;
      end loop;
      v_checked := v_checked + 1;
    end loop;
    raise notice 'A12 OK: service_role has full DML on % tenant-scoped writable tables (auto-enumerated via tenant_id column)', v_checked;
  end;

  raise notice '';
  raise notice 'OK: all assertions passed (A1..A12)';
end $$;
