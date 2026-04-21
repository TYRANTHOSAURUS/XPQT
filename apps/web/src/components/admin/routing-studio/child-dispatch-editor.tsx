import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator,
} from '@/components/ui/field';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { TableEmpty, TableLoading } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  child_dispatch_policy_entity_id: string | null;
}

interface Team { id: string; name: string }
interface Vendor { id: string; name: string }

interface PolicyEntity {
  id: string;
  config_type: string;
  slug: string;
  display_name: string;
  current_published_version_id: string | null;
}

type TargetKind = 'team' | 'vendor';

/**
 * Routing Studio Child Dispatch editor (Workstream C + E MVP).
 *
 * Pairs with CaseOwnershipEditor. Pick a request type and a single target
 * (team or vendor) for child work orders. Hardcodes the simplest policy
 * shape: dispatch_mode='always', split_strategy='single',
 * execution_routing='fixed'. Multi-child splits, by-location execution,
 * fallback targets, and workflow-driven dispatch come in a later pass.
 *
 * Unlike case ownership, vendors are first-class here — child work orders
 * are the execution lane where vendors belong.
 */
export function ChildDispatchEditor() {
  const { data: requestTypes, loading: rtLoading, refetch: refetchRts } = useApi<RequestType[]>('/request-types', []);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);
  const { data: policyEntities } = useApi<PolicyEntity[]>('/admin/routing/policies/child_dispatch_policy', []);

  const [selectedRtId, setSelectedRtId] = useState('');
  const [targetKind, setTargetKind] = useState<TargetKind>('team');
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving] = useState(false);

  const selectedRt = (requestTypes ?? []).find((r) => r.id === selectedRtId) ?? null;
  const teamsById = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
  const vendorsById = useMemo(() => new Map((vendors ?? []).map((v) => [v.id, v])), [vendors]);
  const entitiesById = useMemo(
    () => new Map((policyEntities ?? []).map((e) => [e.id, e])),
    [policyEntities],
  );

  const attachedRows = (requestTypes ?? []).filter((r) => r.child_dispatch_policy_entity_id);

  // Reset target when kind changes — team ids don't belong in vendor selects and vice versa.
  function handleKindChange(kind: TargetKind) {
    setTargetKind(kind);
    setTargetId('');
  }

  async function handleSave() {
    if (!selectedRt) { toast.error('Pick a request type'); return; }
    if (!targetId) { toast.error(`Pick a ${targetKind}`); return; }
    setSaving(true);
    try {
      let entityId = selectedRt.child_dispatch_policy_entity_id;
      if (!entityId) {
        const created = await apiFetch<{ id: string }>(
          '/admin/routing/policies/child_dispatch_policy',
          {
            method: 'POST',
            body: JSON.stringify({
              slug: `child-dispatch-${selectedRt.id.slice(0, 8)}-${Date.now()}`,
              display_name: `Child Dispatch: ${selectedRt.name}`,
            }),
          },
        );
        entityId = created.id;
      }

      const draft = await apiFetch<{ id: string }>(
        `/admin/routing/policies/child_dispatch_policy/${entityId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({
            definition: {
              schema_version: 1,
              request_type_id: selectedRt.id,
              dispatch_mode: 'always',
              split_strategy: 'single',
              execution_routing: 'fixed',
              fixed_target: { kind: targetKind, id: targetId },
            },
          }),
        },
      );

      await apiFetch(`/admin/routing/policies/versions/${draft.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      if (!selectedRt.child_dispatch_policy_entity_id) {
        await apiFetch(`/request-types/${selectedRt.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ child_dispatch_policy_entity_id: entityId }),
        });
      }

      const targetName =
        targetKind === 'team'
          ? teamsById.get(targetId)?.name
          : vendorsById.get(targetId)?.name;
      toast.success(`${selectedRt.name} dispatches child work orders to ${targetName ?? targetKind}`);
      setSelectedRtId('');
      setTargetId('');
      await refetchRts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-md border bg-card p-4">
        <h2 className="mb-1 text-sm font-medium uppercase text-muted-foreground">
          Attach child dispatch policy
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Picks the team or vendor that handles child work orders for a request type. Vendors
          are first-class execution targets — unlike case ownership, which is team-only.
        </p>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="child-dispatch-rt">Request type</FieldLabel>
            <Select value={selectedRtId} onValueChange={(v) => setSelectedRtId(v ?? '')}>
              <SelectTrigger id="child-dispatch-rt">
                <SelectValue placeholder="Pick a request type" />
              </SelectTrigger>
              <SelectContent>
                {(requestTypes ?? []).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                    {rt.domain ? ` · ${rt.domain}` : ''}
                    {rt.child_dispatch_policy_entity_id ? ' (already attached)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Existing policies are updated in place (a new published version replaces the old).
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="child-dispatch-kind">Target type</FieldLabel>
            <Select value={targetKind} onValueChange={(v) => handleKindChange((v ?? 'team') as TargetKind)}>
              <SelectTrigger id="child-dispatch-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">Team</SelectItem>
                <SelectItem value="vendor">Vendor</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="child-dispatch-target">
              {targetKind === 'team' ? 'Team' : 'Vendor'}
            </FieldLabel>
            <Select value={targetId} onValueChange={(v) => setTargetId(v ?? '')}>
              <SelectTrigger id="child-dispatch-target">
                <SelectValue placeholder={`Pick a ${targetKind}`} />
              </SelectTrigger>
              <SelectContent>
                {(targetKind === 'team' ? (teams ?? []) : (vendors ?? [])).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Child work orders route here. Split strategies (per-location, per-asset) and
              fallback targets come in a later pass — this MVP hardcodes single-target fixed
              dispatch.
            </FieldDescription>
          </Field>

          <FieldSeparator />

          <div>
            <Button onClick={handleSave} disabled={saving || !selectedRtId || !targetId}>
              {saving ? 'Saving…' : 'Save policy'}
            </Button>
          </div>
        </FieldGroup>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase text-muted-foreground">
          Request types with a child dispatch policy
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Request type</TableHead>
              <TableHead>Domain</TableHead>
              <TableHead>Policy entity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rtLoading ? (
              <TableLoading cols={3} rows={3} />
            ) : attachedRows.length === 0 ? (
              <TableEmpty cols={3} message="No request types have a child dispatch policy yet." />
            ) : (
              attachedRows.map((rt) => {
                const entity = entitiesById.get(rt.child_dispatch_policy_entity_id!);
                return (
                  <TableRow key={rt.id}>
                    <TableCell className="font-medium">{rt.name}</TableCell>
                    <TableCell>
                      {rt.domain ? <Badge variant="outline">{rt.domain}</Badge> : null}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <CheckCircle2 className="size-4 text-green-600" />
                        {entity?.display_name ?? entity?.slug ?? rt.child_dispatch_policy_entity_id}
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}
