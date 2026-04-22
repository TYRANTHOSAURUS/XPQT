-- 00064_request_type_service_item_bridge.sql
-- 1:1 bridge so legacy request_type_id references keep resolving to the
-- paired (backfilled) service_item_id. Many service items per fulfillment
-- remains unambiguous because the bridge is unique on BOTH sides.
-- See docs/service-catalog-redesign.md §3.9

create table public.request_type_service_item_bridge (
  tenant_id uuid not null references public.tenants(id),
  request_type_id uuid not null references public.request_types(id) on delete cascade,
  service_item_id uuid not null references public.service_items(id) on delete cascade,
  primary key (request_type_id),
  unique (service_item_id)
);

alter table public.request_type_service_item_bridge enable row level security;
create policy "tenant_isolation" on public.request_type_service_item_bridge
  using (tenant_id = public.current_tenant_id());

create index idx_bridge_tenant on public.request_type_service_item_bridge (tenant_id);
