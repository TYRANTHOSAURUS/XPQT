import { apiFetch } from '@/lib/api';
import { costCenterKeys, type CostCenter } from '@/api/cost-centers';
import type { EntityAdapter } from '../types';

export const costCenterEntityAdapter: EntityAdapter<CostCenter> = {
  type: 'cost_center',
  noun: 'cost center',
  searchPlaceholder: 'Search by code or name…',

  searchQueryOptions(query, filter) {
    const trimmed = query.trim().toLowerCase();
    const onlyActive = (filter?.active ?? true) === true;
    return {
      queryKey: costCenterKeys.list({ active: onlyActive }),
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        const params = new URLSearchParams();
        if (onlyActive) params.set('active', 'true');
        const qs = params.toString();
        return apiFetch<CostCenter[]>(
          `/admin/cost-centers${qs ? `?${qs}` : ''}`,
          { signal },
        );
      },
      staleTime: 30_000,
      select: (rows: CostCenter[]) => {
        if (!trimmed) return rows;
        return rows.filter(
          (c) =>
            c.code.toLowerCase().includes(trimmed) ||
            c.name.toLowerCase().includes(trimmed),
        );
      },
    } as unknown as ReturnType<EntityAdapter<CostCenter>['searchQueryOptions']>;
  },

  detailQueryOptions(id) {
    return {
      queryKey: costCenterKeys.detail(id),
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
