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

interface CoverageRow {
  site_id: string;
  site_name: string;
  site_type: string;
  offering: {
    id: string;
    scope_kind: 'tenant' | 'space' | 'space_group';
    inherit_to_descendants: boolean;
    starts_at: string | null;
    ends_at: string | null;
  } | null;
  reachable: boolean;
  reachable_via: 'location_team' | 'space_group' | 'rt_default' | null;
  handler_kind: 'team' | 'vendor' | null;
  handler_id: string | null;
  handler_name: string | null;
}

interface CoverageResponse {
  service_item_id: string;
  fulfillment_type_id: string;
  domain: string | null;
  domain_chain: string[];
  has_tenant_offering: boolean;
  sites: CoverageRow[];
}

type Filter = 'all' | 'offered' | 'uncovered' | 'unreachable';
type Tone = 'direct' | 'inherited' | 'group' | 'uncovered' | 'unreachable';

export function CatalogCoverageTab({ detail, onSaved }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [nonce, setNonce] = useState(0);
  const [saving, setSaving] = useState<string | null>(null);

  const { data, loading, error } = useApi<CoverageResponse>(
    `/admin/service-items/${detail.id}/coverage-matrix?_=${nonce}`,
    [detail.id, nonce],
  );

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => { reload(); }, [detail.offerings.length, reload]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.sites.filter((s) => {
      if (filter === 'offered') return !!s.offering;
      if (filter === 'uncovered') return !s.offering;
      if (filter === 'unreachable') return !!s.offering && !s.reachable;
      return true;
    });
  }, [data, filter]);

  const toggleSite = async (site: CoverageRow) => {
    if (saving) return;
    setSaving(site.site_id);
    try {
      const current = detail.offerings.filter((o) => o.active);
      const hasDirect = site.offering?.scope_kind === 'space' &&
        detail.offerings.some((o) => o.active && o.space_id === site.site_id);

      const next = hasDirect
        ? current
            .filter((o) => !(o.scope_kind === 'space' && o.space_id === site.site_id))
            .map(toDto)
        : [
            ...current.map(toDto),
            { scope_kind: 'space' as const, space_id: site.site_id, inherit_to_descendants: true, active: true },
          ];

      await apiFetch(`/admin/service-items/${detail.id}/offerings`, {
        method: 'PUT',
        body: JSON.stringify({ offerings: next }),
      });
      reload();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update');
    } finally {
      setSaving(null);
    }
  };

  const toggleTenant = async () => {
    setSaving('__tenant__');
    try {
      const current = detail.offerings.filter((o) => o.active);
      const next = data?.has_tenant_offering
        ? current.filter((o) => o.scope_kind !== 'tenant').map(toDto)
        : [...current.map(toDto), { scope_kind: 'tenant' as const, inherit_to_descendants: true, active: true }];
      await apiFetch(`/admin/service-items/${detail.id}/offerings`, {
        method: 'PUT',
        body: JSON.stringify({ offerings: next }),
      });
      reload();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(null);
    }
  };

  if (loading && !data) {
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

  if (!data || data.sites.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        No sites/buildings in this tenant yet.
      </div>
    );
  }

  const offeredCount = data.sites.filter((s) => s.offering).length;
  const unreachableCount = data.sites.filter((s) => s.offering && !s.reachable).length;

  return (
    <div className="flex flex-col gap-3">
      {/* Header + filter + tenant toggle */}
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
                <SelectItem value="unreachable">Offered, no handler</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {offeredCount} / {data.sites.length} offered
            {unreachableCount > 0 && ` · ${unreachableCount} unreachable`}
          </span>
          <Button
            size="sm"
            variant={data.has_tenant_offering ? 'default' : 'outline'}
            onClick={toggleTenant}
            disabled={!!saving}
          >
            {data.has_tenant_offering ? 'Remove tenant-wide' : 'Offer tenant-wide'}
          </Button>
        </div>
      </div>

      {/* Matrix */}
      <div className="overflow-auto rounded-md border">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r bg-background px-3 py-2 text-left font-medium">
                Site
              </th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground w-32">
                Type
              </th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">
                Coverage
              </th>
              <th className="border-b px-3 py-2 text-left font-medium text-muted-foreground">
                Handler
              </th>
              <th className="border-b px-3 py-2 text-right font-medium text-muted-foreground w-32">
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const tone = toneFor(s);
              const directOffered = s.offering?.scope_kind === 'space' &&
                detail.offerings.some((o) => o.active && o.space_id === s.site_id);
              return (
                <tr key={s.site_id}>
                  <th
                    scope="row"
                    className="sticky left-0 z-10 border-b border-r bg-background px-3 py-1.5 text-left font-normal"
                  >
                    {s.site_name}
                  </th>
                  <td className="border-b px-3 py-1.5 text-muted-foreground capitalize">{s.site_type}</td>
                  <td className="border-b px-3 py-1.5">
                    <CoverageCell row={s} tone={tone} />
                  </td>
                  <td className="border-b px-3 py-1.5 text-muted-foreground">
                    {s.reachable && s.handler_name ? (
                      <span>
                        {s.handler_name}
                        {s.reachable_via === 'rt_default' && (
                          <span className="ml-1 text-xs opacity-70">(default)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs">—</span>
                    )}
                  </td>
                  <td className="border-b px-3 py-1.5 text-right">
                    {directOffered ? (
                      <Button size="sm" variant="ghost" disabled={!!saving} onClick={() => toggleSite(s)}>
                        Remove
                      </Button>
                    ) : s.offering ? (
                      <span className="text-xs text-muted-foreground italic">inherited</span>
                    ) : (
                      <Button size="sm" variant="outline" disabled={!!saving} onClick={() => toggleSite(s)}>
                        Offer here
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-sm text-muted-foreground">
                  No sites match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Legend />
    </div>
  );
}

function toDto(o: ServiceItemDetail['offerings'][number]) {
  return {
    scope_kind: o.scope_kind,
    space_id: o.space_id ?? undefined,
    space_group_id: o.space_group_id ?? undefined,
    inherit_to_descendants: o.inherit_to_descendants,
    starts_at: o.starts_at ?? undefined,
    ends_at: o.ends_at ?? undefined,
    active: o.active,
  };
}

function toneFor(s: CoverageRow): Tone {
  if (!s.offering) return 'uncovered';
  if (s.offering.scope_kind === 'tenant') return 'inherited';
  if (s.offering.scope_kind === 'space_group') return 'group';
  if (!s.reachable) return 'unreachable';
  return 'direct';
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case 'direct': return 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200';
    case 'inherited': return 'bg-muted text-muted-foreground';
    case 'group': return 'bg-sky-500/10 text-sky-900 dark:text-sky-200 border border-dashed border-sky-500/40';
    case 'unreachable': return 'bg-amber-500/10 text-amber-900 dark:text-amber-200';
    case 'uncovered': return 'bg-background text-muted-foreground border border-dashed';
  }
}

function prefixFor(tone: Tone): string {
  switch (tone) {
    case 'direct': return '';
    case 'inherited': return '↑';
    case 'group': return '◇';
    case 'unreachable': return '⚠';
    case 'uncovered': return '—';
  }
}

function labelFor(s: CoverageRow, tone: Tone): string {
  if (tone === 'uncovered') return 'not offered';
  if (tone === 'unreachable') return 'offered · no handler';
  if (tone === 'inherited') return 'tenant-wide';
  if (tone === 'group') return 'via space group';
  if (s.offering?.inherit_to_descendants) return 'direct · + descendants';
  return 'direct';
}

function titleFor(tone: Tone): string {
  switch (tone) {
    case 'direct': return 'This site has a direct per-space offering.';
    case 'inherited': return 'Inherited from a tenant-wide offering.';
    case 'group': return 'Inherited from a space group offering.';
    case 'unreachable': return 'Offered, but no team/vendor is reachable for this fulfillment\'s domain here. Ticket would fall through to request-type default or unassigned.';
    case 'uncovered': return 'This service is not offered at this site.';
  }
}

function CoverageCell({ row, tone }: { row: CoverageRow; tone: Tone }) {
  const prefix = prefixFor(tone);
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${toneClass(tone)}`} title={titleFor(tone)}>
      {prefix && <span className="text-xs opacity-70">{prefix}</span>}
      <span>{labelFor(row, tone)}</span>
    </span>
  );
}

function Legend() {
  const items: Array<{ label: string; sample: string; tone: Tone }> = [
    { label: 'direct', tone: 'direct', sample: 'direct' },
    { label: 'inherited from tenant', tone: 'inherited', sample: 'tenant-wide' },
    { label: 'via space group', tone: 'group', sample: 'via space group' },
    { label: 'offered, no handler', tone: 'unreachable', sample: 'offered · no handler' },
    { label: 'not offered', tone: 'uncovered', sample: 'not offered' },
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${toneClass(i.tone)}`}>
            <span className="opacity-70">{prefixFor(i.tone)}</span>
            <span>{i.sample}</span>
          </span>
          <span>{i.label}</span>
        </div>
      ))}
    </div>
  );
}
