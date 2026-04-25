import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Building2, Layers, Globe2, Tag, ChevronRight } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowValue,
} from '@/components/ui/settings-row';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useDebouncedSave } from '@/hooks/use-debounced-save';
import { cn } from '@/lib/utils';
import { useSpaces, type Space } from '@/api/spaces';
import {
  useDeleteRoomBookingRule,
  useRoomBookingRule,
  useUpdateRoomBookingRule,
  type ApprovalConfig,
  type RoomBookingRule,
  type RuleEffect,
  type TargetScope,
} from '@/api/room-booking-rules';

import { RuleRowEffectBadge } from './components/rule-row-effect-badge';
import { RuleScopeSummary } from './components/rule-scope-summary';
import { RuleEffectConfig } from './components/rule-effect-config';
import { RuleImpactPreviewCard } from './components/rule-impact-preview-card';
import { RuleTestScenarioPanel } from './components/rule-test-scenario-panel';
import { RuleVersionHistory } from './components/rule-version-history';
import {
  RuleTemplateEditorDialog,
  type RuleTemplateEditorResult,
} from './components/rule-template-editor-dialog';
import { describePredicate } from './components/predicate-describe';

/* -------------------------------------------------------------------------- */
/* Room-type registry (UI only — see notes)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The DB schema stores `target_id uuid` for `target_scope='room_type'`. The
 * resolver coerces both ends with `String()` so any string-valued id matches,
 * but the column type forces us to write a UUID. We map type-keys to fixed
 * UUIDs here so the editor surface is human-friendly while the underlying
 * column stays uuid-shaped. Phase G/Phase K may revisit with a clean
 * migration; this keeps the UI usable today.
 */
const ROOM_TYPE_OPTIONS: Array<{ key: string; label: string; uuid: string }> = [
  { key: 'meeting_room', label: 'Meeting room', uuid: 'aaaaaaaa-0000-0000-0000-000000000001' },
  { key: 'phone_booth', label: 'Phone booth', uuid: 'aaaaaaaa-0000-0000-0000-000000000002' },
  { key: 'huddle', label: 'Huddle', uuid: 'aaaaaaaa-0000-0000-0000-000000000003' },
  { key: 'boardroom', label: 'Boardroom', uuid: 'aaaaaaaa-0000-0000-0000-000000000004' },
  { key: 'training_room', label: 'Training room', uuid: 'aaaaaaaa-0000-0000-0000-000000000005' },
  { key: 'event_space', label: 'Event space', uuid: 'aaaaaaaa-0000-0000-0000-000000000006' },
];

function findRoomTypeByUuid(uuid: string | null) {
  return ROOM_TYPE_OPTIONS.find((opt) => opt.uuid === uuid) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Page shell                                                                  */
/* -------------------------------------------------------------------------- */

export function RoomBookingRuleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: rule, isLoading } = useRoomBookingRule(id);

  if (isLoading) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader backTo="/admin/room-booking-rules" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!rule || !id) {
    return (
      <SettingsPageShell width="xwide">
        <SettingsPageHeader
          backTo="/admin/room-booking-rules"
          title="Rule not found"
          description="It may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return (
    <RuleDetailBody
      rule={rule}
      onDeleted={() => navigate('/admin/room-booking-rules')}
    />
  );
}

interface RuleDetailBodyProps {
  rule: RoomBookingRule;
  onDeleted: () => void;
}

function RuleDetailBody({ rule, onDeleted }: RuleDetailBodyProps) {
  const update = useUpdateRoomBookingRule(rule.id);

  const save = (
    patch: Partial<RoomBookingRule>,
    opts: { silent?: boolean } = {},
  ) => {
    update.mutate(patch as Record<string, unknown>, {
      onSuccess: () => {
        if (!opts.silent) toast.success('Saved');
      },
      onError: (err) => toast.error(err.message || 'Save failed'),
    });
  };

  return (
    <SettingsPageShell width="xwide">
      <SettingsPageHeader
        backTo="/admin/room-booking-rules"
        title={rule.name}
        description={rule.description ?? 'Room booking rule.'}
        actions={
          <Badge variant={rule.active ? 'default' : 'secondary'}>
            {rule.active ? 'active' : 'inactive'}
          </Badge>
        }
      />

      <IdentityGroup rule={rule} save={save} />
      <ScopeGroup rule={rule} save={save} />
      <PredicateGroup rule={rule} save={save} />
      <EffectGroup rule={rule} save={save} />
      <TestGroup rule={rule} />
      <ImpactGroup rule={rule} />
      <HistoryGroup rule={rule} />
      <DangerGroup rule={rule} onDeleted={onDeleted} />
    </SettingsPageShell>
  );
}

