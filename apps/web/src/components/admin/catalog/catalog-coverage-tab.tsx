import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, Plus, SlidersHorizontal, Info } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import type { ServiceItemDetail } from './catalog-service-panel';
import { ScopeOverrideEditor, type ScopeOverrideRow } from './scope-override-editor';
import { CoverageMatrixDrillDown } from './coverage-matrix-drill-down';

/**
 * Per-site coverage matrix. Columns: offered, handler, workflow, case SLA,
 * child dispatch, executor SLA — each with a source badge so the admin sees
 * whether an override wins, the request-type default applies, or the
 * resolver falls through to the routing chain.
 *
 * Backend: GET /request-types/:id/coverage-matrix composes the row with:
 *   override (request_type_effective_scope_override precedence walker) >
 *   request_types defaults > null (= routing-dependent for handler, or
 *   "team/vendor default" for child_dispatch / executor_sla). See live-doc §8.
 */

type SourceTag = 'override' | 'default' | 'override_unassigned' | 'none' | 'routing';

interface DimensionValue {
  id: string | null;
  name: string | null;
  source: SourceTag;
}

interface HandlerValue {
  kind: 'team' | 'vendor' | 'none' | null;
  id: string | null;
  name: string | null;
  source: SourceTag;
}

interface MatrixRow {
  site: { id: string; name: string; type: 'site' | 'building'; parent_id: string | null };
  offered: boolean;
  offering: { scope_kind: 'tenant' | 'space' | 'space_group'; rule_id: string } | null;
  override_id: string | null;
  override_scope_kind: 'tenant' | 'space' | 'space_group' | null;
  override_precedence: string | null;
  handler: HandlerValue;
  workflow: DimensionValue;
  case_sla: DimensionValue;
  child_dispatch: DimensionValue;
  executor_sla: DimensionValue;
}

interface MatrixResponse {
  request_type_id: string;
  defaults: {
    default_team_id: string | null;
    default_team_name: string | null;
    default_vendor_id: string | null;
    default_vendor_name: string | null;
    workflow_definition_id: string | null;
    workflow_definition_name: string | null;
    sla_policy_id: string | null;
    sla_policy_name: string | null;
  };
  rows: MatrixRow[];
}

type Filter = 'all' | 'offered' | 'uncovered';

