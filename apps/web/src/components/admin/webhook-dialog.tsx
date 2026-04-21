import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

export interface WebhookRow {
  id: string;
  name: string;
  workflow_id: string;
  token: string;
  active: boolean;
  ticket_defaults: Record<string, unknown>;
  field_mapping: Record<string, string>;
  last_received_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface WorkflowSummary {
  id: string;
  name: string;
  status: 'draft' | 'published';
}

interface WebhookDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing: WebhookRow | null;
  onSaved: () => void;
}

const DEFAULT_MAPPING = '{\n  "title": "$.title"\n}';

export function WebhookDialog({ open, onOpenChange, editing, onSaved }: WebhookDialogProps) {
  const { data: workflows } = useApi<WorkflowSummary[]>('/workflows', []);

  const [name, setName] = useState('');
  const [workflowId, setWorkflowId] = useState('');
  const [ticketDefaults, setTicketDefaults] = useState('{}');
  const [fieldMapping, setFieldMapping] = useState(DEFAULT_MAPPING);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (!editing) {
      setName('');
      setWorkflowId('');
      setTicketDefaults('{}');
      setFieldMapping(DEFAULT_MAPPING);
      return;
    }
    setName(editing.name);
    setWorkflowId(editing.workflow_id);
    setTicketDefaults(JSON.stringify(editing.ticket_defaults ?? {}, null, 2));
    setFieldMapping(JSON.stringify(editing.field_mapping ?? {}, null, 2));
  }, [open, editing]);

  const handleSave = async () => {
    let ticketDefaultsParsed: Record<string, unknown> = {};
    let fieldMappingParsed: Record<string, string> = {};
    try {
      ticketDefaultsParsed = ticketDefaults.trim() ? JSON.parse(ticketDefaults) : {};
      fieldMappingParsed = fieldMapping.trim() ? JSON.parse(fieldMapping) : {};
    } catch (e) {
      toast.error(`Invalid JSON: ${e instanceof Error ? e.message : ''}`);
      return;
    }
    const body = {
      name,
      workflow_id: workflowId,
      ticket_defaults: ticketDefaultsParsed,
      field_mapping: fieldMappingParsed,
    };
    setSaving(true);
    try {
      if (editing) {
        await apiFetch(`/workflow-webhooks/${editing.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Webhook updated');
      } else {
        await apiFetch('/workflow-webhooks', { method: 'POST', body: JSON.stringify(body) });
        toast.success('Webhook created');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save webhook');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{editing ? 'Edit Webhook' : 'Create Webhook'}</DialogTitle>
          <DialogDescription>
            Public endpoint that triggers a workflow when an external system POSTs here.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="webhook-name">Name</FieldLabel>
            <Input
              id="webhook-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Zendesk issue → incident"
            />
          </Field>

          <Field>
            <FieldLabel htmlFor="webhook-workflow">Workflow</FieldLabel>
            <Select value={workflowId} onValueChange={(v) => setWorkflowId(v ?? '')}>
              <SelectTrigger id="webhook-workflow"><SelectValue placeholder="Select a workflow" /></SelectTrigger>
              <SelectContent>
                {(workflows ?? []).map((wf) => (
                  <SelectItem key={wf.id} value={wf.id}>{wf.name} ({wf.status})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field>
            <FieldLabel htmlFor="webhook-defaults">Ticket defaults (JSON)</FieldLabel>
            <Textarea
              id="webhook-defaults"
              value={ticketDefaults}
              onChange={(e) => setTicketDefaults(e.target.value)}
              rows={4}
              className="font-mono text-xs"
              placeholder='{ "priority": "medium", "interaction_mode": "internal" }'
            />
            <FieldDescription>Fixed values applied to every ticket created from this webhook.</FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor="webhook-mapping">Field mapping (JSON — ticket field → JSONPath in payload)</FieldLabel>
            <Textarea
              id="webhook-mapping"
              value={fieldMapping}
              onChange={(e) => setFieldMapping(e.target.value)}
              rows={6}
              className="font-mono text-xs"
              placeholder='{\n  "title": "$.issue.title",\n  "description": "$.issue.body"\n}'
            />
            <FieldDescription>
              Supports <code>$.foo.bar</code> and <code>$.items[0].name</code>.
            </FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={handleSave} disabled={!name.trim() || !workflowId || saving}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
