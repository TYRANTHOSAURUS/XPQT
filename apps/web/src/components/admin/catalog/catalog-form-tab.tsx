import { useMemo } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FormInput, FileText, Users2, ChevronRight, AlertCircle } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-sheet';

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
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-xl p-5 bg-gradient-to-br from-blue-500/10 via-background to-transparent ring-1 ring-blue-500/20">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center">
            <FormInput className="size-4" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold">Form variants</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Different audiences, different forms. Conditional variants win over the default when criteria match.
            </p>
          </div>
        </div>
      </div>

      {/* Default variant */}
      <div className="rounded-xl ring-1 ring-border bg-background">
        <div className="px-3.5 py-2.5 border-b bg-muted/30 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <FileText className="size-3.5" />
            Default form
          </div>
          <Badge variant="outline" className="text-[10px]">Fallback</Badge>
        </div>
        <div className="p-4">
          {defaultVariant ? (
            <div className="flex items-center gap-3">
              <div className="size-9 rounded-lg bg-blue-500/10 text-blue-600 flex items-center justify-center">
                <FormInput className="size-4" />
              </div>
              <div className="flex-1">
                <div className="font-medium text-sm">
                  {schemasById.get(defaultVariant.form_schema_id)?.display_name ?? 'Unknown schema'}
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Shown when no conditional variant matches
                </div>
              </div>
              <ChevronRight className="size-4 text-muted-foreground" />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground italic">
              No default form — the portal shows standard fields only.
            </div>
          )}
        </div>
      </div>

      {/* Conditional variants */}
      <div className="rounded-xl ring-1 ring-border bg-background">
        <div className="px-3.5 py-2.5 border-b bg-muted/30 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Users2 className="size-3.5" />
            Audience-specific variants
          </div>
          <span className="text-[10px] text-muted-foreground font-mono">
            {conditional.length > 0 ? `${conditional.length} configured` : 'none'}
          </span>
        </div>
        <div className="p-3">
          {conditional.length === 0 ? (
            <div className="text-sm text-muted-foreground text-center py-6">
              No conditional variants — every matching audience gets the default form.
            </div>
          ) : (
            <div className="space-y-2">
              {conditional.map((v) => (
                <div
                  key={v.id}
                  className="flex items-center gap-3 rounded-lg px-3 py-2 bg-gradient-to-r from-blue-500/5 via-background to-background ring-1 ring-blue-500/20"
                >
                  <Badge variant="outline" className="text-[10px] font-mono shrink-0">
                    p{v.priority}
                  </Badge>
                  <div className="flex-1 min-w-0 text-sm">
                    <div className="font-medium truncate">
                      {schemasById.get(v.form_schema_id)?.display_name ?? 'Unknown schema'}
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      For: {setsById.get(v.criteria_set_id!)?.name ?? 'Unknown audience'}
                    </div>
                  </div>
                  <ChevronRight className="size-4 text-muted-foreground" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl p-4 bg-gradient-to-r from-muted/20 to-transparent ring-1 ring-border">
        <div className="flex items-start gap-2">
          <AlertCircle className="size-4 mt-0.5 text-muted-foreground shrink-0" />
          <div className="flex-1 text-xs text-muted-foreground">
            Default variant syncs from Request Type's <span className="font-mono">form_schema_id</span>.
            Conditional variants require the criteria library (not yet inlined).
          </div>
          <Button variant="outline" size="sm" className="h-7 text-xs" disabled>
            Add variant →
          </Button>
        </div>
      </div>
    </div>
  );
}
