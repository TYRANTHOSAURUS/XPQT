import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';
import { useApi } from '@/hooks/use-api';
import type { ServiceItemDetail } from './catalog-service-panel';

type FulfillmentStrategy = 'asset' | 'location' | 'fixed' | 'auto';
type OnBehalfPolicy = ServiceItemDetail['on_behalf_policy'];

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  fulfillment_strategy?: FulfillmentStrategy;
  location_granularity?: string | null;
  requires_location?: boolean;
  location_required?: boolean;
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[] | null;
  requires_approval?: boolean;
  approval_approver_team_id?: string | null;
  default_team_id?: string | null;
  default_vendor_id?: string | null;
  form_schema_id?: string | null;
  sla_policy_id?: string | null;
  workflow_definition_id?: string | null;
  sla_policy?: { id: string; name: string } | null;
  workflow?: { id: string; name: string } | null;
}

interface Team { id: string; name: string }
interface Vendor { id: string; name: string }
interface SlaPolicy { id: string; name: string }
interface Workflow { id: string; name: string }

const DOMAINS = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

const GRANULARITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '__any', label: 'Any (no drill-down required)' },
  { value: 'site', label: 'Site' },
  { value: 'building', label: 'Building' },
  { value: 'floor', label: 'Floor' },
  { value: 'room', label: 'Room' },
  { value: 'meeting_room', label: 'Meeting room' },
  { value: 'common_area', label: 'Common area' },
  { value: 'desk', label: 'Desk' },
  { value: 'parking_space', label: 'Parking space' },
];

const ON_BEHALF_OPTIONS: Array<{ value: OnBehalfPolicy; label: string; hint: string }> = [
  { value: 'self_only', label: 'Self only', hint: 'Only the requester themselves.' },
  { value: 'any_person', label: 'Any person', hint: 'Any person in the directory.' },
  { value: 'direct_reports', label: 'Direct reports', hint: 'Managers can submit for their reports.' },
  { value: 'configured_list', label: 'Configured (criteria)', hint: 'Actor/target rules defined in Audience tab.' },
];

type DefaultAssignee = 'none' | 'team' | 'vendor';

