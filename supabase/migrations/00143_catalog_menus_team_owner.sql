-- 00143_catalog_menus_team_owner.sql
-- Internal teams (canteen, AV team) own menus alongside external vendors.
-- vendor_id becomes nullable; XOR check enforces "exactly one owner".
-- The resolve_menu_offer function gets one branch added.
--
-- Why DROP FUNCTION first: the existing resolver returns 8 columns. The new
-- one returns 9 (adds fulfillment_team_id). CREATE OR REPLACE FUNCTION cannot
-- change the return-row shape, so we drop and recreate. No callers reference
-- columns by position; the TS RPC consumer reads by name and tolerates the
-- extra column.

alter table public.catalog_menus
  alter column vendor_id drop not null,
  add column fulfillment_team_id uuid references public.teams(id),
  add constraint catalog_menus_owner_xor
    check (num_nonnulls(vendor_id, fulfillment_team_id) = 1);

create index idx_menus_team on public.catalog_menus (fulfillment_team_id) where fulfillment_team_id is not null;

drop function if exists public.resolve_menu_offer(uuid, uuid, date);

create or replace function public.resolve_menu_offer(
  p_catalog_item_id uuid,
  p_delivery_space_id uuid,
  p_on_date date default current_date
)
returns table (
  menu_id uuid,
  menu_item_id uuid,
  vendor_id uuid,
  fulfillment_team_id uuid,
  owning_team_id uuid,
  price numeric,
  unit text,
  lead_time_hours integer,
  service_type text
)
language sql
stable
as $$
  with recursive ancestry as (
    select id, parent_id, 0 as depth from public.spaces where id = p_delivery_space_id
    union all
    select s.id, s.parent_id, a.depth + 1
    from public.spaces s
    join ancestry a on s.id = a.parent_id
    where a.depth < 10
  ),
  candidate_space as (
    select id from ancestry
  ),
  -- Vendor-owned menus: must have a vendor_service_areas entry covering the delivery space.
  vendor_offers as (
    select
      m.id            as menu_id,
      mi.id           as menu_item_id,
      v.id            as vendor_id,
      null::uuid      as fulfillment_team_id,
      v.owning_team_id,
      mi.price,
      mi.unit,
      mi.lead_time_hours,
      m.service_type,
      vsa.default_priority,
      (m.space_id is not null) as building_specific
    from public.menu_items mi
    join public.catalog_menus m on m.id = mi.menu_id
    join public.vendors v on v.id = m.vendor_id
    join public.vendor_service_areas vsa
      on vsa.vendor_id = v.id
     and vsa.service_type = m.service_type
     and vsa.active = true
     and vsa.space_id in (select id from candidate_space)
    where mi.catalog_item_id = p_catalog_item_id
      and mi.active = true
      and m.status = 'published'
      and v.active = true
      and m.effective_from <= p_on_date
      and (m.effective_until is null or m.effective_until >= p_on_date)
      and (m.space_id is null or m.space_id in (select id from candidate_space))
  ),
  -- Internal-team menus: skip vendor_service_areas; use catalog_menus.space_id alone.
  team_offers as (
    select
      m.id            as menu_id,
      mi.id           as menu_item_id,
      null::uuid      as vendor_id,
      m.fulfillment_team_id,
      m.fulfillment_team_id as owning_team_id,
      mi.price,
      mi.unit,
      mi.lead_time_hours,
      m.service_type,
      999::integer as default_priority,
      (m.space_id is not null) as building_specific
    from public.menu_items mi
    join public.catalog_menus m on m.id = mi.menu_id
    where m.fulfillment_team_id is not null
      and mi.catalog_item_id = p_catalog_item_id
      and mi.active = true
      and m.status = 'published'
      and m.effective_from <= p_on_date
      and (m.effective_until is null or m.effective_until >= p_on_date)
      and (m.space_id is null or m.space_id in (select id from candidate_space))
  )
  select menu_id, menu_item_id, vendor_id, fulfillment_team_id, owning_team_id,
         price, unit, lead_time_hours, service_type
  from (
    select * from vendor_offers
    union all
    select * from team_offers
  ) all_offers
  order by
    -- Building-specific menu beats catalog default
    building_specific desc,
    -- Vendor menu's own priority (team menus are 999 by definition)
    default_priority asc,
    price asc
  limit 1;
$$;

notify pgrst, 'reload schema';
