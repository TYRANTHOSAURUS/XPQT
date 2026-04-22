-- 00073_service_catalog_phase5_deprecations.sql
-- Phase 5 cleanup (conservative variant): keep columns populated via the
-- UPDATE/INSERT mirror triggers (00070 + 00071 + 00072); add deprecation
-- comments so callers know to migrate to service_items.
--
-- Promotion of fulfillment_types view → real table + hard FK from
-- service_items.fulfillment_type_id is intentionally deferred. Additive-first
-- invariant (docs/service-catalog-redesign.md §Phase 5 Rollback) says the
-- table→view flip is the one step with real risk; doing it without
-- confirmed zero-downtime paths from every dependent isn't safe in this pass.
-- Tracked for a follow-up migration once dependency inventory is complete.

comment on column public.request_types.name is
  'Legacy portal-facing name; mirrored to service_items.name via trg_mirror_rt_update_to_si. Authoring should move to /admin/service-items.';
comment on column public.request_types.description is
  'Legacy portal-facing description; mirrored to service_items.description.';
comment on column public.request_types.icon is
  'Legacy portal-facing icon; mirrored to service_items.icon.';
comment on column public.request_types.keywords is
  'Legacy portal-facing search terms; mirrored to service_items.search_terms.';
comment on column public.request_types.display_order is
  'Legacy portal-facing display order; mirrored to service_items.display_order.';
comment on column public.request_types.form_schema_id is
  'Legacy default form schema; mirrored to the default (criteria_set_id IS NULL) row in service_item_form_variants.';

comment on view public.fulfillment_types is
  'Read-only alias over request_types exposing internal operational columns. Promotion to a real table is deferred to a follow-up migration; code paths should continue to read from this alias. See docs/service-catalog-redesign.md §Phase 5.';

notify pgrst, 'reload schema';
