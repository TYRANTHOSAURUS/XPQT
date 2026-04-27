import { useEffect, useState } from 'react';
import { toastError, toastRemoved, toastSuccess, toastUpdated } from '@/lib/toast';
import {
  Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import {
  Field, FieldDescription, FieldGroup, FieldLabel, FieldSeparator, FieldSet, FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { LocationCombobox } from '@/components/location-combobox';
import { apiFetch } from '@/lib/api';
import { useTeams } from '@/api/teams';
import { useVendors } from '@/api/vendors';
import { useSlaPolicies } from '@/api/sla-policies';
import { useWorkflowDefinitions } from '@/api/workflows';
import { useSpaceGroups, usePolicyEntities } from '@/api/routing';
import { Trash2, Plus } from 'lucide-react';

type ScopeKind = 'tenant' | 'space' | 'space_group';
type HandlerKind = null | 'team' | 'vendor' | 'none';

export interface ScopeOverrideRow {
  id: string;
  scope_kind: ScopeKind;
  space_id: string | null;
  space_group_id: string | null;
  inherit_to_descendants: boolean;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  handler_kind: HandlerKind;
  handler_team_id: string | null;
  handler_vendor_id: string | null;
  workflow_definition_id: string | null;
  case_sla_policy_id: string | null;
  case_owner_policy_entity_id: string | null;
  child_dispatch_policy_entity_id: string | null;
  executor_sla_policy_id: string | null;
}

// Draft = row being edited in the sheet. UUIDs may be temporary — id isn't
// sent on save (the PUT replaces the whole set and the DB regenerates ids).
interface Draft extends Omit<ScopeOverrideRow, 'id'> {
  id?: string;
}

function toDraft(o: ScopeOverrideRow | null, seed?: Partial<ScopeOverrideRow> | null): Draft {
  if (o) return { ...o };
  const base: Draft = {
    scope_kind: 'space',
    space_id: null,
    space_group_id: null,
    inherit_to_descendants: true,
    active: true,
    starts_at: null,
    ends_at: null,
    handler_kind: null,
    handler_team_id: null,
    handler_vendor_id: null,
    workflow_definition_id: null,
    case_sla_policy_id: null,
    case_owner_policy_entity_id: null,
    child_dispatch_policy_entity_id: null,
    executor_sla_policy_id: null,
  };
  return seed ? { ...base, ...seed } : base;
}

function draftToPutRow(d: Draft) {
  // Drop id and normalize empty strings → null for FK-ish fields.
  const {
    id: _id,
    ...rest
  } = d;
  void _id;
  return {
    ...rest,
    space_id: rest.scope_kind === 'space' ? rest.space_id ?? null : null,
    space_group_id: rest.scope_kind === 'space_group' ? rest.space_group_id ?? null : null,
  };
}

interface Team { id: string; name: string }
interface Vendor { id: string; name: string }
interface SlaPolicy { id: string; name: string }
interface Workflow { id: string; name: string }
interface SpaceGroup { id: string; name: string }
interface PolicyEntity { id: string; slug: string; display_name: string; current_published_version_id: string | null }

interface EditorProps {
  requestTypeId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingOverrides: ScopeOverrideRow[];
  editing: ScopeOverrideRow | null;
  /**
   * Preset values for a new override. Ignored when `editing` is set. Used by
   * the coverage matrix to open a scope-scoped editor from a site row (so the
   * scope kind + space id are prefilled, and the admin only picks the handler
   * / workflow / SLA / policy fields).
   */
  initialDraft?: Partial<ScopeOverrideRow> | null;
  onSaved: () => void;
}

/**
 * Inline authoring for request_type_scope_overrides. Shows one drawer per
 * override being edited. Uses the existing PUT /request-types/:id/scope-
 * overrides replace-set endpoint: load current set, splice in the new/edited
 * row, send. Service layer guards: scope XOR, handler shape, non-empty,
 * temporal overlap, tenant FK validation.
 */
export function ScopeOverrideEditor({
  requestTypeId,
  open,
  onOpenChange,
  existingOverrides,
  editing,
  initialDraft,
  onSaved,
}: EditorProps) {
  const { data: teams } = useTeams() as { data: Team[] | undefined };
  const { data: vendors } = useVendors() as { data: Vendor[] | undefined };
  const { data: slas } = useSlaPolicies() as { data: SlaPolicy[] | undefined };
  const { data: workflows } = useWorkflowDefinitions() as { data: Workflow[] | undefined };
  const { data: spaceGroups } = useSpaceGroups() as { data: SpaceGroup[] | undefined };
  const { data: caseOwnerPolicies } = usePolicyEntities<PolicyEntity>('case-owner');
  const { data: childDispatchPolicies } = usePolicyEntities<PolicyEntity>('child-dispatch');

  const [draft, setDraft] = useState<Draft>(toDraft(null));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(toDraft(editing, initialDraft));
    // initialDraft is intentionally a fresh-draft seed; we stringify so a
    // parent passing a new object each render doesn't re-seed stale edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id, JSON.stringify(initialDraft ?? null)]);

  const patch = <K extends keyof Draft>(k: K, v: Draft[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));

  const handlerShapeValid = (() => {
    const k = draft.handler_kind;
    const hasTeam = !!draft.handler_team_id;
    const hasVendor = !!draft.handler_vendor_id;
    if (k == null) return !hasTeam && !hasVendor;
    if (k === 'none') return !hasTeam && !hasVendor;
    if (k === 'team') return hasTeam && !hasVendor;
    if (k === 'vendor') return hasVendor && !hasTeam;
    return false;
  })();

  const nonEmpty =
    draft.handler_kind !== null ||
    !!draft.workflow_definition_id ||
    !!draft.case_sla_policy_id ||
    !!draft.executor_sla_policy_id ||
    !!draft.case_owner_policy_entity_id ||
    !!draft.child_dispatch_policy_entity_id;

  const scopeValid =
    (draft.scope_kind === 'tenant' && !draft.space_id && !draft.space_group_id) ||
    (draft.scope_kind === 'space' && !!draft.space_id && !draft.space_group_id) ||
    (draft.scope_kind === 'space_group' && !draft.space_id && !!draft.space_group_id);

  const canSave = handlerShapeValid && nonEmpty && scopeValid && !saving;

  const save = async () => {
    setSaving(true);
    try {
      // Replace-set: fetch current server state, then substitute or append.
      const current = existingOverrides.map((o) => ({ ...o }));
      const nextRow = draftToPutRow(draft);
      const overrides = editing
        ? current.map((o) => (o.id === editing.id ? nextRow : o))
        : [...current, nextRow];

      await apiFetch(`/request-types/${requestTypeId}/scope-overrides`, {
        method: 'PUT',
        body: JSON.stringify({ overrides }),
      });
      if (editing) {
        toastUpdated('Override');
      } else {
        toastSuccess('Override added');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toastError("Couldn't save override", { error: err, retry: save });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    if (!confirm('Remove this override? The resolver will fall through to request type defaults at this scope.')) {
      return;
    }
    setSaving(true);
    try {
      const overrides = existingOverrides.filter((o) => o.id !== editing.id);
      await apiFetch(`/request-types/${requestTypeId}/scope-overrides`, {
        method: 'PUT',
        body: JSON.stringify({ overrides }),
      });
      toastRemoved('Override');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toastError("Couldn't remove override", { error: err, retry: remove });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="sm:max-w-xl overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{editing ? 'Edit scope override' : 'New scope override'}</SheetTitle>
          <SheetDescription>
            Per-scope exception to the request type's routing, workflow, SLA, or policy defaults.
            See docs/service-catalog-live.md §5.5.
          </SheetDescription>
        </SheetHeader>

        <FieldGroup className="mt-4">
          <FieldSet>
            <FieldLegend>Scope</FieldLegend>
            <FieldDescription>
              Precedence: exact space &gt; inherited ancestor &gt; space group &gt; tenant.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="sov-scope-kind">Kind</FieldLabel>
              <Select
                value={draft.scope_kind}
                onValueChange={(v) => setDraft((d) => ({
                  ...d,
                  scope_kind: v as ScopeKind,
                  space_id: null,
                  space_group_id: null,
                }))}
              >
                <SelectTrigger id="sov-scope-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="tenant">Tenant-wide</SelectItem>
                  <SelectItem value="space">Space (site / building / floor / room)</SelectItem>
                  <SelectItem value="space_group">Space group</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {draft.scope_kind === 'space' && (
              <>
                <Field>
                  <FieldLabel htmlFor="sov-space">Space</FieldLabel>
                  <LocationCombobox
                    value={draft.space_id}
                    onChange={(v) => patch('space_id', v)}
                    placeholder="Pick a space…"
                    activeOnly
                  />
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    id="sov-inherit"
                    checked={draft.inherit_to_descendants}
                    onCheckedChange={(v) => patch('inherit_to_descendants', !!v)}
                  />
                  <FieldLabel htmlFor="sov-inherit" className="font-normal">
                    Inherit to descendants
                  </FieldLabel>
                </Field>
              </>
            )}

            {draft.scope_kind === 'space_group' && (
              <Field>
                <FieldLabel htmlFor="sov-group">Space group</FieldLabel>
                <Select
                  value={draft.space_group_id ?? ''}
                  onValueChange={(v) => patch('space_group_id', v || null)}
                >
                  <SelectTrigger id="sov-group"><SelectValue placeholder="Pick a group…" /></SelectTrigger>
                  <SelectContent>
                    {(spaceGroups ?? []).map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Handler</FieldLegend>
            <FieldDescription>
              Replaces the normal routing chain when set. Pick <code className="font-mono">none</code>
              {' '}to explicitly block auto-routing at this scope (ticket lands unassigned and waits for a human).
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="sov-handler-kind">Handler kind</FieldLabel>
              <Select
                value={draft.handler_kind ?? '__null'}
                onValueChange={(v) => {
                  const next = v === '__null' ? null : (v as HandlerKind);
                  setDraft((d) => ({
                    ...d,
                    handler_kind: next,
                    handler_team_id: next === 'team' ? d.handler_team_id : null,
                    handler_vendor_id: next === 'vendor' ? d.handler_vendor_id : null,
                  }));
                }}
              >
                <SelectTrigger id="sov-handler-kind"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__null">Don't override routing</SelectItem>
                  <SelectItem value="team">Assign to team</SelectItem>
                  <SelectItem value="vendor">Assign to vendor</SelectItem>
                  <SelectItem value="none">Explicitly unassign (stop)</SelectItem>
                </SelectContent>
              </Select>
            </Field>

            {draft.handler_kind === 'team' && (
              <Field>
                <FieldLabel htmlFor="sov-team">Team</FieldLabel>
                <Select
                  value={draft.handler_team_id ?? ''}
                  onValueChange={(v) => patch('handler_team_id', v || null)}
                >
                  <SelectTrigger id="sov-team"><SelectValue placeholder="Pick a team…" /></SelectTrigger>
                  <SelectContent>
                    {(teams ?? []).map((t) => (
                      <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
            {draft.handler_kind === 'vendor' && (
              <Field>
                <FieldLabel htmlFor="sov-vendor">Vendor</FieldLabel>
                <Select
                  value={draft.handler_vendor_id ?? ''}
                  onValueChange={(v) => patch('handler_vendor_id', v || null)}
                >
                  <SelectTrigger id="sov-vendor"><SelectValue placeholder="Pick a vendor…" /></SelectTrigger>
                  <SelectContent>
                    {(vendors ?? []).map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Workflow, SLA, policy</FieldLegend>
            <FieldDescription>
              Null falls through to the request type's default. At least one field (including
              handler kind) must be set for the row to be valid.
            </FieldDescription>
            <Field>
              <FieldLabel htmlFor="sov-wf">Workflow</FieldLabel>
              <Select
                value={draft.workflow_definition_id ?? ''}
                onValueChange={(v) => patch('workflow_definition_id', v || null)}
              >
                <SelectTrigger id="sov-wf"><SelectValue placeholder="Use request type default" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="">Use request type default</SelectItem>
                  {(workflows ?? []).map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="sov-case-sla">Case SLA</FieldLabel>
                <Select
                  value={draft.case_sla_policy_id ?? ''}
                  onValueChange={(v) => patch('case_sla_policy_id', v || null)}
                >
                  <SelectTrigger id="sov-case-sla"><SelectValue placeholder="Default" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use request type default</SelectItem>
                    {(slas ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="sov-exec-sla">Executor SLA</FieldLabel>
                <Select
                  value={draft.executor_sla_policy_id ?? ''}
                  onValueChange={(v) => patch('executor_sla_policy_id', v || null)}
                >
                  <SelectTrigger id="sov-exec-sla"><SelectValue placeholder="Default" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Vendor / team default</SelectItem>
                    {(slas ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="sov-case-owner-policy">Case-owner policy</FieldLabel>
                <Select
                  value={draft.case_owner_policy_entity_id ?? ''}
                  onValueChange={(v) => patch('case_owner_policy_entity_id', v || null)}
                >
                  <SelectTrigger id="sov-case-owner-policy"><SelectValue placeholder="Use request type default" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use request type default</SelectItem>
                    {(caseOwnerPolicies ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.display_name}
                        {!p.current_published_version_id && (
                          <span className="ml-1 text-[10px] text-muted-foreground">(draft)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Replaces the request-type's owner-resolution policy for this scope.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="sov-child-dispatch-policy">Child-dispatch policy</FieldLabel>
                <Select
                  value={draft.child_dispatch_policy_entity_id ?? ''}
                  onValueChange={(v) => patch('child_dispatch_policy_entity_id', v || null)}
                >
                  <SelectTrigger id="sov-child-dispatch-policy"><SelectValue placeholder="Use request type default" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Use request type default</SelectItem>
                    {(childDispatchPolicies ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.display_name}
                        {!p.current_published_version_id && (
                          <span className="ml-1 text-[10px] text-muted-foreground">(draft)</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Replaces the request-type's dispatch policy for this scope.
                </FieldDescription>
              </Field>
            </div>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Schedule</FieldLegend>
            <FieldDescription>
              Optional start / end windows. Leave blank for "always on while active". Overlapping
              windows on the same scope-target are rejected at save.
            </FieldDescription>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="sov-starts">Starts at</FieldLabel>
                <Input
                  id="sov-starts"
                  type="datetime-local"
                  value={draft.starts_at?.slice(0, 16) ?? ''}
                  onChange={(e) => patch('starts_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="sov-ends">Ends at</FieldLabel>
                <Input
                  id="sov-ends"
                  type="datetime-local"
                  value={draft.ends_at?.slice(0, 16) ?? ''}
                  onChange={(e) => patch('ends_at', e.target.value ? new Date(e.target.value).toISOString() : null)}
                />
              </Field>
            </div>
            <Field orientation="horizontal">
              <Checkbox
                id="sov-active"
                checked={draft.active}
                onCheckedChange={(v) => patch('active', !!v)}
              />
              <FieldLabel htmlFor="sov-active" className="font-normal">Active</FieldLabel>
            </Field>
          </FieldSet>
        </FieldGroup>

        {!scopeValid && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>Pick a scope target (space, group, or tenant-wide).</AlertDescription>
          </Alert>
        )}
        {!handlerShapeValid && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>Handler kind and the corresponding team/vendor selection are out of sync.</AlertDescription>
          </Alert>
        )}
        {!nonEmpty && (
          <Alert variant="destructive" className="mt-3">
            <AlertDescription>Set at least one field (handler, workflow, SLA, or policy). Empty overrides are not stored.</AlertDescription>
          </Alert>
        )}

        <SheetFooter className="mt-6 flex items-center justify-between gap-2 sm:justify-between">
          {editing ? (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
              onClick={remove}
              disabled={saving}
            >
              <Trash2 className="h-4 w-4 mr-1.5" /> Remove
            </Button>
          ) : <span />}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
            <Button onClick={save} disabled={!canSave}>
              {saving ? 'Saving…' : (editing ? 'Save changes' : <><Plus className="h-4 w-4 mr-1" />Add override</>)}
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
