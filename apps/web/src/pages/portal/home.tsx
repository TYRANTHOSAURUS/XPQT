import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCatalogCategories } from '@/api/catalog';
import { usePortal } from '@/providers/portal-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalHomeHero } from '@/components/portal/portal-home-hero';
import { PortalCategoryCard } from '@/components/portal/portal-category-card';
import { PortalActivityPanel } from '@/components/portal/portal-activity-panel';
import { PortalAnnouncementCard } from '@/components/portal/portal-announcement-card';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

interface PortalCatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  request_types: Array<{ id: string }>;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon' | null;
  description: string | null;
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: PortalCatalogCategory[];
}

const portalCatalogOptions = (locationId: string | undefined) =>
  queryOptions({
    queryKey: ['portal', 'catalog', locationId],
    queryFn: ({ signal }) =>
      apiFetch<PortalCatalogResponse>(
        `/portal/catalog?location_id=${encodeURIComponent(locationId ?? '')}`,
        { signal },
      ),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });

export function PortalHome() {
  const { data: portal } = usePortal();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim().toLowerCase();

  const currentLocationId = portal?.current_location?.id;
  const { data: catalog } = useQuery(portalCatalogOptions(currentLocationId));
  const { data: dbCategories } = useCatalogCategories();

  const topLevel = useMemo(() => {
    if (!dbCategories || !catalog) return [];
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    return dbCategories
      .filter((c) => !c.parent_category_id && visibleIds.has(c.id))
      .filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [dbCategories, catalog, q]);

  return (
    <PortalPage bleed>
      <PortalHomeHero />
      <div className="px-4 md:px-6 lg:px-8 mt-8 md:mt-10">
        <div className="grid gap-8 md:gap-10 md:grid-cols-[1.8fr_1fr]">
          <section>
            <div className="mb-3 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
              Browse services
            </div>
            <div className="grid gap-3 grid-cols-2 md:grid-cols-3">
              {topLevel.map((c) => (
                <PortalCategoryCard
                  key={c.id}
                  id={c.id}
                  name={c.name}
                  description={c.description}
                  icon={c.icon}
                  cover_source={c.cover_source ?? 'icon'}
                  cover_image_url={c.cover_image_url ?? null}
                />
              ))}
            </div>
          </section>

          <section className="order-last md:order-none space-y-4">
            <div className="mb-3 text-xs uppercase tracking-widest text-muted-foreground font-semibold">
              Your activity
            </div>
            <PortalActivityPanel />
          </section>
        </div>

        <div className="mt-10 mb-10">
          <PortalAnnouncementCard />
        </div>
      </div>
    </PortalPage>
  );
}
