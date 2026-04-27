import { useEffect, useMemo, useState } from 'react';
import { toastError, toastSuccess } from '@/lib/toast';
import { CheckCircle2, Plus, Trash2 } from 'lucide-react';
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
import { useSpaces } from '@/api/spaces';
import { usePolicyEntities } from '@/api/routing';
import { apiFetch } from '@/lib/api';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  case_owner_policy_entity_id: string | null;
}

interface Team { id: string; name: string }
interface SpaceOption { id: string; name: string }

interface PolicyEntity {
  id: string;
  config_type: string;
  slug: string;
  display_name: string;
  current_published_version_id: string | null;
}

interface PolicyRow {
  id: string;
  match: {
    operational_scope_ids?: string[];
    domain_ids?: string[];
    support_window_id?: string | null;
  };
  target: { kind: 'team'; team_id: string };
  ordering_hint: number;
}

interface CaseOwnerPolicyDefinition {
  schema_version: 1;
  request_type_id: string;
  scope_source: string;
  rows: PolicyRow[];
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
 * Routing Studio Case Ownership editor.
 *
 * Lets admins author a published `case_owner_policy` for any request type:
 *   - a default_target team (what wins when no scoped row matches)
 *   - an ordered list of scoped rows that override the default for specific
 *     operational scopes (spaces) — e.g. "tickets with a Netherlands location
 *     → Service Desk Amsterdam, everything else → Global Service Desk"
 *
 * Row matching is AND-combined inside each row (today only space, because
 * the intake scoping service walks the space tree to produce
 * operational_scope_chain). Domain and support-window matches are part of
 * the schema but deferred to later UI passes — domain registry and support
 * windows aren't UI-editable yet.
 *
 * Save runs a fixed 4-call sequence: ensure entity exists → create draft
 * version → publish → attach to request_types.case_owner_policy_entity_id.
 */
interface Props {
  /** Deep-link: pre-select a request type when the tab opens (from
   * ?rt=<id> on the Studio URL). */
  initialRequestTypeId?: string | null;
}

export function CaseOwnershipEditor({ initialRequestTypeId }: Props = {}) {
  const qc = useQueryClient();
  const { data: requestTypes, isPending: rtLoading } = useRequestTypes() as { data: RequestType[] | undefined; isPending: boolean };
  const refetchRts = () => qc.invalidateQueries({ queryKey: requestTypeKeys.all });
  const { data: teams } = useTeams() as { data: Team[] | undefined };
  const { data: spaces } = useSpaces() as { data: SpaceOption[] | undefined };
  const { data: policyEntities } = usePolicyEntities<PolicyEntity>('case-owner');

  const [selectedRtId, setSelectedRtId] = useState<string>(initialRequestTypeId ?? '');

  // Honor deep-link once the request-types list has loaded — selecting a
  // RT before the list arrives would leave the Select in an orphan state.
  useEffect(() => {
    if (!initialRequestTypeId) return;
    if (!requestTypes) return;
    if (selectedRtId === initialRequestTypeId) return;
    if (requestTypes.some((rt) => rt.id === initialRequestTypeId)) {
      setSelectedRtId(initialRequestTypeId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialRequestTypeId, requestTypes]);
  const [selectedTeamId, setSelectedTeamId] = useState<string>('');
  const [currentTeamId, setCurrentTeamId] = useState<string | null>(null);
  const [scopedRows, setScopedRows] = useState<PolicyRow[]>([]);
  const [loadingCurrent, setLoadingCurrent] = useState(false);
  const [saving, setSaving] = useState(false);

  const selectedRt = (requestTypes ?? []).find((r) => r.id === selectedRtId) ?? null;
  const teamsById = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
  const entitiesById = useMemo(
    () => new Map((policyEntities ?? []).map((e) => [e.id, e])),
    [policyEntities],
  );

  const attachedRows = (requestTypes ?? []).filter((r) => r.case_owner_policy_entity_id);

  // Load existing policy state (default team + scoped rows) when a RT with a
  // policy is picked. Resets to blank when picking a RT without one.
  useEffect(() => {
    const entityId = selectedRt?.case_owner_policy_entity_id ?? null;
    if (!entityId) {
      setCurrentTeamId(null);
      setSelectedTeamId('');
      setScopedRows([]);
      return;
    }
    let cancelled = false;
    setLoadingCurrent(true);
    apiFetch<PublishedPolicyResponse>(`/admin/routing/policies/case_owner_policy/${entityId}`)
      .then((res) => {
        if (cancelled) return;
        const def = res.published?.definition ?? null;
        const teamId = def?.default_target.team_id ?? null;
        setCurrentTeamId(teamId);
        setSelectedTeamId(teamId ?? '');
        setScopedRows(def?.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setCurrentTeamId(null);
          setScopedRows([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingCurrent(false);
      });
    return () => { cancelled = true; };
  }, [selectedRt]);

  function addScopedRow() {
    setScopedRows((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        match: { operational_scope_ids: [] },
        target: { kind: 'team', team_id: '' },
        ordering_hint: prev.length,
      },
    ]);
  }

  function updateScopedRowSpace(rowId: string, spaceId: string) {
    setScopedRows((prev) =>
      prev.map((r) =>
        r.id === rowId
          ? { ...r, match: { ...r.match, operational_scope_ids: spaceId ? [spaceId] : [] } }
          : r,
      ),
    );
  }

  function updateScopedRowTeam(rowId: string, teamId: string) {
    setScopedRows((prev) =>
      prev.map((r) =>
        r.id === rowId ? { ...r, target: { kind: 'team', team_id: teamId } } : r,
      ),
    );
  }

  function removeScopedRow(rowId: string) {
    setScopedRows((prev) =>
      prev
        .filter((r) => r.id !== rowId)
        .map((r, i) => ({ ...r, ordering_hint: i })),
    );
  }

  // Validate scoped rows locally before the 4-call sequence, so we fail fast
  // instead of partway through (e.g. entity created but version rejected).
  const incompleteRow = scopedRows.find(
    (r) => !r.target.team_id || !(r.match.operational_scope_ids?.[0]),
  );
  const canSave = !!selectedRt && !!selectedTeamId && !incompleteRow && !saving;

  async function handleSave() {
    if (!selectedRt || !selectedTeamId || incompleteRow) return;
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

      // Normalize ordering_hint to match array order so admins can reorder by
      // removing + re-adding without keeping stale hints around.
      const normalizedRows = scopedRows.map((r, i) => ({ ...r, ordering_hint: i }));

      const draft = await apiFetch<{ id: string }>(
        `/admin/routing/policies/case_owner_policy/${entityId}/versions`,
        {
          method: 'POST',
          body: JSON.stringify({
            definition: {
              schema_version: 1,
              request_type_id: selectedRt.id,
              scope_source: 'requester_home',
              rows: normalizedRows,
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

      const rowSummary = normalizedRows.length > 0
        ? ` (+${normalizedRows.length} scoped row${normalizedRows.length === 1 ? '' : 's'})`
        : '';
      toastSuccess(
        `${selectedRt.name} → ${teamsById.get(selectedTeamId)?.name ?? 'team'}${rowSummary}`,
      );
      // Keep the RT selected so admins can iterate (tweak + save again) without
      // having to re-pick from the dropdown. refetchRts will reload the list
      // and the effect picks the new "attached" state up.
      await refetchRts();
    } catch (err) {
      toastError("Couldn't save case-ownership policy", { error: err, retry: handleSave });
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
              Attach case owner policy
            </h2>
            <p className="text-sm text-muted-foreground">
              Picks the team that owns the parent case for a request type. Child work orders are
              dispatched separately and can still go to vendors.
            </p>
          </div>
          {selectedRt && (
            <a
              className="shrink-0 whitespace-nowrap text-sm text-primary hover:underline"
              href={`/admin/routing-studio?tab=child-dispatch&rt=${selectedRt.id}`}
            >
              Edit child dispatch for this RT →
            </a>
          )}
        </div>

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
                  : 'This team owns the parent case when no scoped row below matches.'}
            </FieldDescription>
          </Field>

          <FieldSeparator />

          <Field>
            <FieldLabel>Scoped rows</FieldLabel>
            <FieldDescription>
              Each row overrides the default for tickets whose operational scope matches. Rows
              are evaluated in order — the first match wins.
            </FieldDescription>
            {scopedRows.length === 0 ? (
              <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
                No scoped rows. All tickets of this type route to the default team.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {scopedRows.map((row, i) => {
                  const spaceId = row.match.operational_scope_ids?.[0] ?? '';
                  return (
                    <div
                      key={row.id}
                      className="grid grid-cols-[1.5rem_1fr_1fr_auto] items-center gap-2 rounded-md border bg-background p-2"
                    >
                      <span className="text-center text-xs text-muted-foreground">{i + 1}</span>
                      <Select
                        value={spaceId}
                        onValueChange={(v) => updateScopedRowSpace(row.id, v ?? '')}
                      >
                        <SelectTrigger aria-label="Operational scope">
                          <SelectValue placeholder="Pick a location" />
                        </SelectTrigger>
                        <SelectContent>
                          {(spaces ?? []).map((s) => (
                            <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={row.target.team_id}
                        onValueChange={(v) => updateScopedRowTeam(row.id, v ?? '')}
                      >
                        <SelectTrigger aria-label="Team">
                          <SelectValue placeholder="Pick a team" />
                        </SelectTrigger>
                        <SelectContent>
                          {(teams ?? []).map((t) => (
                            <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove row"
                        onClick={() => removeScopedRow(row.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addScopedRow}
              className="self-start"
            >
              <Plus className="mr-1 size-4" />
              Add scoped row
            </Button>
          </Field>

          <FieldSeparator />

          <div>
            <Button onClick={handleSave} disabled={!canSave}>
              {saving ? 'Saving…' : 'Save policy'}
            </Button>
            {incompleteRow && (
              <p className="mt-2 text-xs text-destructive">
                Every scoped row needs a location and a team.
              </p>
            )}
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
