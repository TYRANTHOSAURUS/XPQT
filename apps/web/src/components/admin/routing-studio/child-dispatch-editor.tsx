import { useEffect, useMemo, useState } from 'react';
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
import { useQueryClient } from '@tanstack/react-query';
import { useRequestTypes, requestTypeKeys } from '@/api/request-types';
import { useTeams } from '@/api/teams';
import { useVendors } from '@/api/vendors';
import { usePolicyEntities } from '@/api/routing';
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

interface TargetRef { kind: 'team' | 'vendor'; id: string }

interface ChildDispatchPolicyDefinition {
  schema_version: 1;
  request_type_id: string;
  dispatch_mode: string;
  split_strategy: string;
  execution_routing: 'fixed' | 'by_location';
  fixed_target?: TargetRef;
  fallback_target?: TargetRef;
}

type ExecutionMode = 'fixed' | 'by_location';

interface PublishedPolicyResponse {
  entity: PolicyEntity;
  published: {
    config_type: string;
    definition: ChildDispatchPolicyDefinition;
    version_id: string;
  } | null;
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
interface Props {
  /** Deep-link: pre-select a request type when the tab opens (from
   * ?rt=<id> on the Studio URL). */
  initialRequestTypeId?: string | null;
}

export function ChildDispatchEditor({ initialRequestTypeId }: Props = {}) {
  const qc = useQueryClient();
  const { data: requestTypes, isPending: rtLoading } = useRequestTypes() as { data: RequestType[] | undefined; isPending: boolean };
  const refetchRts = () => qc.invalidateQueries({ queryKey: requestTypeKeys.all });
  const { data: teams } = useTeams() as { data: Team[] | undefined };
  const { data: vendors } = useVendors() as { data: Vendor[] | undefined };
  const { data: policyEntities } = usePolicyEntities<PolicyEntity>('child-dispatch');

  const [selectedRtId, setSelectedRtId] = useState(initialRequestTypeId ?? '');

  useEffect(() => {
    if (!initialRequestTypeId) return;
    if (!requestTypes) return;
    if (selectedRtId === initialRequestTypeId) return;
    if (requestTypes.some((rt) => rt.id === initialRequestTypeId)) {
      setSelectedRtId(initialRequestTypeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequestTypeId, requestTypes]);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('fixed');
  const [targetKind, setTargetKind] = useState<TargetKind>('team');
  const [targetId, setTargetId] = useState('');
  const [fallbackKind, setFallbackKind] = useState<TargetKind>('team');
  const [fallbackId, setFallbackId] = useState('');
  const [currentTarget, setCurrentTarget] = useState<TargetRef | null>(null);
  const [currentFallback, setCurrentFallback] = useState<TargetRef | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedRt = (requestTypes ?? []).find((r) => r.id === selectedRtId) ?? null;

  // Prefetch the attached policy's current execution_mode + targets so admins
  // see what's set before editing. Resets to blank when no policy is attached.
  useEffect(() => {
    const entityId = selectedRt?.child_dispatch_policy_entity_id ?? null;
    if (!entityId) {
      setCurrentTarget(null);
      setCurrentFallback(null);
      setExecutionMode('fixed');
      setTargetId('');
      setTargetKind('team');
      setFallbackId('');
      setFallbackKind('team');
      return;
    }
    let cancelled = false;
    setLoadingCurrent(true);
    apiFetch<PublishedPolicyResponse>(`/admin/routing/policies/child_dispatch_policy/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const def = res.published?.definition ?? null;
        const mode: ExecutionMode = def?.execution_routing === 'by_location' ? 'by_location' : 'fixed';
        setExecutionMode(mode);

        const fixed = def?.fixed_target ?? null;
        if (fixed) {
          setCurrentTarget(fixed);
          setTargetKind(fixed.kind);
          setTargetId(fixed.id);
        } else {
          setCurrentTarget(null);
          setTargetId('');
        }

        const fb = def?.fallback_target ?? null;
        if (fb) {
          setCurrentFallback(fb);
          setFallbackKind(fb.kind);
          setFallbackId(fb.id);
        } else {
          setCurrentFallback(null);
          setFallbackId('');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentTarget(null);
          setCurrentFallback(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCurrent(false);
      });
    return () => { cancelled = true; };
  }, [selectedRt]);
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
  function handleFallbackKindChange(kind: TargetKind) {
    setFallbackKind(kind);
    setFallbackId('');
  }

  // Execution mode semantics:
  //   'fixed'       → fixed_target wins; fallback_target only fires if fixed
  //                   can't be resolved (rare edge case)
  //   'by_location' → ChildExecutionResolver hits location_teams(location,
  //                   domain); on miss, fallback_target takes over, then
  //                   unassigned. fixed_target is ignored.
  // Field visibility below matches these semantics so admins don't set values
  // that never fire.
  const showPrimary = executionMode === 'fixed';
  const primaryRequired = executionMode === 'fixed';

  async function handleSave() {
    if (!selectedRt) { toast.error('Pick a request type'); return; }
    if (primaryRequired && !targetId) { toast.error(`Pick a primary ${targetKind}`); return; }
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

      const definition: ChildDispatchPolicyDefinition = {
        schema_version: 1,
        request_type_id: selectedRt.id,
        dispatch_mode: 'always',
        split_strategy: 'single',
        execution_routing: executionMode,
      };
      if (executionMode === 'fixed' && targetId) {
        definition.fixed_target = { kind: targetKind, id: targetId };
      }
      if (fallbackId) {
        definition.fallback_target = { kind: fallbackKind, id: fallbackId };
      }

      const draft = await apiFetch<{ id: string }>(
        `/admin/routing/policies/child_dispatch_policy/${entityId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({ definition }),
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

      const primaryName = targetId
        ? (targetKind === 'team' ? teamsById.get(targetId)?.name : vendorsById.get(targetId)?.name)
        : null;
      const fallbackName = fallbackId
        ? (fallbackKind === 'team' ? teamsById.get(fallbackId)?.name : vendorsById.get(fallbackId)?.name)
        : null;
      const summary =
        executionMode === 'fixed'
          ? `${selectedRt.name} → ${primaryName ?? 'unset'}${fallbackName ? ` (fallback ${fallbackName})` : ''}`
          : `${selectedRt.name} uses location-team lookup${fallbackName ? `, fallback ${fallbackName}` : ''}`;
      toast.success(summary);
      // Keep the RT + target selected for fast iterate-and-save.
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
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="mb-1 text-sm font-medium uppercase text-muted-foreground">
              Attach child dispatch policy
            </h2>
            <p className="text-sm text-muted-foreground">
              Picks the team or vendor that handles child work orders for a request type.
              Vendors are first-class execution targets — unlike case ownership, which is
              team-only.
            </p>
          </div>
          {selectedRt && (
            <a
              className="shrink-0 whitespace-nowrap text-sm text-primary hover:underline"
              href={`/admin/routing-studio?tab=case-ownership&rt=${selectedRt.id}`}
            >
              Edit case ownership for this RT →
            </a>
          )}
        </div>

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
            <FieldLabel htmlFor="child-dispatch-execution">Execution mode</FieldLabel>
            <Select value={executionMode} onValueChange={(v) => setExecutionMode((v ?? 'fixed') as ExecutionMode)}>
              <SelectTrigger id="child-dispatch-execution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="fixed">Fixed — always the same target</SelectItem>
                <SelectItem value="by_location">By location — look up in location_teams</SelectItem>
              </SelectContent>
            </Select>
            <FieldDescription>
              {executionMode === 'fixed'
                ? 'Every child work order routes to the primary target below.'
                : "Walks the ticket's location chain against location_teams rows, falling back if nothing matches."}
            </FieldDescription>
          </Field>

          {showPrimary && (
            <>
              <Field>
                <FieldLabel htmlFor="child-dispatch-kind">Primary target type</FieldLabel>
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
                  Primary {targetKind === 'team' ? 'team' : 'vendor'}
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
                  {loadingCurrent
                    ? 'Loading current policy…'
                    : currentTarget
                      ? `Currently set to ${currentTarget.kind} "${(currentTarget.kind === 'team' ? teamsById.get(currentTarget.id)?.name : vendorsById.get(currentTarget.id)?.name) ?? currentTarget.id.slice(0, 8)}".`
                      : 'Child work orders route here in fixed mode.'}
                </FieldDescription>
              </Field>
            </>
          )}

          <FieldSeparator />

          <Field>
            <FieldLabel htmlFor="child-dispatch-fallback-kind">Fallback target type (optional)</FieldLabel>
            <Select value={fallbackKind} onValueChange={(v) => handleFallbackKindChange((v ?? 'team') as TargetKind)}>
              <SelectTrigger id="child-dispatch-fallback-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team">Team</SelectItem>
                <SelectItem value="vendor">Vendor</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="child-dispatch-fallback">
              Fallback {fallbackKind === 'team' ? 'team' : 'vendor'} (optional)
            </FieldLabel>
            <Select
              value={fallbackId || '__none'}
              onValueChange={(v) => setFallbackId(!v || v === '__none' ? '' : v)}
            >
              <SelectTrigger id="child-dispatch-fallback">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">None</SelectItem>
                {(fallbackKind === 'team' ? (teams ?? []) : (vendors ?? [])).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {loadingCurrent
                ? 'Loading…'
                : currentFallback
                  ? `Currently ${currentFallback.kind} "${(currentFallback.kind === 'team' ? teamsById.get(currentFallback.id)?.name : vendorsById.get(currentFallback.id)?.name) ?? currentFallback.id.slice(0, 8)}".`
                  : executionMode === 'by_location'
                    ? 'Fires when no location_teams row matches the ticket.'
                    : 'Fires only if the primary target cannot be resolved at runtime.'}
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
