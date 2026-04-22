import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu';
import {
  Building2,
  Globe,
  MapPin,
  Search,
  Check,
  AlertTriangle,
  ChevronDown,
  Sparkles,
  Zap,
  Users,
  Layers,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import type { ServiceItemDetail } from './catalog-service-sheet';

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

type Filter = 'all' | 'offered' | 'not_offered' | 'unreachable';

export function CatalogCoverageTab({ detail, onSaved }: { detail: ServiceItemDetail; onSaved: () => void }) {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<CoverageResponse>(`/admin/service-items/${detail.id}/coverage-matrix`);
      setData(res);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load coverage');
    } finally {
      setLoading(false);
    }
  }, [detail.id]);

  useEffect(() => {
    reload();
  }, [reload]);

  const stats = useMemo(() => {
    if (!data) return { offered: 0, total: 0, unreachable: 0, tenant: false };
    const offered = data.sites.filter((s) => s.offering).length;
    const unreachable = data.sites.filter((s) => s.offering && !s.reachable).length;
    return { offered, total: data.sites.length, unreachable, tenant: data.has_tenant_offering };
  }, [data]);

  const coveragePct = stats.total > 0 ? Math.round((stats.offered / stats.total) * 100) : 0;

  const filteredSites = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    return data.sites.filter((s) => {
      if (q && !s.site_name.toLowerCase().includes(q)) return false;
      if (filter === 'offered' && !s.offering) return false;
      if (filter === 'not_offered' && s.offering) return false;
      if (filter === 'unreachable' && !(s.offering && !s.reachable)) return false;
      return true;
    });
  }, [data, filter, search]);

  const toggleSite = async (site: CoverageRow) => {
    if (saving) return;
    setSaving(site.site_id);
    try {
      const current = detail.offerings.filter((o) => o.active);
      let next;
      if (site.offering && site.offering.scope_kind === 'space') {
        // Remove this site's direct offering (keep inherited/tenant/group intact)
        next = current
          .filter((o) => !(o.scope_kind === 'space' && o.space_id === site.site_id))
          .map(toDto);
      } else {
        // Add a space-scope offering for this site
        next = [
          ...current.map(toDto),
          {
            scope_kind: 'space' as const,
            space_id: site.site_id,
            inherit_to_descendants: true,
            active: true,
          },
        ];
      }
      await apiFetch(`/admin/service-items/${detail.id}/offerings`, {
        method: 'PUT',
        body: JSON.stringify({ offerings: next }),
      });
      await reload();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to update coverage');
    } finally {
      setSaving(null);
    }
  };

  const toggleTenantWide = async () => {
    setSaving('__tenant__');
    try {
      const current = detail.offerings.filter((o) => o.active);
      let next;
      if (data?.has_tenant_offering) {
        next = current.filter((o) => o.scope_kind !== 'tenant').map(toDto);
      } else {
        next = [
          ...current.map(toDto),
          { scope_kind: 'tenant' as const, inherit_to_descendants: true, active: true },
        ];
      }
      await apiFetch(`/admin/service-items/${detail.id}/offerings`, {
        method: 'PUT',
        body: JSON.stringify({ offerings: next }),
      });
      await reload();
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-5">
      {/* Stat strip — gradient cards */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard
          icon={<Sparkles className="size-4" />}
          label="Coverage"
          value={`${coveragePct}%`}
          accent="primary"
          sub={`${stats.offered} of ${stats.total} sites`}
        />
        <StatCard
          icon={<Globe className="size-4" />}
          label="Tenant-wide"
          value={stats.tenant ? 'On' : 'Off'}
          accent={stats.tenant ? 'emerald' : 'muted'}
          sub={stats.tenant ? 'All locations' : 'Per-site only'}
        />
        <StatCard
          icon={<Zap className="size-4" />}
          label="Handler"
          value={data?.domain ?? '—'}
          accent="blue"
          sub={data?.domain_chain.length ? `${data.domain_chain.length}-step chain` : 'No domain'}
        />
        <StatCard
          icon={<AlertTriangle className="size-4" />}
          label="Unreachable"
          value={String(stats.unreachable)}
          accent={stats.unreachable > 0 ? 'amber' : 'muted'}
          sub={stats.unreachable > 0 ? 'Need handlers' : 'All routable'}
        />
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search sites…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9 bg-muted/30"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button variant="outline" size="sm" className="h-9 gap-1.5 min-w-[120px] justify-between">
                <span className="capitalize">{filter === 'all' ? 'All sites' : filter.replace('_', ' ')}</span>
                <ChevronDown className="size-3.5 opacity-60" />
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuLabel className="text-xs">Filter</DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => setFilter('all')}>All sites</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFilter('offered')}>Offered</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFilter('not_offered')}>Not offered</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setFilter('unreachable')}>No handler reachable</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          size="sm"
          variant={data?.has_tenant_offering ? 'default' : 'outline'}
          onClick={toggleTenantWide}
          disabled={!!saving}
          className="h-9 gap-1.5"
        >
          <Globe className="size-3.5" />
          {data?.has_tenant_offering ? 'Tenant-wide' : 'Offer tenant-wide'}
        </Button>
      </div>

      {/* Matrix body */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Spinner className="size-6 text-muted-foreground" />
        </div>
      )}

      {!loading && data && (
        <div className="space-y-1.5">
          {filteredSites.length === 0 && (
            <div className="text-center py-12 text-sm text-muted-foreground border border-dashed rounded-md">
              No sites match your filters.
            </div>
          )}
          {filteredSites.map((s) => (
            <CoverageRowCard
              key={s.site_id}
              row={s}
              tenantWide={stats.tenant}
              saving={saving === s.site_id}
              onToggle={() => toggleSite(s)}
            />
          ))}
        </div>
      )}
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

