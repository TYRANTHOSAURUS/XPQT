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
import { useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { useSlaPolicies } from '@/api/sla-policies';
import { useFormSchemas } from '@/api/config-entities';
import { useTeams } from '@/api/teams';
import { requestTypeKeys } from '@/api/request-types';
import { configEntityKeys } from '@/api/config-entities';

type FulfillmentStrategy = 'asset' | 'location' | 'fixed' | 'auto';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  location_granularity?: string | null;
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

/**
 * The default form schema for a request type lives on
 * request_type_form_variants (criteria_set_id IS NULL). Since migration 00098
 * dropped the denormalized column, this dialog fetches the default variant
 * on load and writes through PUT /request-types/:id/form-variants on save —
 * request_types itself never carries a form_schema_id anymore.
 */
interface FormVariantRow {
  id: string;
  criteria_set_id: string | null;
  form_schema_id: string;
  priority: number;
  starts_at: string | null;
  ends_at: string | null;
  active: boolean;
}

const domains = ['it', 'fm', 'workplace', 'visitor', 'catering', 'security', 'general'];

// Matches spaces.type check constraint in 00004_spaces.sql. Presented with
// human-readable labels.
const GRANULARITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '__any', label: 'Any (no drill-down)' },
  { value: 'site', label: 'Site' },
  { value: 'building', label: 'Building' },
  { value: 'floor', label: 'Floor' },
  { value: 'room', label: 'Room' },
  { value: 'meeting_room', label: 'Meeting room' },
  { value: 'common_area', label: 'Common area' },
  { value: 'storage_room', label: 'Storage room' },
  { value: 'technical_room', label: 'Technical room' },
  { value: 'desk', label: 'Desk' },
  { value: 'parking_space', label: 'Parking space' },
];

interface RequestTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  onSaved: () => void;
}

export function RequestTypeDialog({
  open,
  onOpenChange,
  editingId,
  onSaved,
}: RequestTypeDialogProps) {
  const qc = useQueryClient();
  const { data: slas } = useSlaPolicies();
  const { data: formSchemas } = useFormSchemas();
  const { data: teams } = useTeams();

  const [name, setName] = useState('');
  const [domain, setDomain] = useState('general');
  const [slaPolicyId, setSlaPolicyId] = useState('');
  const [formSchemaId, setFormSchemaId] = useState('');
  const [initialFormSchemaId, setInitialFormSchemaId] = useState<string | null>(null);
  const [locationGranularity, setLocationGranularity] = useState('__any');
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
      setFormSchemaId('');
      setInitialFormSchemaId(null);
      setLocationGranularity('__any');
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
        const [rt, variants] = await Promise.all([
          apiFetch<RequestType>(`/request-types/${editingId}`),
          apiFetch<FormVariantRow[]>(`/request-types/${editingId}/form-variants`),
        ]);
        if (cancelled) return;
        setName(rt.name);
        setDomain(rt.domain ?? 'general');
        setSlaPolicyId(rt.sla_policy?.id ?? '');
        // Default form variant = criteria_set_id IS NULL + active. If none
        // exists the dialog shows "None" and a save picks up any value the
        // admin selects.
        const defaultVariant = (variants ?? []).find((v) => v.criteria_set_id === null && v.active) ?? null;
        setFormSchemaId(defaultVariant?.form_schema_id ?? '');
        setInitialFormSchemaId(defaultVariant?.form_schema_id ?? null);
        setLocationGranularity(rt.location_granularity ?? '__any');
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
  }, [open, editingId, onOpenChange]);

  const handleSave = async () => {
    if (!name.trim()) return;
    const body = {
      name,
      domain,
      sla_policy_id: slaPolicyId || undefined,
      location_granularity: locationGranularity === '__any' ? null : locationGranularity,
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
    // The save is two server calls (UPDATE/INSERT request_types, then
    // replace the default form variant when form_schema_id changed). If the
    // first succeeds and the second fails we don't want to leave a half-
    // applied state behind: on CREATE we roll the new row back; on UPDATE
    // we surface the failure with an actionable message and keep the dialog
    // open so the admin can retry.
    const targetSchemaId = formSchemaId || null;
    const needsVariantSync = targetSchemaId !== initialFormSchemaId;
    let createdId: string | null = null;
    try {
      let savedId: string;
      if (editingId) {
        await apiFetch(`/request-types/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
        savedId = editingId;
      } else {
        const created = await apiFetch<{ id: string }>('/request-types', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        savedId = created.id;
        createdId = created.id;
      }

      if (needsVariantSync) {
        // PUT /form-variants is a replace-set — fetch existing, preserve any
        // conditional variants (criteria_set_id != null), and submit the new
        // full list so admin-authored conditionals aren't wiped by this
        // dialog. CREATE path: no existing conditionals; this still writes
        // the default (or an empty list if the admin cleared the field).
        const existing = (await apiFetch<FormVariantRow[]>(
          `/request-types/${savedId}/form-variants`,
        )) ?? [];
        const conditionals = existing
          .filter((v) => v.criteria_set_id !== null)
          .map((v) => ({
            criteria_set_id: v.criteria_set_id,
            form_schema_id: v.form_schema_id,
            priority: v.priority,
            starts_at: v.starts_at,
            ends_at: v.ends_at,
            active: v.active,
          }));
        const variants = targetSchemaId
          ? [
              ...conditionals,
              { criteria_set_id: null, form_schema_id: targetSchemaId, priority: 0, active: true },
            ]
          : conditionals;
        try {
          await apiFetch(`/request-types/${savedId}/form-variants`, {
            method: 'PUT',
            body: JSON.stringify({ variants }),
          });
        } catch (variantErr) {
          // CREATE path: roll the just-created request type back so a retry
          // doesn't produce a duplicate. Best-effort — a rollback failure is
          // surfaced to the user but doesn't mask the original error.
          if (createdId) {
            try {
              await apiFetch(`/request-types/${createdId}`, { method: 'DELETE' });
            } catch {
              toast.error(
                'Form schema sync failed AND rollback of the new request type failed. Check /admin/request-types for a stray row.',
              );
              throw variantErr;
            }
          }
          // UPDATE path: surface the drift.
          throw variantErr;
        }
      }

      toast.success(editingId ? 'Request type updated' : 'Request type created');
      // Propagate to every consumer: list pages, ticket detail, portal submit,
      // routing studio. Skipping an explicit invalidation here used to mean
      // admins had to reload to see their change (T4 staleness bug).
      await Promise.all([
        qc.invalidateQueries({ queryKey: requestTypeKeys.all }),
        qc.invalidateQueries({ queryKey: configEntityKeys.all }),
      ]);
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
                <FieldLabel htmlFor="rt-location-granularity">Location granularity</FieldLabel>
                <Select value={locationGranularity} onValueChange={(v) => setLocationGranularity(v ?? '__any')}>
                  <SelectTrigger id="rt-location-granularity"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {GRANULARITY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  When set, portal submissions must pinpoint a location at this depth.
                  Employees whose current location is shallower are asked to drill down.
                </FieldDescription>
              </Field>

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
