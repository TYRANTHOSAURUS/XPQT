import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
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
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

type FulfillmentStrategy = 'asset' | 'location' | 'fixed' | 'auto';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
  form_schema_id?: string | null;
  fulfillment_strategy?: FulfillmentStrategy;
  requires_asset?: boolean;
  asset_required?: boolean;
  asset_type_filter?: string[];
  requires_location?: boolean;
  location_required?: boolean;
  default_team_id?: string | null;
  requires_approval?: boolean;
  approval_approver_team_id?: string | null;
}

interface SlaPolicy { id: string; name: string }
interface Category { id: string; name: string }
interface RoutingRule { id: string; name: string }
interface Team { id: string; name: string }
interface FormSchemaListItem { id: string; display_name: string }

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

interface RequestTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  defaultCategoryId?: string | null;
  onSaved: () => void;
}

export function RequestTypeDialog({
  open,
  onOpenChange,
  editingId,
  defaultCategoryId,
  onSaved,
}: RequestTypeDialogProps) {
  const { data: slas } = useApi<SlaPolicy[]>('/sla-policies', []);
  const { data: categories } = useApi<Category[]>('/service-catalog/categories', []);
  const { data: routingRules } = useApi<RoutingRule[]>('/routing-rules', []);
  const { data: formSchemas } = useApi<FormSchemaListItem[]>('/config-entities?type=form_schema', []);
  const { data: teams } = useApi<Team[]>('/teams', []);

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');
  const [slaPolicyId, setSlaPolicyId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [routingRuleId, setRoutingRuleId] = useState('');
  const [formSchemaId, setFormSchemaId] = useState('');
  const [fulfillmentStrategy, setFulfillmentStrategy] = useState<FulfillmentStrategy>('fixed');
  const [requiresAsset, setRequiresAsset] = useState(false);
  const [assetRequired, setAssetRequired] = useState(false);
  const [requiresLocation, setRequiresLocation] = useState(false);
  const [locationRequired, setLocationRequired] = useState(false);
  const [defaultTeamId, setDefaultTeamId] = useState('');
  const [assetTypeFilter, setAssetTypeFilter] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [approvalApproverTeamId, setApprovalApproverTeamId] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!editingId) {
      setName('');
      setDomain('general');
      setSlaPolicyId('');
      setCategoryId(defaultCategoryId ?? '');
      setRoutingRuleId('');
      setFormSchemaId('');
      setFulfillmentStrategy('fixed');
      setRequiresAsset(false);
      setAssetRequired(false);
      setRequiresLocation(false);
      setLocationRequired(false);
      setDefaultTeamId('');
      setAssetTypeFilter('');
      setRequiresApproval(false);
      setApprovalApproverTeamId('');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rt = await apiFetch<RequestType>(`/request-types/${editingId}`);
        if (cancelled) return;
        setName(rt.name);
        setDomain(rt.domain ?? 'general');
        setSlaPolicyId(rt.sla_policy?.id ?? '');
        setCategoryId(rt.catalog_category_id ?? '');
        setRoutingRuleId(rt.routing_rule_id ?? '');
        setFormSchemaId(rt.form_schema_id ?? '');
        setFulfillmentStrategy(rt.fulfillment_strategy ?? 'fixed');
        setRequiresAsset(!!rt.requires_asset);
        setAssetRequired(!!rt.asset_required);
        setRequiresLocation(!!rt.requires_location);
        setLocationRequired(!!rt.location_required);
        setDefaultTeamId(rt.default_team_id ?? '');
        setAssetTypeFilter((rt.asset_type_filter ?? []).join(', '));
        setRequiresApproval(!!rt.requires_approval);
        setApprovalApproverTeamId(rt.approval_approver_team_id ?? '');
      } catch (err) {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : 'Failed to load request type');
        onOpenChange(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, editingId, defaultCategoryId, onOpenChange]);

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      domain,
      sla_policy_id: slaPolicyId || undefined,
      catalog_category_id: categoryId || undefined,
      routing_rule_id: routingRuleId || undefined,
      form_schema_id: formSchemaId || undefined,
      fulfillment_strategy: fulfillmentStrategy,
      requires_asset: requiresAsset,
      asset_required: assetRequired,
      requires_location: requiresLocation,
      location_required: locationRequired,
      default_team_id: defaultTeamId || null,
      asset_type_filter: assetTypeFilter.split(',').map((s) => s.trim()).filter(Boolean),
      requires_approval: requiresApproval,
      approval_approver_team_id: requiresApproval ? (approvalApproverTeamId || null) : null,
    };
    setSaving(true);
    try {
      if (editingId) {
        await apiFetch(`/request-types/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Request type updated');
      } else {
        await apiFetch('/request-types', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Request type created');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save request type');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit' : 'Create'} Request Type</DialogTitle>
          <DialogDescription>Define the types of requests employees can submit.</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="rt-name">Name</FieldLabel>
            <Input
              id="rt-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. IT Incident, Cleaning Request..."
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="rt-domain">Domain</FieldLabel>
            <Select value={domain} onValueChange={(v) => setDomain(v ?? 'general')}>
              <SelectTrigger id="rt-domain"><SelectValue /></SelectTrigger>
              <SelectContent>
                {domains.map((d) => (
                  <SelectItem key={d} value={d}>{d.charAt(0).toUpperCase() + d.slice(1)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="rt-category">Service Catalog Category</FieldLabel>
            <Select value={categoryId} onValueChange={(v) => setCategoryId(v ?? '')}>
              <SelectTrigger id="rt-category"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {(categories ?? []).map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="rt-form-schema">Linked Form Schema</FieldLabel>
            <Select value={formSchemaId} onValueChange={(v) => setFormSchemaId(v ?? '')}>
              <SelectTrigger id="rt-form-schema"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None (only standard fields)</SelectItem>
                {(formSchemas ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="rt-sla">Linked SLA Policy</FieldLabel>
            <Select value={slaPolicyId} onValueChange={(v) => setSlaPolicyId(v ?? '')}>
              <SelectTrigger id="rt-sla"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {(slas ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="rt-routing-rule">Linked Routing Rule (override)</FieldLabel>
            <Select value={routingRuleId} onValueChange={(v) => setRoutingRuleId(v ?? '')}>
              <SelectTrigger id="rt-routing-rule"><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="">None</SelectItem>
                {(routingRules ?? []).map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Fulfillment</FieldLegend>
            <FieldDescription>How tickets of this type get routed to a team.</FieldDescription>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="rt-strategy">Strategy</FieldLabel>
                <Select
                  value={fulfillmentStrategy}
                  onValueChange={(v) => setFulfillmentStrategy((v ?? 'fixed') as FulfillmentStrategy)}
                >
                  <SelectTrigger id="rt-strategy"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fixed">Fixed team (no context needed)</SelectItem>
                    <SelectItem value="asset">Asset-based (e.g. elevator, printer)</SelectItem>
                    <SelectItem value="location">Location-based (e.g. cleaning)</SelectItem>
                    <SelectItem value="auto">Auto — try asset then location</SelectItem>
                  </SelectContent>
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field orientation="horizontal">
                  <Checkbox
                    id="rt-requires-asset"
                    checked={requiresAsset}
                    onCheckedChange={(v) => {
                      setRequiresAsset(!!v);
                      if (!v) setAssetRequired(false);
                    }}
                  />
                  <FieldLabel htmlFor="rt-requires-asset" className="font-normal">
                    Show asset picker
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="rt-asset-required"
                    checked={assetRequired}
                    onCheckedChange={(v) => setAssetRequired(!!v)}
                    disabled={!requiresAsset}
                  />
                  <FieldLabel htmlFor="rt-asset-required" className="font-normal">
                    Asset required
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="rt-requires-location"
                    checked={requiresLocation}
                    onCheckedChange={(v) => {
                      setRequiresLocation(!!v);
                      if (!v) setLocationRequired(false);
                    }}
                  />
                  <FieldLabel htmlFor="rt-requires-location" className="font-normal">
                    Show location picker
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="rt-location-required"
                    checked={locationRequired}
                    onCheckedChange={(v) => setLocationRequired(!!v)}
                    disabled={!requiresLocation}
                  />
                  <FieldLabel htmlFor="rt-location-required" className="font-normal">
                    Location required
                  </FieldLabel>
                </Field>
              </div>

              {requiresAsset && (
                <Field>
                  <FieldLabel htmlFor="rt-asset-filter">Asset type filter</FieldLabel>
                  <Input
                    id="rt-asset-filter"
                    value={assetTypeFilter}
                    onChange={(e) => setAssetTypeFilter(e.target.value)}
                    placeholder="Comma-separated asset type IDs (leave blank for any)"
                  />
                </Field>
              )}

              <Field>
                <FieldLabel htmlFor="rt-default-team">Default fallback team</FieldLabel>
                <Select value={defaultTeamId} onValueChange={(v) => setDefaultTeamId(v ?? '')}>
                  <SelectTrigger id="rt-default-team"><SelectValue placeholder="None — leave unassigned" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">None</SelectItem>
                    {(teams ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Used when the resolver chain finds no asset/location match.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Approval gate</FieldLegend>
            <FieldDescription>
              Require a manager or team to approve the ticket before it starts routing.
            </FieldDescription>
            <FieldGroup>
              <Field orientation="horizontal">
                <Checkbox
                  id="rt-requires-approval"
                  checked={requiresApproval}
                  onCheckedChange={(v) => {
                    setRequiresApproval(!!v);
                    if (!v) setApprovalApproverTeamId('');
                  }}
                />
                <FieldLabel htmlFor="rt-requires-approval" className="font-normal">
                  Require approval before routing
                </FieldLabel>
              </Field>
              {requiresApproval && (
                <Field>
                  <FieldLabel htmlFor="rt-approver-team">Approver team</FieldLabel>
                  <Select value={approvalApproverTeamId} onValueChange={(v) => setApprovalApproverTeamId(v ?? '')}>
                    <SelectTrigger id="rt-approver-team"><SelectValue placeholder="Pick a team…" /></SelectTrigger>
                    <SelectContent>
                      {(teams ?? []).map((t) => (
                        <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </FieldGroup>
          </FieldSet>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || saving}>
            {editingId ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