// ─────────────── pieces ───────────────

function StatCard({
  icon, label, value, accent, sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  accent: 'primary' | 'emerald' | 'amber' | 'blue' | 'muted';
  sub: string;
}) {
  const accentClasses: Record<string, string> = {
    primary: 'from-primary/10 via-primary/5 to-transparent ring-primary/20 text-primary',
    emerald: 'from-emerald-500/10 via-emerald-500/5 to-transparent ring-emerald-500/20 text-emerald-600',
    amber: 'from-amber-500/10 via-amber-500/5 to-transparent ring-amber-500/20 text-amber-600',
    blue: 'from-blue-500/10 via-blue-500/5 to-transparent ring-blue-500/20 text-blue-600',
    muted: 'from-muted/40 via-muted/20 to-transparent ring-border text-muted-foreground',
  };
  return (
    <div className={`
      relative overflow-hidden rounded-xl p-3.5 bg-gradient-to-br ring-1 transition-all
      ${accentClasses[accent]}
    `}>
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide opacity-80">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-2xl font-bold mt-1.5 text-foreground tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{sub}</div>
    </div>
  );
}

function CoverageRowCard({
  row, tenantWide, saving, onToggle,
}: {
  row: CoverageRow; tenantWide: boolean; saving: boolean; onToggle: () => void;
}) {
  const offered = !!row.offering;
  const inherited = row.offering?.scope_kind === 'tenant' || (row.offering?.scope_kind === 'space_group');
  const unreachable = offered && !row.reachable;

  return (
    <div className={`
      group relative flex items-center gap-3 rounded-xl px-3.5 py-2.5
      bg-gradient-to-r ring-1 transition-all
      ${offered
        ? unreachable
          ? 'from-amber-500/5 via-background to-background ring-amber-500/20'
          : 'from-emerald-500/5 via-background to-background ring-emerald-500/20 hover:ring-emerald-500/40'
        : 'from-muted/20 via-background to-background ring-border hover:ring-foreground/20'
      }
    `}>
      {/* State dot */}
      <div className={`
        relative shrink-0 size-8 rounded-lg flex items-center justify-center
        ${offered
          ? unreachable
            ? 'bg-amber-500/10 text-amber-600'
            : 'bg-emerald-500/10 text-emerald-600'
          : 'bg-muted/50 text-muted-foreground'
        }
      `}>
        {offered ? <Check className="size-4" /> : <Building2 className="size-4" />}
        {unreachable && (
          <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-amber-500 ring-2 ring-background" />
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{row.site_name}</span>
          <Badge variant="outline" className="text-[10px] capitalize shrink-0">
            {row.site_type}
          </Badge>
          {offered && inherited && (
            <Badge
              variant="outline"
              className="text-[10px] border-blue-500/30 bg-blue-500/5 text-blue-600 shrink-0"
              title={row.offering?.scope_kind === 'tenant' ? 'Inherited from tenant-wide offering' : 'Inherited from space group'}
            >
              <Layers className="size-2.5 mr-0.5" />
              {row.offering?.scope_kind === 'tenant' ? 'tenant' : 'group'}
            </Badge>
          )}
          {offered && row.offering?.scope_kind === 'space' && row.offering.inherit_to_descendants && (
            <Badge variant="outline" className="text-[10px] shrink-0" title="Applies to floors/rooms inside">
              + descendants
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
          {row.reachable && row.handler_name && (
            <span className="inline-flex items-center gap-1">
              {row.handler_kind === 'team' ? (
                <Users className="size-3 text-emerald-600" />
              ) : (
                <ShieldCheck className="size-3 text-emerald-600" />
              )}
              <span>{row.handler_name}</span>
              {row.reachable_via === 'rt_default' && (
                <span className="text-[10px] text-muted-foreground/70">(default)</span>
              )}
            </span>
          )}
          {unreachable && (
            <span className="inline-flex items-center gap-1 text-amber-600">
              <AlertTriangle className="size-3" />
              No handler reachable — ticket will route to unassigned
            </span>
          )}
          {!offered && !tenantWide && (
            <span className="text-muted-foreground/70">Not offered here</span>
          )}
        </div>
      </div>

      {/* Action */}
      <div className="shrink-0">
        {row.offering?.scope_kind === 'space' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={saving}
            onClick={onToggle}
            className="h-8 gap-1 text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Remove
          </Button>
        ) : inherited ? (
          <span className="text-[11px] text-muted-foreground italic px-2">Managed upstream</span>
        ) : (
          <Button
            size="sm"
            disabled={saving}
            onClick={onToggle}
            className="h-8 gap-1 bg-gradient-to-r from-primary to-primary/80 hover:from-primary hover:to-primary"
          >
            {saving ? <Spinner className="size-3" /> : <MapPin className="size-3.5" />}
            Offer here
          </Button>
        )}
      </div>
    </div>
  );
}
