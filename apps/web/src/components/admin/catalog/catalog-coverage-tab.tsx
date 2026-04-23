import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import type { ServiceItemDetail } from './catalog-service-panel';

/**
 * Coverage tab: lists every site/building in the tenant and lets the admin
 * toggle a per-space offering on/off. Tenant-wide toggle is one click.
 *
 * The full coverage matrix (effective handler + workflow + SLA + override
 * indicators per live-doc §8) is net-new work tracked as a dedicated slice.
 * This tab ships the offered-or-not column + inheritance indicator only.
 */

interface SiteRow {
  id: string;
  name: string;
  type: 'site' | 'building';
}

type Filter = 'all' | 'offered' | 'uncovered';

export function CatalogCoverageTab({ detail, onSaved }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [saving, setSaving] = useState<string | null>(null);
  const [localOfferings, setLocalOfferings] = useState(detail.offerings);
  useEffect(() => setLocalOfferings(detail.offerings), [detail.id, detail.offerings]);

  // Sites + buildings in this tenant. We use the existing spaces/admin list
  // (non-paginated today; if tenants grow past a few hundred sites this
  // becomes the first thing to paginate).
  const { data: sitesData, loading, error } = useApi<SiteRow[]>(
    `/spaces?types=site,building&active_only=true`,
    [detail.id],
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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(null);
    }
  };

  if (loading && !sitesData) {
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
        <AlertTitle>Coverage failed to load</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  const sites = sitesData ?? [];
  const visible = sites.filter((s) => {
    if (filter === 'offered') return hasTenantOffering || directOfferedIds.has(s.id);
    if (filter === 'uncovered') return !hasTenantOffering && !directOfferedIds.has(s.id);
    return true;
  });

  const offeredCount = sites.filter((s) => hasTenantOffering || directOfferedIds.has(s.id)).length;

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
          <span>{offeredCount} / {sites.length} offered</span>
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
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground w-32">Type</th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">Coverage</th>
              <th className="border-b px-3 py-2 text-right font-medium text-muted-foreground w-36">Action</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const isDirect = directOfferedIds.has(s.id);
              const tone = isDirect
                ? 'direct'
                : hasTenantOffering
                  ? 'inherited'
                  : 'uncovered';
              const label = isDirect
                ? 'direct · + descendants'
                : hasTenantOffering
                  ? 'tenant-wide'
                  : 'not offered';
              return (
                <tr key={s.id}>
                  <td className="border-b px-3 py-1.5">{s.name}</td>
                  <td className="border-b px-3 py-1.5 text-muted-foreground capitalize">{s.type}</td>
                  <td className="border-b px-3 py-1.5">
                    <span
                      className={
                        'inline-flex items-center gap-1 rounded px-1.5 py-0.5 ' +
                        (tone === 'direct'
                          ? 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200'
                          : tone === 'inherited'
                            ? 'bg-muted text-muted-foreground'
                            : 'bg-background text-muted-foreground border border-dashed')
                      }
                    >
                      {tone === 'inherited' && <span className="text-xs opacity-70">↑</span>}
                      {tone === 'uncovered' && <span className="text-xs opacity-70">—</span>}
                      <span>{label}</span>
                    </span>
                  </td>
                  <td className="border-b px-3 py-1.5 text-right">
                    {isDirect ? (
                      <Button size="sm" variant="ghost" disabled={!!saving} onClick={() => toggleSite(s.id)}>
                        Remove
                      </Button>
                    ) : hasTenantOffering ? (
                      <span className="text-xs text-muted-foreground italic">inherited</span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!!saving} onClick={() => toggleSite(s.id)}>
                        Offer here
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-sm text-muted-foreground">
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
          <span className="text-xs text-muted-foreground">
            {detail.scope_overrides.filter((o) => o.active).length} active
          </span>
        </div>
        {detail.scope_overrides.filter((o) => o.active).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No per-scope handler, workflow, SLA, or dispatch-policy overrides.
            The resolver falls through to the request type defaults and routing chain.
          </p>
        ) : (
          <ul className="space-y-1 text-xs text-muted-foreground">
            {detail.scope_overrides
              .filter((o) => o.active)
              .map((o) => (
                <li key={o.id} className="font-mono">
                  <span className="capitalize">{o.scope_kind.replace('_', ' ')}</span>
                  {o.space_id && <span> · space {o.space_id.slice(0, 8)}</span>}
                  {o.space_group_id && <span> · group {o.space_group_id.slice(0, 8)}</span>}
                  {o.handler_kind && (
                    <span> · handler={o.handler_kind}</span>
                  )}
                  {o.workflow_definition_id && <span> · workflow overridden</span>}
                  {o.case_sla_policy_id && <span> · case SLA overridden</span>}
                  {o.executor_sla_policy_id && <span> · executor SLA overridden</span>}
                </li>
              ))}
          </ul>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Live — the resolver consults these overrides at case creation (handler + workflow + case SLA)
          and at dispatch (executor SLA). <code className="font-mono">handler_kind=none</code> is an
          explicit unassign terminal. Authored via
          {' '}<code className="font-mono">PUT /request-types/:id/scope-overrides</code>; an inline editor
          is tracked as a separate slice.
        </p>
      </div>
    </div>
  );
}
