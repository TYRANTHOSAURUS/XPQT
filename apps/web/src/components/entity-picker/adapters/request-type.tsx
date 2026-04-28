import { apiFetch } from '@/lib/api';
import {
  requestTypeKeys,
  type RequestTypeDetail,
  type RequestTypeListItem,
} from '@/api/request-types';
import { Badge } from '@/components/ui/badge';
import type { EntityAdapter } from '../types';

export const requestTypeEntityAdapter: EntityAdapter<RequestTypeListItem> = {
  type: 'request_type',
  noun: 'request type',
  searchPlaceholder: 'Search by name or domain…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    const domain = (filter?.domain as string | undefined) ?? null;
    return {
      // Cache the per-(domain) base list once. Substring search is a `select`.
      queryKey: [...requestTypeKeys.lists(), { domain }] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const params = new URLSearchParams();
        if (domain) params.set('domain', domain);
        const qs = params.toString();
        return apiFetch<RequestTypeListItem[]>(
          `/request-types${qs ? `?${qs}` : ''}`,
          { signal },
        );
      },
      staleTime: 60_000,
      select: (items: RequestTypeListItem[]) => {
        if (!trimmed) return items;
        return items.filter(
          (i) =>
            i.name.toLowerCase().includes(trimmed) ||
            (i.domain ?? '').toLowerCase().includes(trimmed),
        );
      },
    } as unknown as ReturnType<EntityAdapter<RequestTypeListItem>['searchQueryOptions']>;
  },

  detailQueryOptions(id) {
    return {
      queryKey: requestTypeKeys.detail(id),
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
