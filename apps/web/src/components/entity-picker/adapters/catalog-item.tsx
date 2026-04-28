import { apiFetch } from '@/lib/api';
import type { CatalogItem } from '@/api/catalog';
import type { EntityAdapter } from '../types';

const LIST_KEY = ['catalog-items', 'entity-picker'] as const;

/**
 * Catalog items have no server-side search endpoint today (`/catalog-items`
 * returns the full set). The picker filters client-side after the initial
 * fetch — fine for typical tenant catalogues (<500 items). When sets grow,
 * extend the API with a `?search=q` param and update searchQueryOptions
 * here; the adapter is the only call site.
 */
export const catalogItemEntityAdapter: EntityAdapter<CatalogItem> = {
  type: 'catalog_item',
  noun: 'catalog item',
  searchPlaceholder: 'Search catalog…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    return {
      queryKey: [...LIST_KEY, { q: trimmed, filter: filter ?? null }] as const,
      queryFn: async ({ signal }) => {
        const items = await apiFetch<CatalogItem[]>('/catalog-items', { signal });
        if (!trimmed) return items;
        // Substring match on name + category — sublabel matching is the
        // typical UX expectation for picker search.
        return items.filter(
          (i) =>
            i.name.toLowerCase().includes(trimmed) ||
            (i.category ?? '').toLowerCase().includes(trimmed) ||
            (i.subcategory ?? '').toLowerCase().includes(trimmed),
        );
      },
      staleTime: 60_000,
    };
  },

  detailQueryOptions(id) {
    return {
      queryKey: [...LIST_KEY, 'detail', id] as const,
      queryFn: async ({ signal }) => {
        const items = await apiFetch<CatalogItem[]>('/catalog-items', { signal });
        return items.find((i) => i.id === id) ?? null;
      },
      staleTime: 60_000,
      enabled: Boolean(id),
    };
  },

  renderListItem(item) {
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="truncate text-sm">{item.name}</span>
        <span className="truncate text-xs text-muted-foreground">
          {[item.category, item.subcategory].filter(Boolean).join(' · ')}
        </span>
      </div>
    );
  },

  renderSelected(item) {
    return <span className="truncate">{item.name}</span>;
  },

  itemLabel(item) {
    return item.name;
  },
};
