import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

/**
 * Portal-side catalog response shape — what `/portal/catalog?location_id=X`
 * returns. Different from the admin `/service-catalog/tree` because the
 * portal applies audience + location scoping per requester.
 */
/**
 * Per-request-type intake gates returned by the portal catalog. Shape matches
 * the backend's PortalCatalogService row.
 */
export interface PortalIntake {
  requires_location: boolean;
  location_required: boolean;
  location_granularity: string | null;
  requires_asset: boolean;
  asset_required: boolean;
  asset_type_filter: string[];
}

export interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  keywords: string[] | null;
  icon: string | null;
  kb_link: string | null;
  disruption_banner: string | null;
  on_behalf_policy: 'self_only' | 'any_person' | 'direct_reports' | 'configured_list';
  form_schema_id: string | null;
  intake: PortalIntake;
}

export interface CatalogCategory {
  id: string;
  name: string;
  description?: string | null;
  icon: string | null;
  display_order?: number;
  parent_category_id: string | null;
  request_types: CatalogRequestType[];
}

export interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: CatalogCategory[];
}

export const portalKeys = {
  all: ['portal'] as const,
  catalog: () => [...portalKeys.all, 'catalog'] as const,
  catalogFor: (locationId: string) => [...portalKeys.catalog(), locationId] as const,
} as const;

/**
 * Per-location portal catalog. Three pages need this — home, catalog-category,
 * submit-request — and they share the cache so navigating between them is
 * instant after the first fetch.
 *
 * Cache tier T3 (5min) — the catalog is admin-edited (request types,
 * audience rules, coverage), changes rarely during a portal session.
 * Per-location key means a user with multiple grants doesn't refetch when
 * they switch back to a location they've already viewed.
 */
export function portalCatalogOptions(locationId: string | null | undefined) {
  return queryOptions({
    queryKey: portalKeys.catalogFor(locationId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<PortalCatalogResponse>('/portal/catalog', {
        signal,
        query: { location_id: locationId ?? undefined },
      }),
    enabled: Boolean(locationId),
    staleTime: 5 * 60_000,
  });
}

export function usePortalCatalog(locationId: string | null | undefined) {
  return useQuery(portalCatalogOptions(locationId));
}
