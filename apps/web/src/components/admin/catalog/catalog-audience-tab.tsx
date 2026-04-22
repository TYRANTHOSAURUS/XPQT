import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-panel';

interface CriteriaSet { id: string; name: string; description: string | null }

export function CatalogAudienceTab({ detail }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const { data: sets } = useApi<CriteriaSet[]>('/admin/criteria-sets', []);
  const setsById = useMemo(() => new Map((sets ?? []).map((s) => [s.id, s])), [sets]);

  const bucket = (mode: string) =>
    detail.criteria.filter((c) => c.mode === mode && c.active);

  const rows: Array<{ mode: string; label: string; items: typeof detail.criteria }> = [
    { mode: 'visible_allow', label: 'Visible to', items: bucket('visible_allow') },
    { mode: 'visible_deny', label: 'Hidden from', items: bucket('visible_deny') },
    { mode: 'request_allow', label: 'Can submit', items: bucket('request_allow') },
    { mode: 'request_deny', label: 'Cannot submit', items: bucket('request_deny') },
  ];
  const anyRules = rows.some((r) => r.items.length > 0);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Audience rules combine: deny short-circuits, allow defaults to "everyone" when unset.
        Requestability is always a subset of visibility.
      </p>

      {!anyRules && (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No audience rules configured — this service is visible to every authorized employee.
        </div>
      )}

      {anyRules && (
        <div className="overflow-auto rounded-md border">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="border-b px-3 py-2 text-left font-medium w-48">Rule</th>
                <th className="border-b px-3 py-2 text-left font-medium">Criteria sets</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.mode}>
                  <th scope="row" className="border-b px-3 py-1.5 text-left font-normal align-top">
                    <span className="flex items-center gap-2">
                      {row.label}
                      <Badge variant="outline" className="text-[10px]">{row.mode.split('_')[0]}</Badge>
                    </span>
                  </th>
                  <td className="border-b px-3 py-1.5">
                    {row.items.length === 0 ? (
                      <span className="text-xs text-muted-foreground italic">default: everyone</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {row.items.map((r) => (
                          <Badge key={r.id} variant="secondary">
                            {setsById.get(r.criteria_set_id)?.name ?? 'Unknown set'}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Inline criteria authoring is not yet available. Manage criteria sets at{' '}
        <span className="font-medium">Settings → Criteria sets</span> (coming soon).
      </p>
    </div>
  );
}