export function CatalogFulfillmentTab({
  detail,
  onSaved,
  requestTypeId,
  onDelete,
  deleting,
}: {
  detail: ServiceItemDetail;
  onSaved: () => void;
  requestTypeId: string;
  onDelete?: () => void;
  deleting?: boolean;
}) {
  const { data: rt, loading: rtLoading } = useApi<RequestType>(`/request-types/${requestTypeId}`, [requestTypeId]);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);
  const { data: slas } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: workflows } = useApi<Workflow[]>('/workflows', []);

  const [domain, setDomain] = useState<string>('general');
  const [strategy, setStrategy] = useState<FulfillmentStrategy>('fixed');
  const [locationGranularity, setLocationGranularity] = useState<string>('__any');
  const [requiresLocation, setRequiresLocation] = useState(false);
  const [locationRequired, setLocationRequired] = useState(false);
  const [requiresAsset, setRequiresAsset] = useState(false);
  const [assetRequired, setAssetRequired] = useState(false);
  const [assetTypeFilter, setAssetTypeFilter] = useState<string>('');
  const [workflowId, setWorkflowId] = useState<string>('');
  const [slaId, setSlaId] = useState<string>('');
  const [defaultKind, setDefaultKind] = useState<DefaultAssignee>('none');
  const [defaultId, setDefaultId] = useState<string>('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approverTeamId, setApproverTeamId] = useState<string>('');
  const [onBehalfPolicy, setOnBehalfPolicy] = useState<OnBehalfPolicy>('self_only');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!rt) return;
    setDomain(rt.domain ?? 'general');
    setStrategy(rt.fulfillment_strategy ?? 'fixed');
    setLocationGranularity(rt.location_granularity ?? '__any');
    setRequiresLocation(!!rt.requires_location);
    setLocationRequired(!!rt.location_required);
    setRequiresAsset(!!rt.requires_asset);
    setAssetRequired(!!rt.asset_required);
    setAssetTypeFilter((rt.asset_type_filter ?? []).join(', '));
    setWorkflowId(rt.workflow?.id ?? rt.workflow_definition_id ?? '');
    setSlaId(rt.sla_policy?.id ?? rt.sla_policy_id ?? '');
    if (rt.default_team_id) { setDefaultKind('team'); setDefaultId(rt.default_team_id); }
    else if (rt.default_vendor_id) { setDefaultKind('vendor'); setDefaultId(rt.default_vendor_id); }
    else { setDefaultKind('none'); setDefaultId(''); }
    setRequiresApproval(!!rt.requires_approval);
    setApproverTeamId(rt.approval_approver_team_id ?? '');
  }, [rt]);

  useEffect(() => {
    setOnBehalfPolicy(detail.on_behalf_policy);
  }, [detail.id, detail.on_behalf_policy]);

  const save = async () => {
    setSaving(true);
    try {
      const rtBody: Record<string, unknown> = {
        domain,
        fulfillment_strategy: strategy,
        location_granularity: locationGranularity === '__any' ? null : locationGranularity,
        requires_location: requiresLocation,
        location_required: requiresLocation && locationRequired,
        requires_asset: requiresAsset,
        asset_required: requiresAsset && assetRequired,
        asset_type_filter: requiresAsset
          ? assetTypeFilter.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
        workflow_definition_id: workflowId || null,
        sla_policy_id: slaId || null,
        default_team_id: defaultKind === 'team' ? defaultId || null : null,
        default_vendor_id: defaultKind === 'vendor' ? defaultId || null : null,
        requires_approval: requiresApproval,
        approval_approver_team_id: requiresApproval ? approverTeamId || null : null,
      };
      await apiFetch(`/request-types/${requestTypeId}`, {
        method: 'PATCH',
        body: JSON.stringify(rtBody),
      });
      if (onBehalfPolicy !== detail.on_behalf_policy) {
        await apiFetch(`/admin/service-items/${detail.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ on_behalf_policy: onBehalfPolicy }),
        });
      }
      toast.success('Fulfillment saved');
      onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (rtLoading && !rt) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  const defaultOptions = defaultKind === 'team' ? (teams ?? []) : defaultKind === 'vendor' ? (vendors ?? []) : [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Fulfillment drives routing, workflow, SLA, and approvals for tickets created from this service.
      </p>

      <FieldGroup>
        <FieldSet>
          <FieldLegend>Routing</FieldLegend>
          <FieldDescription>
            Domain + strategy pick the handler; per-location overrides live in the Coverage tab.
          </FieldDescription>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="ff-domain">Routing domain</FieldLabel>
              <Select value={domain} onValueChange={(v) => setDomain(v ?? 'general')}>
                <SelectTrigger id="ff-domain"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOMAINS.map((d) => (
                    <SelectItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Required for per-location handler assignment.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="ff-strategy">Strategy</FieldLabel>
              <Select value={strategy} onValueChange={(v) => setStrategy((v ?? 'fixed') as FulfillmentStrategy)}>
                <SelectTrigger id="ff-strategy"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Fixed team / vendor</SelectItem>
                  <SelectItem value="location">Location-based</SelectItem>
                  <SelectItem value="asset">Asset-based</SelectItem>
                  <SelectItem value="auto">Auto (asset → location)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="ff-default-kind">Default handler</FieldLabel>
            <div className="grid grid-cols-[160px_1fr] gap-2">
              <Select
                value={defaultKind}
                onValueChange={(v) => {
                  setDefaultKind((v ?? 'none') as DefaultAssignee);
                  setDefaultId('');
                }}
              >
                <SelectTrigger id="ff-default-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="team">Team</SelectItem>
                  <SelectItem value="vendor">Vendor</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={defaultId}
                onValueChange={(v) => setDefaultId(v ?? '')}
                disabled={defaultKind === 'none'}
              >
                <SelectTrigger>
                  <SelectValue placeholder={defaultKind === 'none' ? '—' : `Pick a ${defaultKind}…`} />
                </SelectTrigger>
                <SelectContent>
                  {defaultOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <FieldDescription>Used when the resolver finds no location or asset match.</FieldDescription>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Execution</FieldLegend>
          <FieldDescription>Workflow runs after routing; SLA timers start when work begins.</FieldDescription>
          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor="ff-workflow">Workflow</FieldLabel>
              <Select value={workflowId} onValueChange={(v) => setWorkflowId(v ?? '')}>
                <SelectTrigger id="ff-workflow"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {(workflows ?? []).map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="ff-sla">SLA policy</FieldLabel>
              <Select value={slaId} onValueChange={(v) => setSlaId(v ?? '')}>
                <SelectTrigger id="ff-sla"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">None</SelectItem>
                  {(slas ?? []).map((s) => (
                    <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Portal intake</FieldLegend>
          <FieldDescription>What pickers show in the portal form, and how strict they are.</FieldDescription>

          <div className="grid grid-cols-2 gap-3">
            <Field orientation="horizontal">
              <Checkbox
                id="ff-req-location"
                checked={requiresLocation}
                onCheckedChange={(v) => {
                  setRequiresLocation(!!v);
                  if (!v) setLocationRequired(false);
                }}
              />
              <FieldLabel htmlFor="ff-req-location" className="font-normal">Show location picker</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="ff-loc-required"
                checked={locationRequired}
                onCheckedChange={(v) => setLocationRequired(!!v)}
                disabled={!requiresLocation}
              />
              <FieldLabel htmlFor="ff-loc-required" className="font-normal">Location required</FieldLabel>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                id="ff-req-asset"
                checked={requiresAsset}
                onCheckedChange={(v) => {
                  setRequiresAsset(!!v);
                  if (!v) setAssetRequired(false);
                }}
              />
              <FieldLabel htmlFor="ff-req-asset" className="font-normal">Show asset picker</FieldLabel>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="ff-asset-required"
                checked={assetRequired}
                onCheckedChange={(v) => setAssetRequired(!!v)}
                disabled={!requiresAsset}
              />
              <FieldLabel htmlFor="ff-asset-required" className="font-normal">Asset required</FieldLabel>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="ff-granularity">Location granularity</FieldLabel>
            <Select value={locationGranularity} onValueChange={(v) => setLocationGranularity(v ?? '__any')}>
              <SelectTrigger id="ff-granularity"><SelectValue /></SelectTrigger>
              <SelectContent>
                {GRANULARITY_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Portal asks the employee to drill down to this depth before submitting.
            </FieldDescription>
          </Field>

          {requiresAsset && (
            <Field>
              <FieldLabel htmlFor="ff-asset-filter">Asset type filter</FieldLabel>
              <Input
                id="ff-asset-filter"
                value={assetTypeFilter}
                onChange={(e) => setAssetTypeFilter(e.target.value)}
                placeholder="Comma-separated asset type IDs (blank = any)"
              />
            </Field>
          )}
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>On-behalf-of policy</FieldLegend>
          <FieldDescription>Who may submit this request, and for whom.</FieldDescription>
          <Field>
            <FieldLabel htmlFor="ff-onbehalf">Policy</FieldLabel>
            <Select value={onBehalfPolicy} onValueChange={(v) => setOnBehalfPolicy((v ?? 'self_only') as OnBehalfPolicy)}>
              <SelectTrigger id="ff-onbehalf"><SelectValue /></SelectTrigger>
              <SelectContent>
                {ON_BEHALF_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {ON_BEHALF_OPTIONS.find((o) => o.value === onBehalfPolicy)?.hint}
            </FieldDescription>
          </Field>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>Approval</FieldLegend>
          <Field orientation="horizontal">
            <Checkbox
              id="ff-requires-approval"
              checked={requiresApproval}
              onCheckedChange={(v) => {
                setRequiresApproval(!!v);
                if (!v) setApproverTeamId('');
              }}
            />
            <FieldLabel htmlFor="ff-requires-approval" className="font-normal">
              Require approval before routing
            </FieldLabel>
          </Field>
          {requiresApproval && (
            <Field>
              <FieldLabel htmlFor="ff-approver">Approver team</FieldLabel>
              <Select value={approverTeamId} onValueChange={(v) => setApproverTeamId(v ?? '')}>
                <SelectTrigger id="ff-approver">
                  <SelectValue placeholder="Pick a team…" />
                </SelectTrigger>
                <SelectContent>
                  {(teams ?? []).map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        </FieldSet>
      </FieldGroup>

      <div className="flex items-center justify-between border-t pt-3">
        {onDelete && detail.active ? (
          <Button
            variant="outline"
            size="sm"
            className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
            onClick={onDelete}
            disabled={deleting}
          >
            <Trash2 className="h-4 w-4 mr-1.5" />
            {deleting ? 'Deleting…' : 'Delete service'}
          </Button>
        ) : <span />}
        <Button onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
