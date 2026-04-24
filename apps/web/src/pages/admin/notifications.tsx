import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Plus, Pencil, Mail, Bell } from 'lucide-react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useNotificationTemplates, notificationKeys } from '@/api/notifications';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';

interface NotificationTemplate {
  id: string;
  name: string;
  event_type: string;
  subject: string;
  body: string;
  channels: ('email' | 'in_app')[];
}

const eventTypes = [
  { value: 'ticket_created', label: 'Ticket Created' },
  { value: 'ticket_assigned', label: 'Ticket Assigned' },
  { value: 'ticket_status_changed', label: 'Ticket Status Changed' },
  { value: 'ticket_resolved', label: 'Ticket Resolved' },
  { value: 'approval_requested', label: 'Approval Requested' },
  { value: 'approval_approved', label: 'Approval Approved' },
  { value: 'approval_rejected', label: 'Approval Rejected' },
  { value: 'sla_breach', label: 'SLA Breach' },
  { value: 'sla_at_risk', label: 'SLA At Risk' },
  { value: 'visitor_checked_in', label: 'Visitor Checked In' },
];

const AVAILABLE_TOKENS = [
  '{{ticket.title}}',
  '{{ticket.description}}',
  '{{requester.name}}',
  '{{assignee.name}}',
  '{{team.name}}',
  '{{sla.time_remaining}}',
];

export function NotificationsPage() {
  const qc = useQueryClient();
  const { data, isPending: loading } = useNotificationTemplates() as { data: NotificationTemplate[] | undefined; isPending: boolean };
  const refetch = () => qc.invalidateQueries({ queryKey: notificationKeys.all });

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [eventType, setEventType] = useState('ticket_created');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(true);
  const [inAppEnabled, setInAppEnabled] = useState(true);

  const resetForm = () => {
    setEditId(null);
    setName('');
    setEventType('ticket_created');
    setSubject('');
    setBody('');
    setEmailEnabled(true);
    setInAppEnabled(true);
  };

  const getChannels = (): ('email' | 'in_app')[] => {
    const ch: ('email' | 'in_app')[] = [];
    if (emailEnabled) ch.push('email');
    if (inAppEnabled) ch.push('in_app');
    return ch;
  };

  const handleSave = async () => {
    if (!name.trim()) return;
    const dto = {
      name,
      event_type: eventType,
      subject,
      body,
      channels: getChannels(),
    };
    try {
      if (editId) {
        await apiFetch(`/notification-templates/${editId}`, { method: 'PATCH', body: JSON.stringify(dto) });
        toast.success('Notification template updated');
      } else {
        await apiFetch('/notification-templates', { method: 'POST', body: JSON.stringify(dto) });
        toast.success('Notification template created');
      }
      resetForm();
      setDialogOpen(false);
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save notification template');
    }
  };

  const openEdit = (tmpl: NotificationTemplate) => {
    setEditId(tmpl.id);
    setName(tmpl.name);
    setEventType(tmpl.event_type);
    setSubject(tmpl.subject);
    setBody(tmpl.body);
    setEmailEnabled(tmpl.channels?.includes('email') ?? true);
    setInAppEnabled(tmpl.channels?.includes('in_app') ?? true);
    setDialogOpen(true);
  };

  const openCreate = () => {
    resetForm();
    setDialogOpen(true);
  };

  const getEventLabel = (val: string) =>
    eventTypes.find((e) => e.value === val)?.label ?? val;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Notification Templates</h1>
          <p className="text-muted-foreground mt-1">Configure automated notifications sent on platform events</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={openCreate} />}>
            <Plus className="h-4 w-4" /> Add Template
          </DialogTrigger>
          <DialogContent className="sm:max-w-[580px]">
            <DialogHeader>
              <DialogTitle>{editId ? 'Edit' : 'Create'} Notification Template</DialogTitle>
              <DialogDescription>Configure the message sent when this event fires.</DialogDescription>
            </DialogHeader>
            <ScrollArea className="max-h-[72vh] pr-3">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="notif-name">Name</FieldLabel>
                <Input
                  id="notif-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Ticket Assigned Notification"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="notif-event">Event Type</FieldLabel>
                <Select value={eventType} onValueChange={(v) => setEventType(v ?? 'ticket_created')}>
                  <SelectTrigger id="notif-event"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {eventTypes.map((e) => (
                      <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="notif-subject">Subject</FieldLabel>
                <Input
                  id="notif-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder='Use tokens like {{ticket.title}}'
                />
                <FieldDescription>Use tokens like {'{{ticket.title}}'}</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="notif-body">Body</FieldLabel>
                <Textarea
                  id="notif-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={`Hi {{requester.name}},\n\nYour request "{{ticket.title}}" has been updated.\n\nThank you.`}
                  className="h-36 resize-none font-mono text-sm"
                />
                <FieldDescription>Available tokens: {AVAILABLE_TOKENS.join(', ')}</FieldDescription>
              </Field>

              <FieldSet>
                <FieldLegend variant="label">Channels</FieldLegend>
                <FieldGroup data-slot="checkbox-group" className="flex-row gap-4">
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notif-email"
                      checked={emailEnabled}
                      onCheckedChange={(c) => setEmailEnabled(c === true)}
                    />
                    <FieldLabel htmlFor="notif-email" className="font-normal flex items-center gap-1">
                      <Mail className="h-3.5 w-3.5" /> Email
                    </FieldLabel>
                  </Field>
                  <Field orientation="horizontal">
                    <Checkbox
                      id="notif-in-app"
                      checked={inAppEnabled}
                      onCheckedChange={(c) => setInAppEnabled(c === true)}
                    />
                    <FieldLabel htmlFor="notif-in-app" className="font-normal flex items-center gap-1">
                      <Bell className="h-3.5 w-3.5" /> In-app
                    </FieldLabel>
                  </Field>
                </FieldGroup>
              </FieldSet>
            </FieldGroup>
            </ScrollArea>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleSave} disabled={!name.trim()}>
                {editId ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[180px]">Event Type</TableHead>
            <TableHead className="w-[140px]">Channels</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No notification templates yet." />}
          {(data ?? []).map((tmpl) => (
            <TableRow key={tmpl.id}>
              <TableCell className="font-medium">{tmpl.name}</TableCell>
              <TableCell className="text-muted-foreground text-sm">{getEventLabel(tmpl.event_type)}</TableCell>
              <TableCell>
                <div className="flex gap-1">
                  {(tmpl.channels ?? []).map((ch) => (
                    <Badge key={ch} variant="outline" className="text-xs gap-1">
                      {ch === 'email' ? <Mail className="h-2.5 w-2.5" /> : <Bell className="h-2.5 w-2.5" />}
                      {ch === 'email' ? 'Email' : 'In-app'}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(tmpl)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
