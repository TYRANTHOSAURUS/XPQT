-- 00068_backfill_service_catalog.sql
-- Phase-1 backfill: every active request_type becomes a paired service_item.
-- Visibility semantics preserved via per-space offerings that mirror what
-- portal_visible_request_type_ids returns today. No tenant-scope offerings
-- auto-created (would widen visibility). Default form variant seeded when
-- the RT has form_schema_id set.
-- Idempotent: skips rows already in request_type_service_item_bridge.
-- See docs/service-catalog-redesign.md Phase 1 §Migration strategy, steps 3+4.

-- ── 1. Paired service_items ─────────────────────────────────────────────
-- Key derived from RT name: lowercase, non-alphanumeric → '-', deduped.
insert into public.service_items (
  id, tenant_id, key, name, description, icon, search_terms,
  on_behalf_policy, fulfillment_type_id, display_order, active, created_at, updated_at
)
select
  gen_random_uuid() as id,
  rt.tenant_id,
  -- Deterministic key. Admins can rename in Phase 3 UI.
  lower(regexp_replace(
    regexp_replace(coalesce(rt.name, 'untitled'), '[^a-zA-Z0-9]+', '-', 'g'),
    '(^-+|-+$)', '', 'g'
  )) || '-' || substr(rt.id::text, 1, 8)  as key,
  rt.name,
  rt.description,
  rt.icon,
  coalesce(rt.keywords, '{}') as search_terms,
  'self_only'::text as on_behalf_policy,
  rt.id as fulfillment_type_id,
  coalesce(rt.display_order, 0),
  rt.active,
  rt.created_at,
  rt.updated_at
from public.request_types rt
where not exists (
  select 1 from public.request_type_service_item_bridge b where b.request_type_id = rt.id
);

-- ── 2. Bridge rows (RT id → paired service item id) ─────────────────────
insert into public.request_type_service_item_bridge (tenant_id, request_type_id, service_item_id)
select si.tenant_id, si.fulfillment_type_id, si.id
from public.service_items si
where not exists (
  select 1 from public.request_type_service_item_bridge b where b.request_type_id = si.fulfillment_type_id
);

-- ── 3. Categories (M2M mirror of request_type_categories) ───────────────
insert into public.service_item_categories (tenant_id, service_item_id, category_id, display_order)
select rtc.tenant_id, b.service_item_id, rtc.category_id, 0
from public.request_type_categories rtc
join public.request_type_service_item_bridge b on b.request_type_id = rtc.request_type_id
where not exists (
  select 1 from public.service_item_categories sic
  where sic.service_item_id = b.service_item_id and sic.category_id = rtc.category_id
);

-- ── 4. Offerings: per-space rows matching current visibility ────────────
-- For each active site/building in the tenant whose closure contains a space
-- of type = rt.location_granularity (via the existing
-- portal_request_type_has_eligible_descendant helper), insert a space-scope
-- offering. RTs with NULL granularity get offerings at every active site/building
-- (matches today's "any depth" behavior).
insert into public.service_item_offerings (
  tenant_id, service_item_id, scope_kind, space_id, space_group_id,
  inherit_to_descendants, active, created_at
)
select
  s.tenant_id,
  b.service_item_id,
  'space'::text,
  s.id as space_id,
  null::uuid,
  true,
  true,
  now()
from public.request_types rt
join public.request_type_service_item_bridge b on b.request_type_id = rt.id
join public.spaces s
  on s.tenant_id = rt.tenant_id
 and s.active = true
 and s.type in ('site','building')
where rt.active = true
  and public.portal_request_type_has_eligible_descendant(s.id, rt.location_granularity, rt.tenant_id)
  and not exists (
    select 1 from public.service_item_offerings o
    where o.service_item_id = b.service_item_id
      and o.scope_kind = 'space'
      and o.space_id = s.id
  );

-- ── 5. Default form variants (only when form_schema_id is set) ──────────
insert into public.service_item_form_variants (
  tenant_id, service_item_id, criteria_set_id, form_schema_id, priority, active, created_at
)
select
  rt.tenant_id,
  b.service_item_id,
  null::uuid as criteria_set_id,  -- default variant
  rt.form_schema_id,
  0,
  true,
  now()
from public.request_types rt
join public.request_type_service_item_bridge b on b.request_type_id = rt.id
where rt.form_schema_id is not null
  and not exists (
    select 1 from public.service_item_form_variants v
    where v.service_item_id = b.service_item_id
      and v.criteria_set_id is null
  );

notify pgrst, 'reload schema';
