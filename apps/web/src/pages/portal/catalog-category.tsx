import { useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { usePortal } from '@/providers/portal-provider';
import { useCatalogCategories } from '@/api/catalog';
import { portalCatalogOptions } from '@/api/portal-catalog';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalCategoryBanner } from '@/components/portal/portal-category-banner';
import { PortalSubcategoryRail } from '@/components/portal/portal-subcategory-rail';
import { PortalServicesGrid } from '@/components/portal/portal-services-grid';

interface DbCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parent_category_id: string | null;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon' | null;
}

export function CatalogCategoryPage() {
  const { categoryId } = useParams();
  const { data: portal } = usePortal();
  const { data: dbCategories } = useCatalogCategories() as { data: DbCategory[] | undefined };

  const currentLocation = portal?.current_location ?? null;
  const { data: catalog, isPending: loading } = useQuery(portalCatalogOptions(currentLocation?.id));

  const { categoryRow, dbCategory, services, subcategories } = useMemo(() => {
    if (!catalog || !categoryId || !dbCategories) {
      return { categoryRow: null, dbCategory: null, services: [], subcategories: [] };
    }
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    const cat = catalog.categories.find((c) => c.id === categoryId) ?? null;
    const meta = dbCategories.find((c) => c.id === categoryId) ?? null;
    const subs = dbCategories
      .filter((c) => c.parent_category_id === categoryId && visibleIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        iconName: c.icon,
        count: catalog.categories.find((x) => x.id === c.id)?.request_types.length ?? 0,
      }));
    return {
      categoryRow: cat,
      dbCategory: meta,
      services: cat?.request_types ?? [],
      subcategories: subs,
    };
  }, [catalog, dbCategories, categoryId]);

  const parent = useMemo(() => {
    if (!dbCategory?.parent_category_id || !dbCategories) return null;
    return dbCategories.find((c) => c.id === dbCategory.parent_category_id) ?? null;
  }, [dbCategory, dbCategories]);

  const empty = !loading && subcategories.length === 0 && services.length === 0;

  return (
    <PortalPage bleed>
      <PortalCategoryBanner
        id={categoryId}
        name={dbCategory?.name ?? categoryRow?.name ?? 'Services'}
        description={dbCategory?.description}
        parentName={parent?.name}
        parentId={parent?.id}
        iconName={dbCategory?.icon}
        cover_source={dbCategory?.cover_source ?? 'icon'}
        cover_image_url={dbCategory?.cover_image_url ?? null}
      />

      <div className="px-4 md:px-6 lg:px-8 mt-8 md:mt-10 space-y-10">
        {loading && (
          <div className="space-y-10">
            {/* Subcategory rail skeleton */}
            <div className="space-y-3">
              <div className="portal-skeleton h-3 w-24 rounded" />
              <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="portal-skeleton h-12 rounded-lg" />
                ))}
              </div>
            </div>
            {/* Services skeleton */}
            <div className="space-y-3">
              <div className="portal-skeleton h-3 w-20 rounded" />
              <div className="grid gap-3 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="portal-skeleton h-20 rounded-xl" />
                ))}
              </div>
            </div>
          </div>
        )}

        {!loading && subcategories.length > 0 && <PortalSubcategoryRail items={subcategories} />}
        {!loading && services.length > 0 && (
          <PortalServicesGrid
            services={services.map((s) => ({ id: s.id, name: s.name, description: s.description, iconName: s.icon ?? null }))}
            categoryIdForOther={categoryId ?? null}
          />
        )}

        {empty && (
          <div className="portal-rise rounded-xl border border-border/70 bg-card px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No services available in this category at your selected location.
            </p>
          </div>
        )}
      </div>
    </PortalPage>
  );
}