/* -------------------------------------------------------------------------- */
/* 1 · Identity                                                                */
/* -------------------------------------------------------------------------- */

interface GroupProps {
  rule: RoomBookingRule;
  save: (patch: Partial<RoomBookingRule>, opts?: { silent?: boolean }) => void;
}

function IdentityGroup({ rule, save }: GroupProps) {
  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description ?? '');

  useEffect(() => setName(rule.name), [rule.name]);
  useEffect(() => setDescription(rule.description ?? ''), [rule.description]);

  useDebouncedSave(name, (v) => {
    if (v.trim() && v.trim() !== rule.name) save({ name: v.trim() }, { silent: true });
  });

  useDebouncedSave(description, (v) => {
    const next = v.trim() || null;
    const current = rule.description ?? null;
    if (next !== current) save({ description: next }, { silent: true });
  });

  return (
    <SettingsGroup title="Identity">
      <SettingsRow label="Name" description="Shown in lists and audit events.">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="w-[260px]" />
      </SettingsRow>
      <SettingsRow label="Description" description="Optional admin-facing note.">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-[260px]"
          placeholder="Optional"
        />
      </SettingsRow>
      <SettingsRow
        label="Active"
        description="Inactive rules are skipped by the resolver but kept on file."
      >
        <Switch
          checked={rule.active}
          onCheckedChange={(next) => save({ active: next })}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* 2 · Scope                                                                   */
/* -------------------------------------------------------------------------- */

function ScopeGroup({ rule, save }: GroupProps) {
  const [open, setOpen] = useState(false);
  const typeLabel = rule.target_scope === 'room_type'
    ? findRoomTypeByUuid(rule.target_id)?.label ?? null
    : null;

  return (
    <SettingsGroup
      title="Scope"
      description="Which rooms this rule applies to. Per-room rules take precedence over type, then subtree, then tenant."
    >
      <SettingsRow
        label="Target"
        description={summariseScope(rule.target_scope)}
        onClick={() => setOpen(true)}
      >
        <SettingsRowValue>
          <RuleScopeSummary
            target_scope={rule.target_scope}
            target_id={rule.target_id}
            typeLabel={typeLabel}
          />
        </SettingsRowValue>
      </SettingsRow>

      <ScopeDialog
        open={open}
        onOpenChange={setOpen}
        value={{ target_scope: rule.target_scope, target_id: rule.target_id }}
        onSave={(next) => {
          save({
            target_scope: next.target_scope,
            target_id: next.target_id,
          });
          setOpen(false);
        }}
      />
    </SettingsGroup>
  );
}

function summariseScope(scope: TargetScope): string {
  switch (scope) {
    case 'tenant':
      return 'Applies to every reservable room in the tenant.';
    case 'room':
      return 'Applies to one specific room.';
    case 'room_type':
      return 'Applies to every room with a specific type.';
    case 'space_subtree':
      return 'Applies to every room under a chosen space (e.g. a building or a floor).';
  }
}

interface ScopeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: { target_scope: TargetScope; target_id: string | null };
  onSave: (next: { target_scope: TargetScope; target_id: string | null }) => void;
}