function SourceBadge({ source, childLabelForNone }: {
  source: SourceTag;
  childLabelForNone?: string;
}) {
  const cfg: Record<SourceTag, { label: string; className: string }> = {
    override: {
      label: 'override',
      className: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30',
    },
    override_unassigned: {
      label: 'override · unassigned',
      className: 'bg-amber-500/15 text-amber-900 dark:text-amber-200 border-amber-500/30',
    },
    default: {
      label: 'default',
      className: 'bg-muted text-muted-foreground border-border',
    },
    routing: {
      label: 'routing',
      className: 'bg-background text-muted-foreground border-dashed',
    },
    none: {
      label: childLabelForNone ?? '—',
      className: 'bg-background text-muted-foreground border-dashed',
    },
  };
  const c = cfg[source];
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] border ${c.className}`}
    >
      {c.label}
    </span>
  );
}

function DimensionCell({
  v,
  noneLabel = 'not set',
  sourceNoneLabel,
}: {
  v: DimensionValue;
  noneLabel?: string;
  sourceNoneLabel?: string;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className={v.id ? '' : 'text-muted-foreground italic text-xs'}>
        {v.name ?? (v.id ? v.id.slice(0, 8) : noneLabel)}
      </span>
      <SourceBadge source={v.source} childLabelForNone={sourceNoneLabel} />
    </div>
  );
}

export function CatalogCoverageTab({ detail, onSaved }: {
  detail: ServiceItemDetail;
  onSaved: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('all');
  const [saving, setSaving] = useState<string | null>(null);
  const [localOfferings, setLocalOfferings] = useState(detail.offerings);
  useEffect(() => setLocalOfferings(detail.offerings), [detail.id, detail.offerings]);

  const [overrideEditorOpen, setOverrideEditorOpen] = useState(false);
  const [editingOverride, setEditingOverride] = useState<ScopeOverrideRow | null>(null);
  const [editorInitialDraft, setEditorInitialDraft] =
    useState<Partial<ScopeOverrideRow> | null>(null);

  const [drillDownOpen, setDrillDownOpen] = useState(false);
  const [drillRow, setDrillRow] = useState<MatrixRow | null>(null);
  const openDrillDown = (r: MatrixRow) => {
    setDrillRow(r);
    setDrillDownOpen(true);
  };

  const openNewOverride = () => {
    setEditingOverride(null);
    setEditorInitialDraft(null);
    setOverrideEditorOpen(true);
  };
  const openEditOverride = (id: string) => {
    const o = detail.scope_overrides.find((x) => x.id === id) ?? null;
    if (!o) return;
    setEditingOverride(o as ScopeOverrideRow);
    setEditorInitialDraft(null);
    setOverrideEditorOpen(true);
  };
  const openOverrideForSite = (siteId: string) => {
    setEditingOverride(null);
    setEditorInitialDraft({ scope_kind: 'space', space_id: siteId });
    setOverrideEditorOpen(true);
  };

  // Matrix — one call per request type per mount/reload.
  const { data: matrix, loading, error, refetch } = useApi<MatrixResponse>(
    `/request-types/${detail.id}/coverage-matrix`,
    [detail.id, detail.scope_overrides.length, localOfferings.length],
  );

  const hasTenantOffering = useMemo(
    () => localOfferings.some((o) => o.active && o.scope_kind === 'tenant'),
    [localOfferings],
  );
  const directOfferedIds = useMemo(
    () =>
      new Set(
        localOfferings
          .filter((o) => o.active && o.scope_kind === 'space' && o.space_id)
          .map((o) => o.space_id as string),
      ),
    [localOfferings],
  );

  const putCoverage = useCallback(
    async (next: ServiceItemDetail['offerings']) => {
      await apiFetch(`/request-types/${detail.id}/coverage`, {
        method: 'PUT',
        body: JSON.stringify({
          rules: next.filter((o) => o.active).map((o) => ({
            scope_kind: o.scope_kind,
            space_id: o.space_id ?? null,
            space_group_id: o.space_group_id ?? null,
            inherit_to_descendants: o.inherit_to_descendants,
            starts_at: o.starts_at ?? null,
            ends_at: o.ends_at ?? null,
            active: o.active,
          })),
        }),
      });
    },
    [detail.id],
  );

  const toggleSite = async (siteId: string) => {
    if (saving) return;
    setSaving(siteId);
    const next: ServiceItemDetail['offerings'] = directOfferedIds.has(siteId)
      ? localOfferings.filter((o) => !(o.scope_kind === 'space' && o.space_id === siteId))
      : [
          ...localOfferings,
          {
            id: `pending-${siteId}`,
            scope_kind: 'space',
            space_id: siteId,
            space_group_id: null,
            inherit_to_descendants: true,
            starts_at: null,
            ends_at: null,
            active: true,
          },
        ];
    try {
      await putCoverage(next);
      setLocalOfferings(next);
      onSaved();
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setSaving(null);
    }
  };

  const toggleTenant = async () => {
    setSaving('__tenant__');
    const next = hasTenantOffering
      ? localOfferings.filter((o) => o.scope_kind !== 'tenant')
      : [
          ...localOfferings,
          {
            id: 'pending-tenant',
            scope_kind: 'tenant' as const,
            space_id: null,
            space_group_id: null,
            inherit_to_descendants: true,
            starts_at: null,
            ends_at: null,
            active: true,
          },
        ];
    try {
      await putCoverage(next);
      setLocalOfferings(next);
      onSaved();
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(null);
    }
  };

  if (loading && !matrix) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Coverage matrix failed to load</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const rows = matrix?.rows ?? [];
  const visible = rows.filter((r) => {
    if (filter === 'offered') return r.offered;
    if (filter === 'uncovered') return !r.offered;
    return true;
  });
  const offeredCount = rows.filter((r) => r.offered).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-end gap-4">
        <FieldGroup className="flex flex-row gap-4">
          <Field className="w-44">
            <FieldLabel htmlFor="cov-filter">Show</FieldLabel>
            <Select value={filter} onValueChange={(v) => setFilter((v ?? 'all') as Filter)}>
              <SelectTrigger id="cov-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sites</SelectItem>
                <SelectItem value="offered">Offered</SelectItem>
                <SelectItem value="uncovered">Not offered</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Info className="h-3 w-3" />
            Click a row to explain
          </span>
          <span>· {offeredCount} / {rows.length} offered</span>
          <Button
            size="sm"
            variant={hasTenantOffering ? 'default' : 'outline'}
            onClick={toggleTenant}
            disabled={!!saving}
          >
            {hasTenantOffering ? 'Remove tenant-wide' : 'Offer tenant-wide'}
          </Button>
        </div>
      </div>

      <div className="overflow-auto rounded-md border">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th className="border-b px-3 py-2 text-left font-medium">Site</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground w-28">Offered</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Handler</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Workflow</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Case SLA</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Child dispatch</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Executor SLA</th>
              <th className="border-b px-3 py-2 text-right font-medium text-muted-foreground w-28">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => {
              const isDirect = directOfferedIds.has(r.site.id);
              const offeringLabel = r.offered
                ? (isDirect
                    ? 'direct · + descendants'
                    : r.offering?.scope_kind === 'tenant'
                      ? 'tenant-wide'
                      : r.offering?.scope_kind === 'space_group'
                        ? 'via group'
                        : 'inherited')
                : 'not offered';
              return (
                <tr
                  key={r.site.id}
                  className={`cursor-pointer hover:bg-muted/30 ${r.offered ? '' : 'opacity-60'}`}
                  onClick={() => openDrillDown(r)}
                >
                  <td className="border-b px-3 py-1.5 align-top">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{r.site.name}</span>
                      <span className="text-[10px] text-muted-foreground capitalize">{r.site.type}</span>
                    </div>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <Badge
                      variant="outline"
                      className={
                        r.offered
                          ? (isDirect
                              ? 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200 border-emerald-500/30'
                              : 'bg-muted')
                          : 'border-dashed text-muted-foreground'
                      }
                    >
                      {offeringLabel}
                    </Badge>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <div className="flex flex-col gap-0.5">
                      <span className={r.handler.id || r.handler.kind === 'none' ? '' : 'text-muted-foreground italic text-xs'}>
                        {r.handler.kind === 'none'
                          ? 'Unassigned'
                          : r.handler.name
                            ?? (r.handler.id ? r.handler.id.slice(0, 8) : 'routing chain')}
                      </span>
                      <SourceBadge source={r.handler.source} />
                    </div>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <DimensionCell v={r.workflow} />
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <DimensionCell v={r.case_sla} />
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <DimensionCell
                      v={r.child_dispatch}
                      sourceNoneLabel="team / vendor default"
                    />
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <DimensionCell
                      v={r.executor_sla}
                      sourceNoneLabel="team / vendor default"
                    />
                  </td>
                  <td
                    className="border-b px-3 py-1.5 text-right align-top"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-1">
                      {r.override_id ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => openEditOverride(r.override_id!)}
                          disabled={!!saving}
                        >
                          <SlidersHorizontal className="h-3 w-3 mr-1" />
                          Edit override
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          onClick={() => openOverrideForSite(r.site.id)}
                          disabled={!!saving}
                          title="Add per-site override"
                        >
                          <SlidersHorizontal className="h-3 w-3 mr-1" />
                          Override
                        </Button>
                      )}
                      {isDirect ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7"
                          disabled={!!saving}
                          onClick={() => toggleSite(r.site.id)}
                        >
                          Remove
                        </Button>
                      ) : r.offered ? (
                        // Coverage comes from tenant-wide, ancestor, or
                        // space-group rule. Adding a direct rule on top is
                        // always redundant — the service already offers here.
                        <span className="text-[10px] text-muted-foreground italic">inherited</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7"
                          disabled={!!saving}
                          onClick={() => toggleSite(r.site.id)}
                        >
                          Offer
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No sites match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="rounded-md border bg-muted/20 p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-medium text-muted-foreground">Scope overrides</span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {detail.scope_overrides.filter((o) => o.active).length} active · {detail.scope_overrides.length} total
            </span>
            <Button size="sm" variant="outline" className="h-7" onClick={openNewOverride}>
              <Plus className="h-3 w-3 mr-1" /> Add override
            </Button>
          </div>
        </div>
        {detail.scope_overrides.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No per-scope handler, workflow, SLA, or dispatch-policy overrides. The resolver falls
            through to the request type defaults and routing chain.
          </p>
        ) : (
          <ul className="space-y-1 text-xs">
            {detail.scope_overrides.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  className={
                    'w-full text-left rounded px-2 py-1.5 hover:bg-muted/50 font-mono text-xs ' +
                    (o.active ? '' : 'opacity-50')
                  }
                  onClick={() => openEditOverride(o.id)}
                >
                  <span className="capitalize">{o.scope_kind.replace('_', ' ')}</span>
                  {o.space_id && <span> · space {o.space_id.slice(0, 8)}</span>}
                  {o.space_group_id && <span> · group {o.space_group_id.slice(0, 8)}</span>}
                  {o.handler_kind && <span> · handler={o.handler_kind}</span>}
                  {o.workflow_definition_id && <span> · workflow</span>}
                  {o.case_sla_policy_id && <span> · case SLA</span>}
                  {o.executor_sla_policy_id && <span> · executor SLA</span>}
                  {!o.active && <span className="ml-2 text-muted-foreground italic">(inactive)</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Live — the resolver consults these overrides at case creation (handler + workflow + case SLA)
          and at dispatch (executor SLA). <code className="font-mono">handler_kind=none</code> is an
          explicit unassign terminal. Click a row to edit.
        </p>
      </div>

      <ScopeOverrideEditor
        requestTypeId={detail.id}
        open={overrideEditorOpen}
        onOpenChange={setOverrideEditorOpen}
        existingOverrides={detail.scope_overrides as ScopeOverrideRow[]}
        editing={editingOverride}
        initialDraft={editorInitialDraft}
        onSaved={() => { onSaved(); refetch(); }}
      />

      <CoverageMatrixDrillDown
        open={drillDownOpen}
        onOpenChange={setDrillDownOpen}
        row={drillRow}
        detail={detail}
        onEditOverride={openEditOverride}
        onAddOverride={openOverrideForSite}
        onToggleOffering={toggleSite}
        hasTenantOffering={hasTenantOffering}
        directOffered={drillRow ? directOfferedIds.has(drillRow.site.id) : false}
      />
    </div>
  );
}
