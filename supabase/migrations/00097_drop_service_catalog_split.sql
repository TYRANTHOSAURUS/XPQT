-- 00097_drop_service_catalog_split.sql
-- Phase E / service-catalog collapse (2026-04-23). HARD CLEANUP.
-- Removes every artifact of the split service_items / request_types model.
-- Preflight verified zero app callers remain after phases C+D + the
-- tightening pass in commit 2521721.
--
-- Ordering matters:
--   1. Drop triggers (or their INSERT/UPDATE on request_types keeps firing).
--   2. Drop trigger functions + bridge/wrapper RPCs.
--   3. Drop the fulfillment_types view.
--   4. Drop FK-cascading satellite tables.
--   5. Drop the bridge and service_items roots.
--   6. Remove service_catalog:manage from seeded role permissions.
-- Everything runs inside one implicit transaction via the migration harness.
--
-- This migration is IRREVERSIBLE without a restore. Preflight, test locally,
-- and confirm remote backup before pushing.

-- ── 1. Triggers (stop the mirror chain first so drops below don't fire them) ──
drop trigger if exists trg_mirror_rtc_insert on public.request_type_categories;
drop trigger if exists trg_mirror_rtc_delete on public.request_type_categories;
drop trigger if exists trg_auto_pair_service_item on public.request_types;
drop trigger if exists trg_mirror_rt_update_to_si on public.request_types;
-- set_service_items_updated_at is attached to service_items itself — the
-- table drop in step 4 handles it automatically, but drop explicitly here so
-- the function (if still referenced) can also be dropped cleanly.
drop trigger if exists set_service_items_updated_at on public.service_items;

-- ── 2a. Legacy mirror / auto-pair functions ────────────────────────────────
drop function if exists public.mirror_request_type_category_insert();
drop function if exists public.mirror_request_type_category_delete();
drop function if exists public.auto_pair_service_item_for_request_type();
drop function if exists public.mirror_request_type_update_to_service_item();

-- ── 2b. Service-item-backed portal predicates (dead after phase C) ─────────
drop function if exists public.portal_requestable_trace(uuid, uuid, uuid, uuid, uuid, uuid);
drop function if exists public.portal_visible_service_item_ids(uuid, uuid, uuid);
drop function if exists public.service_item_offering_matches(uuid, uuid, uuid);
drop function if exists public.portal_onboardable_space_ids_v2(uuid, uuid);

-- ── 2c. Bridge-wrapper + legacy predicates (dead after phase C) ────────────
-- portal_visible_request_type_ids started as the native 00052 implementation,
-- was rewritten as a bridge wrapper in 00069, and is superseded by
-- request_type_visible_ids in 00092. Drop the name entirely — external
-- callers (if any) are now expected to use request_type_visible_ids.
drop function if exists public.portal_visible_request_type_ids(uuid, uuid, uuid);
-- portal_availability_trace: same story — 00052 native, 00069 wrapper, now
-- superseded by request_type_requestable_trace (00092).
drop function if exists public.portal_availability_trace(uuid, uuid, uuid, uuid);
-- portal_onboardable_locations: pre-v2 shipped in 00056, replaced by
-- request_type_onboardable_space_ids in 00092. Zero callers on main.
drop function if exists public.portal_onboardable_locations(uuid);

-- ── 3. The fulfillment_types read-only view (00065) ────────────────────────
drop view if exists public.fulfillment_types;

-- ── 4. Satellite tables (FK children of service_items + bridge) ───────────
drop table if exists public.service_item_on_behalf_rules;
drop table if exists public.service_item_form_variants;
drop table if exists public.service_item_criteria;
drop table if exists public.service_item_offerings;
drop table if exists public.service_item_categories;

-- ── 5. Bridge then service_items ──────────────────────────────────────────
drop table if exists public.request_type_service_item_bridge;
drop table if exists public.service_items;

-- ── 6. Permission cleanup ─────────────────────────────────────────────────
-- Remove service_catalog:manage from every role that still carries it. The
-- criteria_sets:manage permission stays — request_type_audience_rules,
-- request_type_form_variants, and request_type_on_behalf_rules still
-- reference public.criteria_sets.
update public.roles
set permissions = (
  select coalesce(jsonb_agg(elem), '[]'::jsonb)
  from jsonb_array_elements_text(permissions) elem
  where elem <> 'service_catalog:manage'
),
    updated_at = now()
where jsonb_typeof(permissions) = 'array'
  and permissions @> '["service_catalog:manage"]'::jsonb;

-- Also drop any tenant feature_flags key named service_catalog_read — the
-- flag-gated path was deleted in phase C and the key is now inert.
update public.tenants
set feature_flags = feature_flags - 'service_catalog_read'
where feature_flags ? 'service_catalog_read';

notify pgrst, 'reload schema';
