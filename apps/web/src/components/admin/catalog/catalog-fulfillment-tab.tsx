import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useApi } from '@/hooks/use-api';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from '@/components/ui/field';
import { RequestTypeDialog } from '@/components/admin/request-type-dialog';
import type { ServiceItemDetail } from './catalog-service-panel';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  fulfillment_strategy?: 'asset' | 'location' | 'fixed' | 'auto';
  location_granularity?: string | null;
  requires_location?: boolean;
  requires_asset?: boolean;
  asset_type_filter?: string[] | null;
  requires_approval?: boolean;
  default_team_id?: string | null;
  default_vendor_id?: string | null;
  form_schema_id?: string | null;
  sla_policy?: { id: string; name: string } | null;
  workflow?: { id: string; name: string } | null;
}

interface CriteriaSet { id: string; name: string }

const policyLabel: Record<ServiceItemDetail['on_behalf_policy'], string> = {
  self_only: 'Only the requester themselves',
  any_person: 'Any person in the directory',
  direct_reports: 'Manager → direct reports',
  configured_list: 'Actor/target rules below',
};

export function CatalogFulfillmentTab({
  detail,
  onSaved,
  requestTypeId,
}: {
  detail: ServiceItemDetail;
  onSaved: () => void;
  requestTypeId: string;
}) {
  const { data: rt } = useApi<RequestType>(`/request-types/${requestTypeId}`, [requestTypeId]);
  const { data: sets } = useApi<CriteriaSet[]>('/admin/criteria-sets', []);
  const setsById = new Map((sets ?? []).map((s) => [s.id, s]));
  const [editOpen, setEditOpen] = useState(false);

  const actors = detail.on_behalf_rules.filter((r) => r.role === 'actor');
  const targets = detail.on_behalf_rules.filter((r) => r.role === 'target');

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Fulfillment is defined on the linked Request Type (workflow, SLA, routing domain, defaults).
        On-behalf-of policy and rules are catalog-level and apply only in the portal.
      </p>

      <FieldGroup>
        <FieldSet>
          <FieldLegend>Linked Request Type</FieldLegend>
          <FieldDescription>Drives routing domain, workflow, SLA and approvals.</FieldDescription>
          <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <ReadOnly label="Name" value={rt?.name ?? '—'} />
            <ReadOnly
              label="Domain"
              value={rt?.domain ? <Badge variant="outline" className="capitalize">{rt.domain}</Badge> : '—'}
            />
            <ReadOnly
              label="Strategy"
              value={rt?.fulfillment_strategy ? (
                <Badge variant="outline" className="capitalize">{rt.fulfillment_strategy}</Badge>
              ) : '—'}
            />
            <ReadOnly
              label="Location depth"
              value={rt?.location_granularity
                ? <span className="capitalize">{rt.location_granularity.replace('_', ' ')}</span>
                : 'Any'}
            />
            <ReadOnly label="Workflow" value={rt?.workflow?.name ?? '—'} />
            <ReadOnly label="SLA policy" value={rt?.sla_policy?.name ?? '—'} />
            <ReadOnly
              label="Approval"
              value={rt?.requires_approval ? (
                <Badge variant="secondary">Required</Badge>
              ) : <span className="text-muted-foreground">None</span>}
            />
            <ReadOnly
              label="Default handler"
              value={
                rt?.default_team_id
                  ? <span className="text-xs font-mono truncate">team:{rt.default_team_id.slice(0, 8)}</span>
                  : rt?.default_vendor_id
                    ? <span className="text-xs font-mono truncate">vendor:{rt.default_vendor_id.slice(0, 8)}</span>
                    : <span className="text-muted-foreground">—</span>
              }
            />
          </div>
          <div className="mt-3">
            <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
              Edit fulfillment settings
            </Button>
          </div>
        </FieldSet>

        <FieldSeparator />

        <FieldSet>
          <FieldLegend>On-behalf-of policy</FieldLegend>
          <FieldDescription>Who may submit this request, and for whom.</FieldDescription>
          <Field>
            <FieldLabel>Policy</FieldLabel>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="capitalize">
                {detail.on_behalf_policy.replace('_', ' ')}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {policyLabel[detail.on_behalf_policy]}
              </span>
            </div>
          </Field>

          {detail.on_behalf_policy === 'configured_list' && (
            <div className="overflow-auto rounded-md border">
              <table className="min-w-full border-collapse text-sm">
                <thead className="bg-muted/40">
                  <tr>
                    <th className="border-b px-3 py-2 text-left font-medium w-32">Role</th>
                    <th className="border-b px-3 py-2 text-left font-medium">Criteria sets</th>
                  </tr>
                </thead>
                <tbody>
                  <OnBehalfRow
                    label="Actor (submitter)"
                    items={actors}
                    setsById={setsById}
                  />
                  <OnBehalfRow
                    label="Target (on-behalf-of)"
                    items={targets}
                    setsById={setsById}
                  />
                </tbody>
              </table>
            </div>
          )}
        </FieldSet>
      </FieldGroup>

      <p className="text-xs text-muted-foreground">
        On-behalf criteria authoring is not yet inline. Manage criteria sets at{' '}
        <span className="font-medium">Settings → Criteria sets</span> (coming soon).
      </p>

      <RequestTypeDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        editingId={requestTypeId}
        onSaved={() => {
          setEditOpen(false);
          onSaved();
        }}
      />
    </div>
  );
}

function ReadOnly({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate">{value}</span>
    </div>
  );
}

function OnBehalfRow({
  label,
  items,
  setsById,
}: {
  label: string;
  items: ServiceItemDetail['on_behalf_rules'];
  setsById: Map<string, { id: string; name: string }>;
}) {
  return (
    <tr>
      <th scope="row" className="border-b px-3 py-1.5 text-left font-normal align-top">
        {label}
      </th>
      <td className="border-b px-3 py-1.5">
        {items.length === 0 ? (
          <span className="text-xs text-muted-foreground italic">default: everyone</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {items.map((r) => (
              <Badge key={r.id} variant="secondary">
                {setsById.get(r.criteria_set_id)?.name ?? 'Unknown set'}
              </Badge>
            ))}
          </div>
        )}
      </td>
    </tr>
  );
}
