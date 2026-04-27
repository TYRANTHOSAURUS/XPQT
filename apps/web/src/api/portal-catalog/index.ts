import { queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface PortalCatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon?: string | null;
}

export interface PortalCatalogCategory {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  request_types: PortalCatalogRequestType[];
  cover_image_url?: string | null;
  cover_source?: 'image' | 'icon' | null;
  description?: string | null;
}

export interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: PortalCatalogCategory[];
}

/**
 * Single source of truth for portal catalog fetches. Same key shared by
 * the home page and the category detail page so navigating Home →
 * Category hits the cache and the cross-route view-transition feels
 * instant. Don't copy this factory — import it.
 */
export const portalCatalogOptions = (locationId: string | undefined) =>
  queryOptions({
    queryKey: ['portal', 'catalog', locationId] as const,
    queryFn: ({ signal }) =>
      apiFetch<PortalCatalogResponse>(
        `/portal/catalog?location_id=${encodeURIComponent(locationId ?? '')}`,
        { signal },
      ),
    enabled: Boolean(locationId),
    staleTime: 60_000,
  });
