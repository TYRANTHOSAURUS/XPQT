import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useCatalogCategories } from '@/api/catalog';
import { portalCatalogOptions } from '@/api/portal-catalog';
import { usePortal } from '@/providers/portal-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalHomeHero } from '@/components/portal/portal-home-hero';
import { PortalCategoryCard } from '@/components/portal/portal-category-card';
import { PortalActivityPanel } from '@/components/portal/portal-activity-panel';
import { PortalAnnouncementCard } from '@/components/portal/portal-announcement-card';

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
    <PortalPage>
      {/* Page-level cascade: hero rises first (0ms), announcement at +120ms,
          the cards below at +240ms (with their own internal stagger). The
          aside on the right rises with the cards but slightly later so the
          eye reads left-then-right.
          The CSS variables on each section feed into .portal-rise's
          animation-delay or .portal-stagger's --portal-stagger-offset. */}
      <PortalHomeHero />
      <div className="mt-8 md:mt-10">
        {/* Announcement carries its own bottom margin + collapse-on-dismiss
            wrapper. When dismissed or absent it returns null and consumes
            no space — the grid below moves up cleanly. */}
        <PortalAnnouncementCard />
        <div className="grid gap-8 md:gap-10 md:grid-cols-[1.8fr_1fr]">
          <section>
            <h2
              className="mb-3 text-sm font-semibold tracking-tight text-foreground portal-rise"
              style={{ animationDelay: '200ms' }}
            >
              Browse services
            </h2>
            <div
              className="portal-stagger grid gap-3 grid-cols-2 md:grid-cols-3"
              style={{ ['--portal-stagger-offset' as string]: '240ms' } as React.CSSProperties}
            >
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

          <section
            className="order-last md:order-none portal-rise"
            style={{ animationDelay: '320ms' }}
          >
            <PortalActivityPanel />
          </section>
        </div>
      </div>
    </PortalPage>
  );
}
