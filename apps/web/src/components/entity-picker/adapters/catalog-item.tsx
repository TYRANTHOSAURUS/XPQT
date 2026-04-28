import { apiFetch } from '@/lib/api';
import { catalogKeys, type CatalogItem } from '@/api/catalog';
import type { EntityAdapter } from '../types';

/**
 * Catalog items have no server-side search endpoint today (`/catalog-items`
 * returns the full set). To keep the React Query cache effective the
 * picker fetches the full list ONCE per `filter` shape (no `q` in the key)
 * and applies the substring filter via `select`. This means each new
 * keystroke is a free synchronous filter rather than a refetch.
 *
 * Detail by id pulls from the same fetch — the items list is the only
 * source. Key prefix matches `catalogKeys.itemsList()` so mutations that
 * invalidate that list bust the picker's cache too.
 *
 * When the API grows a `?search=q` endpoint, swap to keying by `q`.
 */
export const catalogItemEntityAdapter: EntityAdapter<CatalogItem> = {
  type: 'catalog_item',
  noun: 'catalog item',
  searchPlaceholder: 'Search catalog…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    return {
      queryKey: [...catalogKeys.itemsList(), { filter: filter ?? null }] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<CatalogItem[]>('/catalog-items', { signal }),
      staleTime: 60_000,
      // Substring match on name + category. React Query memoizes `select`
      // so successive renders with the same trimmed query reuse the result.
      select: (items: CatalogItem[]) => {
        if (!trimmed) return items;
        return items.filter(
          (i) =>
            i.name.toLowerCase().includes(trimmed) ||
            (i.category ?? '').toLowerCase().includes(trimmed) ||
            (i.subcategory ?? '').toLowerCase().includes(trimmed),
        );
      },
    } as unknown as ReturnType<EntityAdapter<CatalogItem>['searchQueryOptions']>;
  },

  detailQueryOptions(id) {
    return {
      queryKey: catalogKeys.itemDetail(id),
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
