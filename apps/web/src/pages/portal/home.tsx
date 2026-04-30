import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { SearchX } from 'lucide-react';
import { useCatalogCategories } from '@/api/catalog';
import { portalCatalogOptions } from '@/api/portal-catalog';
import { usePortal } from '@/providers/portal-provider';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalHomeHero } from '@/components/portal/portal-home-hero';
import { PortalCategoryCard } from '@/components/portal/portal-category-card';
import { PortalActivityPanel } from '@/components/portal/portal-activity-panel';
import { PortalAnnouncementCard } from '@/components/portal/portal-announcement-card';
import { PortalApprovalsLane } from '@/components/portal/portal-approvals-lane';
import { PortalCalendarSyncNudge } from '@/components/portal/portal-calendar-sync-nudge';

export function PortalHome() {
  const { data: portal } = usePortal();
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const qLower = q.toLowerCase();

  const currentLocationId = portal?.current_location?.id;
  const { data: catalog } = useQuery(portalCatalogOptions(currentLocationId));
  const { data: dbCategories } = useCatalogCategories();

  const topLevel = useMemo(() => {
    if (!dbCategories || !catalog) return [];
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    return dbCategories
      .filter((c) => !c.parent_category_id && visibleIds.has(c.id))
      .filter((c) => !qLower || c.name.toLowerCase().includes(qLower));
  }, [dbCategories, catalog, qLower]);

  const isFiltering = q.length > 0;
  const hasNoMatches = isFiltering && dbCategories && catalog && topLevel.length === 0;

  return (
    <PortalPage>
      {/* Page-level cascade: hero rises first (0ms), announcement at +120ms,
          the cards below at +200ms (with their own internal stagger). The
          aside on the right rises with the cards but slightly later so the
          eye reads left-then-right. */}
      <PortalHomeHero />
      <div className="mt-8 md:mt-10">
        {/* Announcement carries its own bottom margin + collapse-on-dismiss
            wrapper. When dismissed or absent it returns null and consumes
            no space — the grid below moves up cleanly. */}
        <PortalAnnouncementCard />
        {/* Calendar-sync nudge — only visible when the user has no
            connected Outlook calendar and hasn't dismissed. Same
            collapse-on-dismiss treatment as the announcement card. */}
        <PortalCalendarSyncNudge />
        <div className="grid gap-8 md:gap-10 md:grid-cols-[1.8fr_1fr]">
          <section>
            <h2
              className="mb-3 flex items-center justify-between gap-2 text-sm font-semibold tracking-tight text-foreground portal-rise"
              style={{ animationDelay: '160ms' }}
            >
              <span>Browse services</span>
              {isFiltering && (
                <Link
                  to="/portal"
                  className="text-xs font-normal text-muted-foreground transition-colors hover:text-foreground"
                >
                  Clear filter
                </Link>
              )}
            </h2>
            {isFiltering && !hasNoMatches && topLevel.length > 0 && (
              <p
                className="mb-3 text-xs text-muted-foreground portal-rise"
                style={{ animationDelay: '180ms' }}
                role="status"
                aria-live="polite"
              >
                Showing {topLevel.length} {topLevel.length === 1 ? 'category' : 'categories'} matching "{q}"
              </p>
            )}
            {hasNoMatches ? (
              <div
                className="portal-rise rounded-xl border border-border/70 bg-card px-6 py-12 flex flex-col items-center gap-3 text-center"
                style={{ animationDelay: '180ms' }}
                role="status"
                aria-live="polite"
              >
                <SearchX className="size-5 text-muted-foreground/60" aria-hidden />
                <div>
                  <p className="text-sm font-medium">No categories match "{q}".</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Try a different search or clear the filter.
                  </p>
                </div>
                <Link
                  to="/portal"
                  className="text-xs font-medium text-foreground underline-offset-2 hover:underline"
                >
                  Clear filter
                </Link>
              </div>
            ) : (
              <div
                className="portal-stagger grid gap-3 grid-cols-2 md:grid-cols-3"
                style={{ ['--portal-stagger-offset' as string]: '200ms' } as React.CSSProperties}
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
            )}
          </section>

          <section
            className="order-last md:order-none flex flex-col gap-4 portal-rise"
            style={{ animationDelay: '260ms' }}
          >
            {/* Approvals lane is the highest-priority "you have something
                to do" surface. Renders null when there's nothing pending,
                so non-approvers never see the slot. */}
            <PortalApprovalsLane />
            <PortalActivityPanel />
          </section>
        </div>
      </div>
    </PortalPage>
  );
}
