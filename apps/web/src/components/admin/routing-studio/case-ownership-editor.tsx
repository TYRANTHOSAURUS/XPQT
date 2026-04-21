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
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  case_owner_policy_entity_id: string | null;
}

interface Team {
  id: string;
  name: string;
}

interface PolicyEntity {
  id: string;
  config_type: string;
  slug: string;
  display_name: string;
  current_published_version_id: string | null;
}

interface CaseOwnerPolicyDefinition {
  schema_version: 1;
  request_type_id: string;
  scope_source: string;
  rows: unknown[];
  default_target: { kind: 'team'; team_id: string };
}

interface PublishedPolicyResponse {
  entity: PolicyEntity;
  published: {
    config_type: string;
    definition: CaseOwnerPolicyDefinition;
    version_id: string;
  } | null;
}

/**
 * Routing Studio Case Ownership editor (Workstream B + E MVP).
 *
 * Minimum viable UI to attach a `case_owner_policy` to a request type
 * without SQL. Creates a new config_entity + draft version + publish on
 * first save; creates a new version on the existing entity on subsequent
 * saves. Admin picks the default_target team; scoped rows, scope source,
 * and support-window gating come in later iterations — this is the
 * walking-skeleton UI that pairs with the live v2 engines.
 */
export function CaseOwnershipEditor() {
  const { data: requestTypes, loading: rtLoading, refetch: refetchRts } = useApi<RequestType[]>('/request-types', []);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: policyEntities } = useApi<PolicyEntity[]>('/admin/routing/policies/case_owner_policy', []);

  const [selectedRtId, setSelectedRtId] = useState<string>('');
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [currentTeamId, setCurrentTeamId] = useState<string | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedRt = (requestTypes ?? []).find((r) => r.id === selectedRtId) ?? null;

  // When admin picks a request type that already has a policy, fetch its
  // published default_target so they see the current state before editing.
  useEffect(() => {
    const entityId = selectedRt?.case_owner_policy_entity_id ?? null;
    if (!entityId) {
      setCurrentTeamId(null);
      setSelectedTeamId('');
      return;
    }
    let cancelled = false;
    setLoadingCurrent(true);
    apiFetch<PublishedPolicyResponse>(`/admin/routing/policies/case_owner_policy/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const teamId = res.published?.definition.default_target.team_id ?? null;
        setCurrentTeamId(teamId);
        setSelectedTeamId(teamId ?? '');
      })
      .catch(() => {
        if (!cancelled) setCurrentTeamId(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingCurrent(false);
      });
    return () => { cancelled = true; };
  }, [selectedRt]);
  const teamsById = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
  const entitiesById = useMemo(
    () => new Map((policyEntities ?? []).map((e) => [e.id, e])),
    [policyEntities],
  );

  const attachedRows = (requestTypes ?? []).filter((r) => r.case_owner_policy_entity_id);

  async function handleSave() {
    if (!selectedRt) {
      toast.error('Pick a request type');
      return;
    }
    if (!selectedTeamId) {
      toast.error('Pick a default team');
      return;
    }
    setSaving(true);
    try {
      let entityId = selectedRt.case_owner_policy_entity_id;
      if (!entityId) {
        const created = await apiFetch<{ id: string }>(
          '/admin/routing/policies/case_owner_policy',
          {
            method: 'POST',
            body: JSON.stringify({
              slug: `case-owner-${selectedRt.id.slice(0, 8)}-${Date.now()}`,
              display_name: `Case Owner: ${selectedRt.name}`,
            }),
          },
        );
        entityId = created.id;
      }

      const draft = await apiFetch<{ id: string }>(
        `/admin/routing/policies/case_owner_policy/${entityId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({
            definition: {
              schema_version: 1,
              request_type_id: selectedRt.id,
              scope_source: 'requester_home',
              rows: [],
              default_target: { kind: 'team', team_id: selectedTeamId },
            },
          }),
        },
      );

      await apiFetch(`/admin/routing/policies/versions/${draft.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({}),
      });

      if (!selectedRt.case_owner_policy_entity_id) {
        await apiFetch(`/request-types/${selectedRt.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ case_owner_policy_entity_id: entityId }),
        });
      }

      toast.success(
        `${selectedRt.name} now routes parent cases to ${teamsById.get(selectedTeamId)?.name ?? 'team'}`,
      );
      setSelectedRtId('');
      setSelectedTeamId('');
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
          Attach case owner policy
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Picks the team that owns the parent case for a request type. Child work orders are
          dispatched separately and can still go to vendors.
        </p>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="case-ownership-rt">Request type</FieldLabel>
            <Select value={selectedRtId} onValueChange={(v) => setSelectedRtId(v ?? '')}>
              <SelectTrigger id="case-ownership-rt">
                <SelectValue placeholder="Pick a request type" />
              </SelectTrigger>
              <SelectContent>
                {(requestTypes ?? []).map((rt) => (
                  <SelectItem key={rt.id} value={rt.id}>
                    {rt.name}
                    {rt.domain ? ` · ${rt.domain}` : ''}
                    {rt.case_owner_policy_entity_id ? ' (already attached)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              Existing policies are updated in place (a new published version replaces the old).
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="case-ownership-team">Default team</FieldLabel>
            <Select value={selectedTeamId} onValueChange={(v) => setSelectedTeamId(v ?? '')}>
              <SelectTrigger id="case-ownership-team">
                <SelectValue placeholder="Pick a team" />
              </SelectTrigger>
              <SelectContent>
                {(teams ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              {loadingCurrent
                ? 'Loading current policy…'
                : currentTeamId
                  ? `Currently set to ${teamsById.get(currentTeamId)?.name ?? currentTeamId.slice(0, 8)}. Pick a different team and save to replace.`
                  : 'This team owns the parent case when no scoped row matches. Scoped rows (by country, campus, etc.) are not editable from this MVP — they come in a later pass.'}
            </FieldDescription>
          </Field>

          <FieldSeparator />

          <div>
            <Button onClick={handleSave} disabled={saving || !selectedRtId || !selectedTeamId}>
              {saving ? 'Saving…' : 'Save policy'}
            </Button>
          </div>
        </FieldGroup>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase text-muted-foreground">
          Request types with an attached policy
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
              <TableEmpty cols={3} message="No request types have a case owner policy yet." />
            ) : (
              attachedRows.map((rt) => {
                const entity = entitiesById.get(rt.case_owner_policy_entity_id!);
                return (
                  <TableRow key={rt.id}>
                    <TableCell className="font-medium">{rt.name}</TableCell>
                    <TableCell>
                      {rt.domain ? <Badge variant="outline">{rt.domain}</Badge> : null}
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-1.5 text-sm">
                        <CheckCircle2 className="size-4 text-green-600" />
                        {entity?.display_name ?? entity?.slug ?? rt.case_owner_policy_entity_id}
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
