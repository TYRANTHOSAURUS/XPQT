import { useState } from 'react';
import { toast } from 'sonner';
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

interface AddWorkOrderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parentId: string;
  parentPriority: string;
  teamOptions: EntityOption[];
  userOptions: EntityOption[];
  vendorOptions: EntityOption[];
  /** Called after a successful dispatch so the parent can refresh the children list and the ticket. */
  onDispatched: () => void;
}

type AssignTab = 'team' | 'user' | 'vendor';

const PRIORITIES: Array<{ value: string; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export function AddWorkOrderDialog({
  open,
  onOpenChange,
  parentId,
  parentPriority,
  teamOptions,
  userOptions,
  vendorOptions,
  onDispatched,
}: AddWorkOrderDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(parentPriority);
  const [tab, setTab] = useState<AssignTab>('team');
  const [teamId, setTeamId] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [vendorId, setVendorId] = useState<string | null>(null);

  const [titleError, setTitleError] = useState<string | null>(null);
  const [assigneeError, setAssigneeError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const { dispatch, submitting } = useDispatchWorkOrder(parentId);

  function reset() {
    setTitle(''); setDescription(''); setPriority(parentPriority);
    setTab('team'); setTeamId(null); setUserId(null); setVendorId(null);
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

  async function onSubmit() {
    setTitleError(null); setAssigneeError(null); setFormError(null);
    const trimmed = title.trim();
    if (!trimmed) { setTitleError('Title is required'); return; }

    const selectedId = tab === 'team' ? teamId : tab === 'user' ? userId : vendorId;
    if (!selectedId) { setAssigneeError('Pick an assignee'); return; }

    try {
      await dispatch({
        title: trimmed,
        description: description.trim() || undefined,
        priority,
        assigned_team_id: tab === 'team' ? selectedId : undefined,
        assigned_user_id: tab === 'user' ? selectedId : undefined,
        assigned_vendor_id: tab === 'vendor' ? selectedId : undefined,
      });
      toast.success(`Work order "${trimmed}" added`);
      onDispatched();
      reset();
      onOpenChange(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to add work order';
      setFormError(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!submitting) onOpenChange(next); if (!next) reset(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add work order</DialogTitle>
          <DialogDescription>
            Send a piece of this case to a vendor, team, or teammate. They get their own ticket with its own SLA.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="wo-title">Title</FieldLabel>
            <Input
              id="wo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Replace broken pane"
              disabled={submitting}
            />
            {titleError && <FieldError>{titleError}</FieldError>}
          </Field>

          <Field>
            <FieldLabel htmlFor="wo-description">Description</FieldLabel>
            <Textarea
              id="wo-description"
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
            <FieldDescription>
              Switching tabs clears the other tabs' selections — only one assignee is submitted.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="wo-priority">Priority</FieldLabel>
            <Select value={priority} onValueChange={(v) => { if (v != null) setPriority(v); }} disabled={submitting}>
              <SelectTrigger id="wo-priority"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PRIORITIES.map((p) => (
                  <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>Defaults to the parent case's priority.</FieldDescription>
          </Field>

          {formError && (
            <p className="text-sm text-destructive" role="alert">{formError}</p>
          )}
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          <Button onClick={onSubmit} disabled={submitting}>
            {submitting ? 'Adding…' : 'Add work order'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
