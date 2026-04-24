import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export interface CatalogItem {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  unit: string;
}

export interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  display_order: number;
  domain: string | null;
}

export interface CatalogCategoryNode {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  display_order: number;
  parent_category_id: string | null;
  children: CatalogCategoryNode[];
  request_types: CatalogRequestType[];
}

export const catalogKeys = {
  all: ['catalog'] as const,
  items: () => [...catalogKeys.all, 'items'] as const,
  itemsList: () => [...catalogKeys.items(), 'list'] as const,
  itemDetail: (id: string) => [...catalogKeys.items(), 'detail', id] as const,
  tree: () => [...catalogKeys.all, 'tree'] as const,
  categories: () => [...catalogKeys.all, 'categories'] as const,
  categoriesList: () => [...catalogKeys.categories(), 'list'] as const,
} as const;

export function catalogItemsListOptions() {
  return queryOptions({
    queryKey: catalogKeys.itemsList(),
    queryFn: ({ signal }) => apiFetch<CatalogItem[]>('/catalog-items', { signal }),
    staleTime: 5 * 60_000, // T3
  });
}

export function useCatalogItems() {
  return useQuery(catalogItemsListOptions());
}

export function catalogTreeOptions() {
  return queryOptions({
    queryKey: catalogKeys.tree(),
    queryFn: ({ signal }) => apiFetch<CatalogCategoryNode[]>('/service-catalog/tree', { signal }),
    staleTime: 5 * 60_000, // T3
  });
}

export function useCatalogTree() {
  return useQuery(catalogTreeOptions());
}

export interface UpsertCatalogItemPayload {
  name: string;
  category: string;
  subcategory?: string | null;
  unit: string;
}

export function useUpsertCatalogItem() {
  const qc = useQueryClient();
  return useMutation<CatalogItem, Error, { id: string | null; payload: UpsertCatalogItemPayload }>({
    mutationFn: ({ id, payload }) =>
      apiFetch<CatalogItem>(
        id ? `/catalog-items/${id}` : '/catalog-items',
        { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) },
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: catalogKeys.all }),
  });
}

export function useDeleteCatalogItem() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (id) => apiFetch(`/catalog-items/${id}`, { method: 'DELETE' }),
    onSettled: () => qc.invalidateQueries({ queryKey: catalogKeys.all }),
  });
}
