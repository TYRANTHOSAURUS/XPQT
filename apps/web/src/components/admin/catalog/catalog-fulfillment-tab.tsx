import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Settings2, Workflow, Clock, Users, Building2, ShieldCheck,
  ExternalLink, Sparkles, Wrench, FileText,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { ServiceItemDetail } from './catalog-service-sheet';

interface FulfillmentType {
  id: string;
  name: string;
  domain: string | null;
  fulfillment_strategy: string | null;
  requires_asset: boolean;
  asset_required: boolean;
  requires_location: boolean;
  location_required: boolean;
  location_granularity: string | null;
  requires_approval: boolean;
  default_team_id: string | null;
  default_vendor_id: string | null;
  sla_policy?: { id: string; name: string } | null;
  workflow?: { id: string; name: string } | null;
}

export function CatalogFulfillmentTab({
  detail, requestTypeId,
}: { detail: ServiceItemDetail; onSaved: () => void; requestTypeId: string }) {
  const navigate = useNavigate();
  const [ft, setFt] = useState<FulfillmentType | null>(null);

  useEffect(() => {
    apiFetch<FulfillmentType>(`/request-types/${detail.fulfillment_type_id}`)
      .then(setFt)
      .catch(() => setFt(null));
  }, [detail.fulfillment_type_id]);

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-xl p-5 bg-gradient-to-br from-slate-500/10 via-background to-transparent ring-1 ring-slate-500/20">
        <div className="flex items-start gap-3">
          <div className="size-9 rounded-lg bg-slate-500/10 text-slate-600 flex items-center justify-center">
            <Wrench className="size-4" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold">Internal fulfillment</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-md">
              Workflow, SLA, routing domain, intake requirements. Most admins never touch this — it's wired when the service is first created.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 h-7 text-xs"
            onClick={() => navigate(`/admin/request-types?edit=${requestTypeId}`)}
          >
            Advanced editor
            <ExternalLink className="size-3" />
          </Button>
        </div>
      </div>

      {ft && (
        <div className="grid grid-cols-2 gap-3">
          <DetailCard icon={<Settings2 className="size-3.5" />} label="Fulfillment name" value={ft.name} />
          <DetailCard
            icon={<Sparkles className="size-3.5" />}
            label="Domain"
            value={ft.domain ? <Badge variant="outline" className="capitalize">{ft.domain}</Badge> : <span className="text-muted-foreground italic">—</span>}
          />
          <DetailCard
            icon={<Workflow className="size-3.5" />}
            label="Workflow"
            value={ft.workflow?.name ?? <span className="text-muted-foreground italic">None</span>}
          />
          <DetailCard
            icon={<Clock className="size-3.5" />}
            label="SLA policy"
            value={ft.sla_policy?.name ?? <span className="text-muted-foreground italic">None</span>}
          />
        </div>
      )}

      {ft && (
        <div className="rounded-xl ring-1 ring-border bg-background">
          <div className="px-3.5 py-2.5 border-b bg-muted/30 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <FileText className="size-3.5" /> Intake requirements
          </div>
          <div className="p-3.5 grid grid-cols-2 gap-3 text-sm">
            <ChipRow
              label="Location"
              enabled={ft.requires_location}
              required={ft.location_required}
              extra={ft.location_granularity ? (
                <Badge variant="outline" className="text-[10px] capitalize ml-1">
                  {ft.location_granularity.replace('_', ' ')}
                </Badge>
              ) : null}
            />
            <ChipRow label="Asset" enabled={ft.requires_asset} required={ft.asset_required} />
            <ChipRow label="Approval" enabled={ft.requires_approval} required={ft.requires_approval} />
            <ChipRow label="Strategy" enabled customLabel={ft.fulfillment_strategy ?? 'fixed'} />
          </div>
        </div>
      )}

      {ft && (ft.default_team_id || ft.default_vendor_id) && (
        <div className="rounded-xl ring-1 ring-border bg-gradient-to-br from-emerald-500/5 via-background to-background">
          <div className="px-3.5 py-2.5 border-b flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <ShieldCheck className="size-3.5 text-emerald-600" />
            Default handler
          </div>
          <div className="p-3.5 text-sm flex items-center gap-2">
            {ft.default_team_id && (
              <Badge variant="outline" className="gap-1 bg-emerald-500/5 text-emerald-600 border-emerald-500/30">
                <Users className="size-3" />
                Team: {ft.default_team_id.slice(0, 8)}…
              </Badge>
            )}
            {ft.default_vendor_id && (
              <Badge variant="outline" className="gap-1 bg-emerald-500/5 text-emerald-600 border-emerald-500/30">
                <Building2 className="size-3" />
                Vendor: {ft.default_vendor_id.slice(0, 8)}…
              </Badge>
            )}
            <span className="text-[11px] text-muted-foreground">
              Used when location_teams doesn't resolve.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl p-3 bg-background ring-1 ring-border">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-sm">{value}</div>
    </div>
  );
}

function ChipRow({
  label, enabled, required, extra, customLabel,
}: {
  label: string;
  enabled: boolean;
  required?: boolean;
  extra?: React.ReactNode;
  customLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className={`size-5 rounded flex items-center justify-center text-[10px] font-bold ${
        enabled
          ? 'bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/20'
          : 'bg-muted/40 text-muted-foreground ring-1 ring-border'
      }`}>
        {enabled ? '✓' : '—'}
      </div>
      <span className="text-sm flex-1">{label}</span>
      {customLabel && <Badge variant="outline" className="text-[10px] capitalize">{customLabel}</Badge>}
      {required && !customLabel && <Badge variant="outline" className="text-[10px] border-amber-500/30 text-amber-600">required</Badge>}
      {extra}
    </div>
  );
}
