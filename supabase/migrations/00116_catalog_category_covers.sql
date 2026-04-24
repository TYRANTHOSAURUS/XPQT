-- 00116_catalog_category_covers.sql
-- Adds cover image + source toggle to catalog_categories. 'icon' is the default
-- visual mode (current behaviour); switching to 'image' requires cover_image_url.

alter table public.catalog_categories
  add column cover_image_url text,
  add column cover_source    text not null default 'icon'
    check (cover_source in ('image', 'icon'));

-- Invariant: if cover_source='image', cover_image_url must not be null.
alter table public.catalog_categories
  add constraint catalog_categories_cover_consistent
  check (cover_source <> 'image' or cover_image_url is not null);

comment on column public.catalog_categories.cover_source is
  'How the category is visualized on the portal: icon (default) or image (requires cover_image_url).';
