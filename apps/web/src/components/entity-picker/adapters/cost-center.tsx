import { apiFetch } from '@/lib/api';
import type { CostCenter } from '@/api/cost-centers';
import type { EntityAdapter } from '../types';

const LIST_KEY = ['cost-centers', 'entity-picker'] as const;

export const costCenterEntityAdapter: EntityAdapter<CostCenter> = {
  type: 'cost_center',
  noun: 'cost center',
  searchPlaceholder: 'Search by code or name…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    const onlyActive = (filter?.active ?? true) === true;
    return {
      queryKey: [...LIST_KEY, { q: trimmed, active: onlyActive }] as const,
      queryFn: async ({ signal }) => {
        const params = new URLSearchParams();
        if (onlyActive) params.set('active', 'true');
        const qs = params.toString();
        const rows = await apiFetch<CostCenter[]>(
          `/admin/cost-centers${qs ? `?${qs}` : ''}`,
          { signal },
        );
        if (!trimmed) return rows;
        return rows.filter(
          (c) =>
            c.code.toLowerCase().includes(trimmed) ||
            c.name.toLowerCase().includes(trimmed),
        );
      },
      staleTime: 30_000,
    };
  },

  detailQueryOptions(id) {
    return {
      queryKey: [...LIST_KEY, 'detail', id] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch<CostCenter>(`/admin/cost-centers/${id}`, { signal }),
      staleTime: 30_000,
      enabled: Boolean(id),
    };
  },

  renderListItem(c) {
    return (
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="truncate text-sm">
          <code className="chip text-xs mr-1.5">{c.code}</code>
          {c.name}
        </span>
        {c.description ? (
          <span className="truncate text-xs text-muted-foreground">{c.description}</span>
        ) : null}
      </div>
    );
  },

  renderSelected(c) {
    return (
      <span className="flex items-center gap-1.5 min-w-0">
        <code className="chip text-xs">{c.code}</code>
        <span className="truncate">{c.name}</span>
      </span>
    );
  },

  itemLabel(c) {
    return `${c.code} ${c.name}`;
  },
};