function ScopeDialog({ open, onOpenChange, value, onSave }: ScopeDialogProps) {
  const [scope, setScope] = useState<TargetScope>(value.target_scope);
  const [targetId, setTargetId] = useState<string | null>(value.target_id);
  const { data: spaces } = useSpaces();

  useEffect(() => {
    if (!open) return;
    setScope(value.target_scope);
    setTargetId(value.target_id);
  }, [open, value]);

  const rooms = useMemo(
    () => (spaces ?? []).filter((s) => s.type === 'room' && s.active).sort((a, b) => a.name.localeCompare(b.name)),
    [spaces],
  );
  const subtreeRoots = useMemo(
    () =>
      (spaces ?? [])
        .filter((s) => s.type !== 'room' && s.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [spaces],
  );

  const resolvedCount = useMemo(() => resolveCount(scope, targetId, spaces ?? []), [scope, targetId, spaces]);

  const canSave = scope === 'tenant' || (typeof targetId === 'string' && targetId.length > 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Scope</DialogTitle>
          <DialogDescription>Choose which rooms this rule applies to.</DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="scope-mode">Apply to</FieldLabel>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" id="scope-mode">
              <ScopeOptionTile
                active={scope === 'tenant'}
                icon={Globe2}
                label="Tenant"
                onClick={() => {
                  setScope('tenant');
                  setTargetId(null);
                }}
              />
              <ScopeOptionTile
                active={scope === 'room'}
                icon={Building2}
                label="Specific room"
                onClick={() => {
                  setScope('room');
                  setTargetId(null);
                }}
              />
              <ScopeOptionTile
                active={scope === 'room_type'}
                icon={Tag}
                label="Room type"
                onClick={() => {
                  setScope('room_type');
                  setTargetId(null);
                }}
              />
              <ScopeOptionTile
                active={scope === 'space_subtree'}
                icon={Layers}
                label="Space subtree"
                onClick={() => {
                  setScope('space_subtree');
                  setTargetId(null);
                }}
              />
            </div>
          </Field>

          {scope === 'room' && (
            <Field>
              <FieldLabel htmlFor="scope-room">Room</FieldLabel>
              <Select<string> value={targetId ?? ''} onValueChange={(v) => setTargetId(v)}>
                <SelectTrigger id="scope-room">
                  <SelectValue placeholder="Pick a room…" />
                </SelectTrigger>
                <SelectContent>
                  {rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Only this room is affected.</FieldDescription>
            </Field>
          )}

          {scope === 'space_subtree' && (
            <Field>
              <FieldLabel htmlFor="scope-subtree">Subtree root</FieldLabel>
              <Select<string> value={targetId ?? ''} onValueChange={(v) => setTargetId(v)}>
                <SelectTrigger id="scope-subtree">
                  <SelectValue placeholder="Pick a building, floor, or zone…" />
                </SelectTrigger>
                <SelectContent>
                  {subtreeRoots.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name} <span className="text-xs text-muted-foreground">{s.type}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>Every reservable room under this node.</FieldDescription>
            </Field>
          )}

          {scope === 'room_type' && (
            <Field>
              <FieldLabel htmlFor="scope-roomtype">Room type</FieldLabel>
              <Select<string> value={targetId ?? ''} onValueChange={(v) => setTargetId(v)}>
                <SelectTrigger id="scope-roomtype">
                  <SelectValue placeholder="Pick a room type…" />
                </SelectTrigger>
                <SelectContent>
                  {ROOM_TYPE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.uuid} value={opt.uuid}>
                      {opt.label} <span className="text-xs text-muted-foreground">{opt.key}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                Stored as a fixed UUID per type. The schema column is uuid-typed today; a follow-up migration
                will convert this to a clean type-key string.
              </FieldDescription>
            </Field>
          )}

          <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Resolved set: <span className="font-medium text-foreground">{resolvedCount}</span>
          </div>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => canSave && onSave({ target_scope: scope, target_id: targetId })} disabled={!canSave}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeOptionTile({
  active,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-col items-center gap-1.5 rounded-lg border bg-card p-3 text-center transition-colors',
        'hover:bg-muted/40',
        active && 'border-foreground/30 bg-muted/40 ring-1 ring-foreground/10',
      )}
      style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );
}

function resolveCount(
  scope: TargetScope,
  targetId: string | null,
  spaces: Space[],
): string {
  if (scope === 'tenant') {
    const rooms = spaces.filter((s) => s.type === 'room');
    return `${rooms.length} ${rooms.length === 1 ? 'room' : 'rooms'} in tenant`;
  }
  if (scope === 'room') {
    if (!targetId) return 'Pick a room.';
    const space = spaces.find((s) => s.id === targetId);
    return space ? `Just "${space.name}"` : '1 room';
  }
  if (scope === 'space_subtree') {
    if (!targetId) return 'Pick a subtree root.';
    const root = spaces.find((s) => s.id === targetId);
    if (!root) return 'Subtree not found.';
    return `Every room under "${root.name}"`;
  }
  if (scope === 'room_type') {
    if (!targetId) return 'Pick a room type.';
    const opt = findRoomTypeByUuid(targetId);
    return opt ? `Every "${opt.label}" room` : 'A specific room type';
  }
  return '';
}

/* -------------------------------------------------------------------------- */
/* 3 · Predicate                                                               */
/* -------------------------------------------------------------------------- */

function PredicateGroup({ rule, save }: GroupProps) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => describePredicate(rule.applies_when), [rule.applies_when]);

  const initialTemplate = useMemo(() => {
    if (!rule.template_id) return null;
    return {
      template_id: rule.template_id,
      params: (rule.template_params ?? {}) as Record<string, unknown>,
    };
  }, [rule.template_id, rule.template_params]);

  return (
    <SettingsGroup
      title="When this applies"
      description="The condition that must be true for the rule's effect to fire."
    >
      <SettingsRow
        label="Predicate"
        description={summary || 'No condition yet.'}
        onClick={() => setOpen(true)}
      >
        <SettingsRowValue>Edit</SettingsRowValue>
      </SettingsRow>
      {rule.template_id && (
        <SettingsRow label="Source" description="Template-authored. Edits stay template-aware where possible.">
          <SettingsRowValue>
            <code className="chip text-xs">{rule.template_id}</code>
          </SettingsRowValue>
        </SettingsRow>
      )}

      <RuleTemplateEditorDialog
        open={open}
        onOpenChange={setOpen}
        initialPredicate={rule.applies_when}
        initialTemplate={initialTemplate}
        mode="edit"
        onSave={(result) => handlePredicateSave(rule, save, result, () => setOpen(false))}
      />
    </SettingsGroup>
  );
}

