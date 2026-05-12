-- Universal Workflow Architecture — Phase 0 prep: classify pre-existing
-- seed `workflow_definitions` rows so the 00369 backfill preflight can
-- proceed.
--
-- Spec: docs/superpowers/specs/2026-05-12-universal-workflow-architecture-design.md §3.1
--       (lines 311-503) + §4 migration plan (lines 1043-1052).
--
-- Slot note: this is a NEW migration not anticipated by the spec table
-- (which lists 00367 polymorphism + 00368 links, both shifted by +1 due to
-- the B.4 edit_booking_scope_rpc taking 00367 between spec lock and
-- execution). It precedes the polymorphism migration (now 00369) so the
-- preflight gate at 00369 step 2 ("refuse if any entity_type='ticket' row
-- has zero instances") can pass on a fresh `pnpm db:reset`.
--
-- ── Why this can't be skipped or weakened ─────────────────────────────────
--
-- 00009:8 declared `workflow_definitions.entity_type text not null default
-- 'ticket'`. Pre-spec migrations seeded test fixtures (00042, 00045,
-- 00104) without specifying `entity_type` — so the seeds inherited
-- 'ticket' as the default-when-undefined value, NOT as a deliberate
-- classification.
--
-- The 00369 polymorphism migration's preflight (spec §3.1 lines 363-378)
-- refuses to proceed if any `entity_type='ticket'` row exists with zero
-- instances. This is intentional — the spec rejected the v1 "default to
-- case for ambiguous rows" silent heuristic because it would put
-- definitions on the wrong palette. But the spec didn't anticipate that
-- seeded dev fixtures inherit the column default.
--
-- The fix is NOT to weaken the preflight (the spec is right that silent
-- mis-mapping is dangerous in production). The fix is to classify each
-- seed row explicitly, by name, in a separate migration. That lifts the
-- preflight gate cleanly and preserves the contract: every classification
-- is a deliberate, named decision.
--
-- ── Why edit-the-original-seeds is the wrong fix ──────────────────────────
--
-- Past migrations are immutable per project convention (they've already
-- shipped to remote; the file hash is the contract). Editing 00042/00045/
-- 00104 to add `entity_type='case'` would diverge local from remote and
-- silently re-apply seed state on next `db:push`.
--
-- A separate forward-only migration is the right shape: idempotent (UPDATE
-- … WHERE entity_type='ticket' AND id IN (...)), reversible (set back to
-- 'ticket' if needed), auditable (the 'why' lives in this header), and
-- never touches a row whose admin already classified it.
--
-- ── Classification source ────────────────────────────────────────────────
--
-- Read the seed graph_definition for each id. The 15 rows from 00104
-- (`a5000000-0000-0000-0000-000000000001`..`a5000000-0000-0000-0000-00000000000f`)
-- are all case workflows — their nodes follow the case lifecycle pattern
-- (trigger → assign team → optional create_child_tasks (which spawns
-- work_orders FROM the case) → end). The `create_child_tasks` node TYPE
-- is the case-side "spawn work_order children" primitive (workflow engine
-- naming, not an entity_kind signal).
--
-- The 00042 seed is a per-tenant DO-block (00042:19) that stubs AT MOST
-- one row per tenant with name 'Incoming ticket (demo)' and dynamic uuid
-- (`gen_random_uuid()`). Can't enumerate by id — must catch by name in
-- the second UPDATE block below.
--
-- The 3 rows from 00045 (`de000000-0000-0000-0000-0000000000a{1,2,3}`)
-- are reclassify-test workflows; they're case flows by name + intent
-- (Hardware/Software/Facilities reclassify scenarios).
--
-- All 18 enumerated candidates + N dynamic 00042 rows (one per tenant)
-- classify as 'case'. Both UPDATE blocks below are gated by
-- `where entity_type = 'ticket'` so any human-classified rows pass
-- through unchanged.

update public.workflow_definitions
   set entity_type = 'case'
 where entity_type = 'ticket'
   and id in (
     -- 00104_seed_centralised_example_catalog.sql (15 rows)
     'a5000000-0000-0000-0000-000000000001',  -- TSS IT Standard Flow
     'a5000000-0000-0000-0000-000000000002',  -- TSS Hardware Replacement Flow
     'a5000000-0000-0000-0000-000000000003',  -- TSS Access Provisioning Flow
     'a5000000-0000-0000-0000-000000000004',  -- TSS Workplace Move Flow
     'a5000000-0000-0000-0000-000000000005',  -- TSS Cleaning Dispatch Flow
     'a5000000-0000-0000-0000-000000000006',  -- TSS Plumbing Dispatch Flow
     'a5000000-0000-0000-0000-000000000007',  -- TSS HVAC Dispatch Flow
     'a5000000-0000-0000-0000-000000000008',  -- TSS Electrical Dispatch Flow
     'a5000000-0000-0000-0000-000000000009',  -- TSS Elevator Dispatch Flow
     'a5000000-0000-0000-0000-00000000000a',  -- TSS Access Control Dispatch Flow
     'a5000000-0000-0000-0000-00000000000b',  -- TSS New Starter Flow
     'a5000000-0000-0000-0000-00000000000c',  -- TSS HR Standard Flow
     'a5000000-0000-0000-0000-00000000000d',  -- TSS Event Support Flow
     'a5000000-0000-0000-0000-00000000000e',  -- TSS Amsterdam Event Support Flow
     'a5000000-0000-0000-0000-00000000000f',  -- TSS AV Room Support Flow
     -- 00042 row is handled by the second UPDATE below (dynamic uuid).
     -- 00045_seed_reclassify_test_workflows.sql (3 rows)
     'de000000-0000-0000-0000-0000000000a1',
     'de000000-0000-0000-0000-0000000000a2',
     'de000000-0000-0000-0000-0000000000a3'
   );

-- 00042's seed uses dynamic UUIDs from a DO-block loop (one workflow per
-- tenant), so we can't enumerate by id. Classify by exact name + zero-
-- instance gate to avoid touching anything an admin already mapped.
update public.workflow_definitions wd
   set entity_type = 'case'
 where wd.entity_type = 'ticket'
   and wd.name = 'Incoming ticket (demo)'
   and not exists (
     select 1 from public.workflow_instances wi
      where wi.workflow_definition_id = wd.id
   );

-- ── Audit ──────────────────────────────────────────────────────────────
-- Fail loud at the cause (code-review remediation 2026-05-12): if the
-- catch-all UPDATE missed anything (a new seed row added between spec
-- lock and now), raise here so the operator sees the failure attributed
-- to 00368 (the actual cause) rather than seeing it surface downstream at
-- the 00369 preflight. 00369's preflight is the second line of defense,
-- but 00368 is the right migration to fail in.
do $$
declare v_remaining int;
begin
  select count(*) into v_remaining from public.workflow_definitions
   where entity_type = 'ticket';
  if v_remaining > 0 then
    raise exception
      '00368 left % workflow_definitions row(s) at entity_type=''ticket''. These rows aren''t covered by the enumerated id list or the dynamic name match — likely a new seed row added between spec lock and now. Audit + classify each explicitly: select id, name from workflow_definitions where entity_type=''ticket''; then update each row to its intended kind before re-running 00368.',
      v_remaining;
  end if;
end $$;

notify pgrst, 'reload schema';
