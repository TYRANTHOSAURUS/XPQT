-- Universal Workflow Architecture — Phase 0 commit 1: extend workflow
-- polymorphism to admit `entity_kind = 'booking'`.
--
-- Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.1
--       (lines 311-503) + §4 migration plan (lines 1043-1052).
--
-- Slot note: the spec table at §4 (line 1047) reserves slot 00367 for this
-- migration based on a 2026-05-12 confirmation that 00366 was the latest.
-- Two slot collisions discovered at execution time:
--   (1) B.4.Step2F shipped `00367_edit_booking_scope_rpc.sql` between spec
--       lock and execution, taking 00367.
--   (2) The spec preflight at step 2 (lines 363-378) refused to apply on
--       a fresh `pnpm db:reset` because 19 dev seeds in 00042/00045/00104
--       carry the column default `entity_type='ticket'` with zero
--       instances. A new prep migration
--       `00368_workflow_definitions_seed_entity_type_backfill.sql`
--       classifies those seeds as 'case' explicitly (no silent heuristic;
--       each row enumerated by id or exact name).
-- Net result: this polymorphism migration lands at slot 00369. Downstream
-- slots in §4 shift by +2 (00368→00370, 00369→00371, ...). Update §4 in a
-- follow-up commit.
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- §1.1 (lines 155-175) found `workflow_instances.entity_kind` already
-- carries `('case','work_order')` after the 1c.6/7/8 polymorphic split
-- (00228 added the columns; 00238 dropped the cascading FKs and re-added
-- them as `on delete set null`; 00239 dropped the `kind_matches_fk` CHECK
-- because it conflicted with FK SET NULL). Adding bookings as a third
-- polymorphic kind requires:
--
--   (1) Widening the value vocabulary on BOTH `workflow_definitions.entity_type`
--       and `workflow_instances.entity_kind`.
--   (2) Adding a `booking_id uuid` column with `on delete set null` (mirrors
--       the post-00239 contract for case_id/work_order_id at 00238:67-69).
--   (3) Allowing `ticket_id` to be NULL (00009:33 declared it NOT NULL —
--       booking-typed instances have no ticket so the constraint blocks
--       insert entirely).
--   (4) Splitting the active-uniqueness index from 00345 (which was
--       `(tenant_id, ticket_id) where status in ('active','waiting')`,
--       case-only) into three polymorphic partial indices — one per kind.
--   (5) A defensive BEFORE INSERT OR UPDATE trigger that asserts the
--       polymorphic one-of invariant on insert AND forbids both `entity_kind`
--       flips and cross-kind id swaps on update. This replaces the dropped
--       `kind_matches_fk` CHECK without re-introducing the 00239 bug
--       (CHECK + FK SET NULL = parent-delete blocked).
--
-- ── 00345 lesson preserved ────────────────────────────────────────────────
--
-- 00345 created `workflow_instances_active_unique_idx` to gate the
-- WorkflowStartHandler's `INSERT ... ON CONFLICT DO NOTHING`. That gate is
-- still required after this migration — it's just renamed and re-keyed per
-- entity_kind. Step 4 below preserves "one active workflow per (tenant,
-- entity)" by creating three partial indices that collectively cover the
-- same surface plus bookings.
--
-- ── Cleanup runbook (preflight failures) ──────────────────────────────────
--
-- The migration opens with TWO preflight `RAISE EXCEPTION` blocks. There is
-- no automated heuristic for either — both require operator decision (per
-- §4 line 1054: "the v1 'default to case for ambiguous rows' silent
-- heuristic was wrong — silent mis-mapping would put workflow definitions
-- on the wrong palette and break their existing instances").
--
-- (a) workflow_definitions backfill: ambiguous rows.
--
--     If a definition has run instances of multiple entity_kinds (e.g. some
--     case + some work_order rows pointing at the same definition_id), the
--     new CHECK can't pick one without throwing away the other. Operator
--     audits + decides per definition_id:
--
--       select wd.id, wd.name, wi.entity_kind, count(*) as n
--         from public.workflow_definitions wd
--         join public.workflow_instances wi on wi.workflow_definition_id = wd.id
--        where wi.entity_kind is not null
--        group by wd.id, wd.name, wi.entity_kind
--        order by wd.id;
--
--     For each ambiguous definition, the operator decides which `entity_type`
--     to set, then runs:
--
--       update public.workflow_definitions
--          set entity_type = '<chosen>'
--        where id = '<definition-id>'::uuid;
--
--     Re-run 00369 after every ambiguous definition is mapped.
--
-- (b) workflow_definitions backfill: zero-instance ticket-default rows.
--
--     Definitions with `entity_type = 'ticket'` (the 00009:8 default) and
--     zero instances can't be auto-derived from observed run kind. Operator
--     sets each explicitly:
--
--       select id, name from public.workflow_definitions
--        where entity_type = 'ticket'
--          and not exists (select 1 from public.workflow_instances wi
--                           where wi.workflow_definition_id = id);
--       update public.workflow_definitions
--          set entity_type = '<chosen>'
--        where id = '<definition-id>'::uuid;
--
--     Re-run 00369.
--
-- (c) workflow_instances active duplicate detection.
--
--     If multiple active rows exist for the same `(tenant_id, case_id)` /
--     `(tenant_id, work_order_id)` / `(tenant_id, booking_id)` triple under
--     the new partial indices, those indices fail to create. Same cleanup
--     contract as 00345's header runbook — operator audits per group and
--     cancels non-canonical rows. See 00345:24-75 for the audit template.

-- ── 1. Preflight: refuse to proceed if any workflow_definitions row is
--    ambiguous (instances span multiple entity_kinds). Spec §3.1 lines
--    340-357.
do $$
declare v_ambiguous int;
begin
  select count(*) into v_ambiguous from (
    select wd.id
      from public.workflow_definitions wd
      join public.workflow_instances wi on wi.workflow_definition_id = wd.id
     where wi.entity_kind is not null
     group by wd.id
    having count(distinct wi.entity_kind) > 1
  ) ambig;
  if v_ambiguous > 0 then
    raise exception
      'workflow_definitions backfill: % definition(s) have instances of multiple entity_kinds. Manually set workflow_definitions.entity_type for each before re-running 00369. See migration header (a).',
      v_ambiguous;
  end if;
end $$;

-- ── 2. Preflight: refuse if any `entity_type='ticket'` row has zero
--    instances to auto-derive from. Spec §3.1 lines 363-378.
do $$
declare v_unmapped int;
begin
  select count(*) into v_unmapped from public.workflow_definitions wd
    where wd.entity_type = 'ticket'
      and not exists (
        select 1 from public.workflow_instances wi
         where wi.workflow_definition_id = wd.id
           and wi.entity_kind is not null
      );
  if v_unmapped > 0 then
    raise exception
      'workflow_definitions backfill: % definition(s) with entity_type=''ticket'' have zero instances. Set entity_type explicitly before re-running 00369. See migration header (b).',
      v_unmapped;
  end if;
end $$;

-- ── 3. Widen workflow_definitions.entity_type vocabulary. Spec §3.1
--    lines 380-394 + §4 line 1054 ("no silent heuristic").
--
--    Plan-review remediation (Checkpoint 2 self-review): the v2.1 spec drafted
--    an auto-derive UPDATE here that set `entity_type` from the latest
--    observed instance's `entity_kind`. Plan-review flagged this as a silent
--    heuristic that contradicts §4's explicit "no silent mis-mapping" rule.
--    `entity_type` is IMMUTABLE per §0.1 — guessing at it from observed
--    instances bakes the guess permanently. Any 'ticket' row that survives
--    00368 + the two preflights above represents an ADMIN-AUTHORED definition
--    (not a dev seed) where the admin either deliberately chose 'ticket' or
--    inherited the column default — both cases require explicit operator
--    decision.
--
--    Phase 0 therefore adds a third preflight (below) that aborts if any
--    'ticket' row survives, then widens the CHECK. No auto-derive UPDATE.
--    The spec §3.1 drafted SQL is corrected by this migration.
--
--    00009:8 declared `entity_type text not null default 'ticket'` with NO
--    CHECK constraint, so dropping `if exists` is the safe baseline.
do $$
declare v_surviving int;
begin
  select count(*) into v_surviving from public.workflow_definitions
   where entity_type = 'ticket';
  if v_surviving > 0 then
    raise exception
      'workflow_definitions backfill: % definition(s) still at entity_type=''ticket'' after 00368 prep. Auto-derive is forbidden per §4 ''no silent heuristic''. Run: select id, name from workflow_definitions where entity_type=''ticket''; then update each explicitly before re-running 00369.',
      v_surviving;
  end if;
end $$;

alter table public.workflow_definitions
  drop constraint if exists workflow_definitions_entity_type_check;
alter table public.workflow_definitions
  add constraint workflow_definitions_entity_type_check
    check (entity_type in ('case', 'work_order', 'booking'));

-- ── 4. workflow_instances: drop ticket_id NOT NULL + add booking_id +
--    widen entity_kind CHECK. Spec §3.1 lines 396-418.
--
--    Why drop ticket_id NOT NULL: 00009:33 declared NOT NULL but bookings
--    have no ticket. Without this, no booking-typed row can ever insert.
--    The column stays as a nullable bridge so the auto-derive trigger
--    (00230:67-77) keeps working for case/work_order callers that only set
--    ticket_id.
--
--    Why ON DELETE SET NULL on booking_id: mirrors 00238:67-69 for
--    case_id and work_order_id. Cascade would orphan workflow audit rows
--    and the workflow_instance_links table created in 00370.
alter table public.workflow_instances
  alter column ticket_id drop not null;

alter table public.workflow_instances
  drop constraint if exists workflow_instances_entity_kind_check;
alter table public.workflow_instances
  add constraint workflow_instances_entity_kind_check
    check (entity_kind in ('case', 'work_order', 'booking'));

alter table public.workflow_instances
  add column if not exists booking_id uuid
    references public.bookings(id) on delete set null;

-- ── 5. Generalize the active-uniqueness index from 00345.
--    00345:103-105 indexed (tenant_id, ticket_id) WHERE status in
--    ('active','waiting') — case-only because ticket_id only ever held
--    case ids by the time 00345 shipped. Replace with three polymorphic
--    partial indices, one per entity_kind. The "one active workflow per
--    (tenant, entity)" invariant from 00345 is preserved per-kind.
--
--    Spec §3.1 lines 420-440 + §4 lines 1063-1068 (cutover preflight
--    requirement).
--
--    Cutover preflight: per §4 line 1064, run a duplicate-detection
--    preflight across the polymorphic surface BEFORE dropping the old
--    index. Any duplicates block creation of the new indices and require
--    the 00345 cleanup runbook (00345:24-75) before re-running 00369.

do $$
declare v_dupes int; v_null_kind int;
begin
  -- Plan-review remediation: before dropping the legacy 00345 index, refuse
  -- to proceed if any active row has `entity_kind IS NULL`. Such rows were
  -- protected by 00345's `(tenant_id, ticket_id)` partial unique index but
  -- are INVISIBLE to the new partial indices below (which require
  -- entity_kind = 'case'|'work_order'|'booking'). Dropping the old index
  -- without classifying these rows silently removes their uniqueness
  -- protection — duplicate active workflows could land per (tenant, ticket).
  select count(*) into v_null_kind
    from public.workflow_instances
   where status in ('active', 'waiting')
     and entity_kind is null;
  if v_null_kind > 0 then
    raise exception
      'workflow_instances active-NULL-entity_kind preflight: % active row(s) with entity_kind IS NULL. These were protected by the 00345 (tenant_id, ticket_id) index but won''t fit any of the new polymorphic partial indices. Classify each row''s entity_kind explicitly (case/work_order) before re-running 00369. Audit query: select id, ticket_id, status, started_at from workflow_instances where status in (''active'',''waiting'') and entity_kind is null;',
      v_null_kind;
  end if;

  select count(*) into v_dupes from (
    select tenant_id, case_id
      from public.workflow_instances
     where status in ('active', 'waiting')
       and entity_kind = 'case'
       and case_id is not null
     group by 1, 2
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'workflow_instances polymorphic-active-dupe preflight: % (tenant_id, case_id) groups have multiple active rows. Run the 00345 cleanup runbook (header lines 24-75) before re-running 00369.',
      v_dupes;
  end if;

  select count(*) into v_dupes from (
    select tenant_id, work_order_id
      from public.workflow_instances
     where status in ('active', 'waiting')
       and entity_kind = 'work_order'
       and work_order_id is not null
     group by 1, 2
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'workflow_instances polymorphic-active-dupe preflight: % (tenant_id, work_order_id) groups have multiple active rows. Run the 00345 cleanup runbook before re-running 00369.',
      v_dupes;
  end if;

  -- booking_id has no historical rows yet (column added in step 4 above)
  -- so this third probe is a forward-compatibility no-op on first run; it
  -- becomes meaningful on re-runs after Phase 1 ships.
  select count(*) into v_dupes from (
    select tenant_id, booking_id
      from public.workflow_instances
     where status in ('active', 'waiting')
       and entity_kind = 'booking'
       and booking_id is not null
     group by 1, 2
    having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise exception
      'workflow_instances polymorphic-active-dupe preflight: % (tenant_id, booking_id) groups have multiple active rows. Run the 00345 cleanup runbook before re-running 00369.',
      v_dupes;
  end if;
end $$;

drop index if exists public.workflow_instances_active_unique_idx;

create unique index if not exists workflow_instances_active_case_unique_idx
  on public.workflow_instances (tenant_id, case_id)
  where status in ('active', 'waiting')
    and entity_kind = 'case'
    and case_id is not null;

create unique index if not exists workflow_instances_active_work_order_unique_idx
  on public.workflow_instances (tenant_id, work_order_id)
  where status in ('active', 'waiting')
    and entity_kind = 'work_order'
    and work_order_id is not null;

create unique index if not exists workflow_instances_active_booking_unique_idx
  on public.workflow_instances (tenant_id, booking_id)
  where status in ('active', 'waiting')
    and entity_kind = 'booking'
    and booking_id is not null;

create index if not exists idx_wi_booking
  on public.workflow_instances (booking_id)
  where booking_id is not null;

-- ── 6. Polymorphism enforcement trigger. Spec §3.1 lines 442-484.
--
--    INSERT arm: assert one-of invariant — entity_kind matches exactly one
--    non-null polymorphic id and all others are null. Raises
--    `workflow_instance.polymorphism_violation` (registered in §3.12).
--
--    UPDATE arm: forbid entity_kind flips and forbid swapping any
--    polymorphic id to a different non-null value. Allows the FK SET NULL
--    transition (non-null → null on parent delete) per the 00239 contract.
--    Raises `workflow_instance.entity_kind_immutable_post_insert` and
--    `workflow_instance.polymorphic_id_smuggling` (both registered in §3.12).
--
--    NOT `security definer`: this is pure validation that runs in caller
--    context (project CLAUDE.md: "trigger functions as `security definer`
--    ONLY when they need to bypass RLS"). The trigger reads only NEW/OLD,
--    no cross-table lookups.
--
--    Trigger NAME ordering (plan-review remediation): the trigger is named
--    `workflow_instances_validate_polymorphism` (not `*_assert_polymorphism`).
--    PostgreSQL fires triggers of the same kind alphabetically by name.
--    `assert` < `derive`, so a `*_assert_polymorphism` would run BEFORE
--    `workflow_instances_derive_polymorphic_trg` (00230:69) and reject every
--    legacy INSERT that supplies only `ticket_id` (the derive trigger's
--    whole job is to populate `entity_kind` from `tickets.ticket_kind`).
--    `validate` > `derive` alphabetically, so this name guarantees the
--    derive trigger has already populated `entity_kind` by the time the
--    validation runs. Do NOT rename without re-verifying ordering.
create or replace function public.validate_workflow_instance_polymorphism()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT') then
    if not (
      (new.entity_kind = 'case'       and new.case_id is not null and new.work_order_id is null and new.booking_id is null) or
      (new.entity_kind = 'work_order' and new.work_order_id is not null and new.case_id is null and new.booking_id is null) or
      (new.entity_kind = 'booking'    and new.booking_id is not null and new.case_id is null and new.work_order_id is null)
    ) then
      raise exception 'workflow_instance.polymorphism_violation: entity_kind=% case_id=% work_order_id=% booking_id=%',
        new.entity_kind, new.case_id, new.work_order_id, new.booking_id;
    end if;
  end if;
  if (tg_op = 'UPDATE') then
    if new.entity_kind is distinct from old.entity_kind then
      raise exception 'workflow_instance.entity_kind_immutable_post_insert';
    end if;
    -- Permits the FK SET NULL transition (non-null → null on parent delete)
    -- per the 00239 contract; rejects non-null → other-non-null swaps and
    -- cross-kind id smuggling.
    if (old.case_id is not null and new.case_id is not null and new.case_id <> old.case_id) or
       (old.work_order_id is not null and new.work_order_id is not null and new.work_order_id <> old.work_order_id) or
       (old.booking_id is not null and new.booking_id is not null and new.booking_id <> old.booking_id) or
       (new.entity_kind = 'case'       and (new.work_order_id is distinct from old.work_order_id or new.booking_id    is distinct from old.booking_id)) or
       (new.entity_kind = 'work_order' and (new.case_id       is distinct from old.case_id       or new.booking_id    is distinct from old.booking_id)) or
       (new.entity_kind = 'booking'    and (new.case_id       is distinct from old.case_id       or new.work_order_id is distinct from old.work_order_id))
    then
      raise exception 'workflow_instance.polymorphic_id_smuggling';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists workflow_instances_assert_polymorphism on public.workflow_instances;
drop trigger if exists workflow_instances_validate_polymorphism on public.workflow_instances;
create trigger workflow_instances_validate_polymorphism
  before insert or update on public.workflow_instances
  for each row execute function public.validate_workflow_instance_polymorphism();

-- ── 7. Retire the 00240 partial assertion on workflow_instances.
--
--    `trg_workflow_instances_kind_consistency` (00240:70-74) calls
--    `assert_polymorphic_entity_kind_consistent` which knows ONLY about
--    case + work_order. It pre-empts the new trigger (alphabetical order:
--    `trg_...` < `workflow_instances_...`), raising messages that don't
--    match the spec §3.12 error codes (`workflow_instance.polymorphism_violation`,
--    `workflow_instance.entity_kind_immutable_post_insert`). It also has
--    blind spots the new trigger fills:
--      - No booking-kind awareness (would allow entity_kind=case with
--        booking_id set).
--      - Doesn't fire on UPDATE OF booking_id (column wasn't in the trigger
--        WHEN clause).
--      - No entity_kind-flip immutability check.
--    The new `workflow_instances_assert_polymorphism` is a strict superset,
--    so drop the 00240 trigger on workflow_instances. Keep the shared
--    function `assert_polymorphic_entity_kind_consistent` in place — it's
--    still used by sla_timers + routing_decisions (00240:58-68), which
--    Phase 0 doesn't extend to bookings.
drop trigger if exists trg_workflow_instances_kind_consistency on public.workflow_instances;

comment on function public.validate_workflow_instance_polymorphism() is
  'Spec 2026-05-12 §3.1 (lines 442-484). Validates the workflow_instances polymorphic one-of invariant on insert + forbids entity_kind flips and cross-kind id swaps on update. Permits FK SET NULL (non-null → null) per the post-00239 contract. Replaces the kind_matches_fk CHECK that was dropped in 00239 because it conflicted with `on delete set null`. Named `validate_*` (not `assert_*`) so the trigger fires AFTER `workflow_instances_derive_polymorphic_trg` (00230) — `derive` < `validate` alphabetically. Do not rename without re-verifying trigger ordering.';

comment on column public.workflow_instances.booking_id is
  'Spec 2026-05-12 §3.1 (lines 410-418). Booking-typed polymorphic FK. ON DELETE SET NULL mirrors 00238:67-69 for case_id/work_order_id; cascade would orphan workflow_instance_links audit rows.';

notify pgrst, 'reload schema';
