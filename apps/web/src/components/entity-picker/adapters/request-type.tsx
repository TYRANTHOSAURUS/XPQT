import { apiFetch } from '@/lib/api';
import {
  type RequestTypeDetail,
  type RequestTypeListItem,
} from '@/api/request-types';
import { Badge } from '@/components/ui/badge';
import type { EntityAdapter } from '../types';

const LIST_KEY = ['request-types', 'entity-picker'] as const;

export const requestTypeEntityAdapter: EntityAdapter<RequestTypeListItem> = {
  type: 'request_type',
  noun: 'request type',
  searchPlaceholder: 'Search by name or domain…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    const domain = (filter?.domain as string | undefined) ?? null;
    return {
      queryKey: [...LIST_KEY, { q: trimmed, domain }] as const,
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams();
        if (domain) params.set('domain', domain);
        const qs = params.toString();
        const items = await apiFetch<RequestTypeListItem[]>(
          `/request-types${qs ? `?${qs}` : ''}`,
          { signal },
        );
        if (!trimmed) return items;
        return items.filter(
          (i) =>
            i.name.toLowerCase().includes(trimmed) ||
            (i.domain ?? '').toLowerCase().includes(trimmed),
        );
      },
      staleTime: 60_000,
    };
  },

  detailQueryOptions(id) {
    return {
      queryKey: [...LIST_KEY, 'detail', id] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const detail = await apiFetch<RequestTypeDetail>(`/request-types/${id}`, { signal });
        return detail as RequestTypeListItem;
      },
      staleTime: 5 * 60_000,
      enabled: Boolean(id),
    };
  },

  renderListItem(rt) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate text-sm">{rt.name}</span>
        {rt.domain ? (
          <Badge variant="secondary" className="text-xs px-1.5 shrink-0">{rt.domain}</Badge>
        ) : null}
        {!rt.active ? (
          <Badge variant="outline" className="text-xs px-1.5 shrink-0">inactive</Badge>
        ) : null}
      </div>
    );
  },

  renderSelected(rt) {
    return <span className="truncate">{rt.name}</span>;
  },

  itemLabel(rt) {
    return rt.name;
  },
};
