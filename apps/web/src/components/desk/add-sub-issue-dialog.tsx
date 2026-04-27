import { useMemo, useState } from 'react';
import { toastSuccess } from '@/lib/toast';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Field, FieldDescription, FieldError, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { EntityPicker, EntityOption } from '@/components/desk/editors/entity-picker';
import { useDispatchWorkOrder } from '@/hooks/use-work-orders';
import { useSlaPolicies } from '@/api/sla-policies';
import { useVendors } from '@/api/vendors';
import { useTeams } from '@/api/teams';

interface AddSubIssueDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string;
  parentPriority: string;
  teamOptions: EntityOption[];
  userOptions: EntityOption[];
  vendorOptions: EntityOption[];
  onDispatched: () => void;
}

type AssignTab = 'team' | 'user' | 'vendor';

const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

// Sentinel string used by the SLA Select; mapped to dto.sla_id = null on submit.
const SLA_NONE = 'none';
// Empty string represents "inherit from default" (dto.sla_id = undefined on submit).
const SLA_INHERIT = '';

export function AddSubIssueDialog({
  open,
  onOpenChange,
  parentId,
  parentPriority,
  teamOptions,
  userOptions,
  vendorOptions,
  onDispatched,
}: AddSubIssueDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(parentPriority);
  const [tab, setTab] = useState<AssignTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);
  const [slaSelection, setSlaSelection] = useState<string>(SLA_INHERIT);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { data: slaPolicies } = useSlaPolicies();
  const { data: vendorsWithDefaults } = useVendors();
  const { data: teamsWithDefaults } = useTeams();

  const { dispatch, submitting } = useDispatchWorkOrder(parentId);

  function reset() {
    setTitle(''); setDescription(''); setPriority(parentPriority);
    setTab('team'); setTeamId(null); setUserId(null); setVendorId(null);
    setSlaSelection(SLA_INHERIT);
    setTitleError(null); setAssigneeError(null); setFormError(null);
  }

  function onTabChange(next: string) {
    const t = next as AssignTab;
    setTab(t);
    if (t !== 'team') setTeamId(null);
    if (t !== 'user') setUserId(null);
    if (t !== 'vendor') setVendorId(null);
    setAssigneeError(null);
  }

  // Hint shown under the SLA picker — reflects what the server will resolve if user leaves it empty.
  const inheritedSlaHint = useMemo(() => {
    if (slaSelection !== SLA_INHERIT) return null;
    const policyName = (id: string | null) => slaPolicies?.find((p) => p.id === id)?.name ?? null;

    if (tab === 'vendor' && vendorId) {
      const v = vendorsWithDefaults?.find((x) => x.id === vendorId);
      const name = policyName(v?.default_sla_policy_id ?? null);
      return name ? `Will inherit from vendor: ${name}` : 'No SLA will run on this sub-issue';
    }
    if (tab === 'team' && teamId) {
      const t = teamsWithDefaults?.find((x) => x.id === teamId);
      const name = policyName(t?.default_sla_policy_id ?? null);
      return name ? `Will inherit from team: ${name}` : 'No SLA will run on this sub-issue';
    }
    if (tab === 'user' && userId) {
      // Server falls through user → user.team → team default. Without a team-membership
      // lookup here we just say "from the user's team if set".
      return 'Will inherit from the assignee\'s team default if set';
    }
    return 'Pick an assignee to see the inherited default';
  }, [slaSelection, tab, vendorId, teamId, userId, vendorsWithDefaults, teamsWithDefaults, slaPolicies]);

  async function onSubmit() {
    setTitleError(null); setAssigneeError(null); setFormError(null);
    const trimmed = title.trim();
    if (!trimmed) { setTitleError('Title is required'); return; }

    const selectedId = tab === 'team' ? teamId : tab === 'user' ? userId : vendorId;
    if (!selectedId) { setAssigneeError('Pick an assignee'); return; }

    // Map SLA picker value to DTO shape.
    let slaPayload: { sla_id?: string | null } = {};
    if (slaSelection === SLA_NONE) slaPayload = { sla_id: null };
    else if (slaSelection !== SLA_INHERIT) slaPayload = { sla_id: slaSelection };

    try {
      await dispatch({
        title: trimmed,
        description: description.trim() || undefined,
        priority,
        assigned_team_id: tab === 'team' ? selectedId : undefined,
        assigned_user_id: tab === 'user' ? selectedId : undefined,
        assigned_vendor_id: tab === 'vendor' ? selectedId : undefined,
        ...slaPayload,
      });
      toastSuccess(`Sub-issue "${trimmed}" added`);
      onDispatched();
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add sub-issue';
      setFormError(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add sub-issue</DialogTitle>
          <DialogDescription>
            Send a piece of this case to a vendor, team, or teammate. They get their own ticket with its own SLA.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="si-title">Title</FieldLabel>
            <Input
              id="si-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Replace broken pane"
              disabled={submitting}
            />
            {titleError && <FieldError>{titleError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="si-description">Description</FieldLabel>
            <Textarea
              id="si-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional details the assignee should know"
              rows={3}
              disabled={submitting}
            />
          </Field>

          <Field>
            <FieldLabel>Assignee</FieldLabel>
            <Tabs value={tab} onValueChange={onTabChange}>
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="team">Team</TabsTrigger>
                <TabsTrigger value="user">User</TabsTrigger>
                <TabsTrigger value="vendor">Vendor</TabsTrigger>
              </TabsList>
              <TabsContent value="team" className="pt-2">
                <EntityPicker
                  value={teamId}
                  options={teamOptions}
                  placeholder="team"
                  clearLabel="Clear team"
                  onChange={(opt) => setTeamId(opt?.id ?? null)}
                />
              </TabsContent>
              <TabsContent value="user" className="pt-2">
                <EntityPicker
                  value={userId}
                  options={userOptions}
                  placeholder="user"
                  clearLabel="Clear user"
                  onChange={(opt) => setUserId(opt?.id ?? null)}
                />
              </TabsContent>
              <TabsContent value="vendor" className="pt-2">
                <EntityPicker
                  value={vendorId}
                  options={vendorOptions}
                  placeholder="vendor"
                  clearLabel="Clear vendor"
                  onChange={(opt) => setVendorId(opt?.id ?? null)}
                />
              </TabsContent>
            </Tabs>
            {assigneeError && <FieldError>{assigneeError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="si-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={(v) => { if (v != null) setPriority(v); }} disabled={submitting}>
              <SelectTrigger id="si-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Defaults to the parent case's priority.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="si-sla">SLA policy</FieldLabel>
            <Select
              value={slaSelection}
              onValueChange={(v) => setSlaSelection(v ?? SLA_INHERIT)}
              disabled={submitting}
            >
              <SelectTrigger id="si-sla"><SelectValue placeholder="Inherit from default" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={SLA_INHERIT}>Inherit from default</SelectItem>
                <SelectItem value={SLA_NONE}>No SLA</SelectItem>
                {(slaPolicies ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {inheritedSlaHint && <FieldDescription>{inheritedSlaHint}</FieldDescription>}
          </Field>

          {formError && (
            <p className="text-sm text-destructive" role="alert">{formError}</p>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add sub-issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
