import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-panel';

interface FormSchema { id: string; display_name: string }
interface CriteriaSet { id: string; name: string }

export function CatalogFormTab({ detail }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const { data: schemas } = useApi<FormSchema[]>('/config-entities?type=form_schema', []);
  const { data: sets } = useApi<CriteriaSet[]>('/admin/criteria-sets', []);
  const schemasById = useMemo(() => new Map((schemas ?? []).map((s) => [s.id, s])), [schemas]);
  const setsById = useMemo(() => new Map((sets ?? []).map((s) => [s.id, s])), [sets]);

  const active = detail.form_variants.filter((v) => v.active);
  const defaultVariant = active.find((v) => v.criteria_set_id === null);
  const conditional = active
    .filter((v) => v.criteria_set_id !== null)
    .sort((a, b) => b.priority - a.priority);

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Conditional variants win over the default when audience criteria match.
      </p>

      <div className="overflow-auto rounded-md border">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-muted/40">
            <tr>
              <th className="border-b px-3 py-2 text-left font-medium w-40">Variant</th>
              <th className="border-b px-3 py-2 text-left font-medium">Form schema</th>
              <th className="border-b px-3 py-2 text-left font-medium">Audience</th>
              <th className="border-b px-3 py-2 text-left font-medium w-24">Priority</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row" className="border-b px-3 py-1.5 text-left font-normal">
                <Badge variant="outline" className="text-[10px]">Default</Badge>
              </th>
              <td className="border-b px-3 py-1.5">
                {defaultVariant
                  ? schemasById.get(defaultVariant.form_schema_id)?.display_name ?? 'Unknown schema'
                  : <span className="text-muted-foreground italic">None — standard fields only</span>}
              </td>
              <td className="border-b px-3 py-1.5 text-muted-foreground text-xs italic">fallback</td>
              <td className="border-b px-3 py-1.5 text-muted-foreground text-xs">—</td>
            </tr>
            {conditional.map((v) => (
              <tr key={v.id}>
                <th scope="row" className="border-b px-3 py-1.5 text-left font-normal">
                  <Badge variant="secondary" className="text-[10px]">Conditional</Badge>
                </th>
                <td className="border-b px-3 py-1.5">
                  {schemasById.get(v.form_schema_id)?.display_name ?? 'Unknown schema'}
                </td>
                <td className="border-b px-3 py-1.5">
                  {v.criteria_set_id
                    ? setsById.get(v.criteria_set_id)?.name ?? 'Unknown set'
                    : '—'}
                </td>
                <td className="border-b px-3 py-1.5 font-mono text-xs">{v.priority}</td>
              </tr>
            ))}
            {conditional.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-sm text-muted-foreground">
                  No conditional variants configured.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-muted-foreground">
        The default variant is written by the request-type dialog when its Linked Form Schema
        changes. Conditional variants require inline criteria authoring (coming soon).
      </p>
    </div>
  );
}