function handlePredicateSave(
  rule: RoomBookingRule,
  save: (patch: Partial<RoomBookingRule>, opts?: { silent?: boolean }) => void,
  result: RuleTemplateEditorResult,
  close: () => void,
) {
  // Editing a template-authored rule: re-save with both template_id+params and
  // applies_when. We don't recompile client-side; the API also accepts a raw
  // `applies_when` patch and stores `template_id`/`template_params` for the
  // editor's next open. (The backend's /from-template endpoint is the canonical
  // compile path; for an in-place edit we round-trip the params and let the
  // server normalise on the next read.)
  if (result.fromTemplate) {
    save({
      template_id: result.fromTemplate.template_id,
      template_params: result.fromTemplate.params,
      // applies_when is the persisted predicate — keep it consistent with the
      // editor by sending what we know. The service trusts template_id+params
      // and recompiles on read where needed.
      applies_when: result.applies_when,
      ...(result.suggested_effect && rule.effect === 'deny' && rule.template_id !== result.fromTemplate.template_id
        ? { effect: result.suggested_effect }
        : {}),
    });
    close();
    return;
  }
  // Raw path
  save({
    applies_when: result.applies_when,
    template_id: null,
    template_params: null,
  });
  close();
}

/* -------------------------------------------------------------------------- */
/* 4 · Effect                                                                  */
/* -------------------------------------------------------------------------- */

function EffectGroup({ rule, save }: GroupProps) {
  return (
    <SettingsGroup
      title="Effect"
      description="What happens when the predicate fires. Auto-saves on change."
    >
      <div className="px-4 py-4">
        <RuleEffectConfig
          effect={rule.effect}
          approval_config={rule.approval_config}
          denial_message={rule.denial_message}
          onEffectChange={(next) => save({ effect: next as RuleEffect })}
          onApprovalConfigChange={(next: ApprovalConfig | null) => save({ approval_config: next })}
          onDenialMessageChange={(next) => save({ denial_message: next })}
        />
      </div>
      <div className="border-t bg-muted/20 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <ChevronRight className="size-3.5" />
          Current effect:
          <RuleRowEffectBadge effect={rule.effect} />
          <span className="text-muted-foreground">
            on predicate{' '}
            <code className="chip text-[11px]">{describePredicate(rule.applies_when)}</code>
          </span>
        </div>
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* 5 · Test                                                                    */
/* -------------------------------------------------------------------------- */

function TestGroup({ rule }: { rule: RoomBookingRule }) {
  return (
    <SettingsGroup
      title="Test"
      description="Run this rule against a saved or ad-hoc booking scenario before publishing changes."
    >
      <div className="px-4 py-4">
        <RuleTestScenarioPanel ruleId={rule.id} />
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* 6 · Impact preview                                                          */
/* -------------------------------------------------------------------------- */

function ImpactGroup({ rule }: { rule: RoomBookingRule }) {
  return (
    <SettingsGroup
      title="Impact preview"
      description="Last 30 days of bookings replayed against this rule. Auto-runs on open."
    >
      <div className="px-4 py-4">
        <RuleImpactPreviewCard ruleId={rule.id} />
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* 7 · History                                                                 */
/* -------------------------------------------------------------------------- */

function HistoryGroup({ rule }: { rule: RoomBookingRule }) {
  return (
    <SettingsGroup title="History" description="Every save creates a new version. Restore at will.">
      <div className="px-4 py-4">
        <RuleVersionHistory ruleId={rule.id} />
      </div>
    </SettingsGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* 8 · Danger zone                                                             */
/* -------------------------------------------------------------------------- */

function DangerGroup({
  rule,
  onDeleted,
}: {
  rule: RoomBookingRule;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const del = useDeleteRoomBookingRule();

  return (
    <SettingsGroup title="Danger zone">
      <SettingsRow
        label="Soft delete rule"
        description="Marks the rule inactive and hides it from lists. The audit trail is kept; restore via History."
      >
        <Button
          variant="outline"
          size="sm"
          className={cn(buttonVariants({ variant: 'destructive' }), 'h-8 px-3')}
          onClick={() => setOpen(true)}
        >
          Delete
        </Button>
      </SettingsRow>

      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Delete "${rule.name}"?`}
        description="The rule will be deactivated and removed from the resolver. Existing bookings are unaffected. You can restore it from the History group."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          await del.mutateAsync(rule.id);
          toast.success('Rule deleted');
          onDeleted();
        }}
      />
    </SettingsGroup>
  );
}

