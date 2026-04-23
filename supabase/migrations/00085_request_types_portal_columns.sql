-- 00085_request_types_portal_columns.sql
-- Phase A / service-catalog collapse (2026-04-23).
-- Move the last portal-facing columns from service_items back onto request_types
-- so a single entity can answer identity + consumer targeting + intake + fulfillment.
-- See docs/service-catalog-live.md §4.1 and docs/superpowers/plans/2026-04-23-service-catalog-collapse.md (Phase A).

alter table public.request_types
  add column if not exists kb_link text,
  add column if not exists disruption_banner text,
  add column if not exists on_behalf_policy text not null default 'self_only';

alter table public.request_types
  drop constraint if exists request_types_on_behalf_policy_check;

alter table public.request_types
  add constraint request_types_on_behalf_policy_check
  check (on_behalf_policy in ('self_only','any_person','direct_reports','configured_list'));

-- Backfill from paired service_items. Every request_type has exactly one bridge
-- row after migrations 00068 + 00070 (preflight verified 0 orphans on remote).
update public.request_types rt
set kb_link = si.kb_link,
    disruption_banner = si.disruption_banner,
    on_behalf_policy = coalesce(si.on_behalf_policy, rt.on_behalf_policy)
from public.service_items si
join public.request_type_service_item_bridge b on b.service_item_id = si.id
where b.request_type_id = rt.id;

-- 00073 attached deprecation comments saying "authoring should move to
-- /admin/service-items". That's now the wrong direction. Clear them.
comment on column public.request_types.name is null;
comment on column public.request_types.description is null;
comment on column public.request_types.icon is null;
comment on column public.request_types.keywords is null;
comment on column public.request_types.display_order is null;
comment on column public.request_types.form_schema_id is null;

create index if not exists idx_rt_on_behalf_policy
  on public.request_types (on_behalf_policy)
  where on_behalf_policy <> 'self_only';

notify pgrst, 'reload schema';
