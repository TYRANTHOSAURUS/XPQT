import { useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Copy, RotateCw, Trash2, Power, PowerOff } from 'lucide-react';

interface Webhook {
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

const WEBHOOK_URL_BASE = `${window.location.origin}/api/webhooks`;

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

export function WebhooksPage() {
  const { data, loading, refetch } = useApi<Webhook[]>('/workflow-webhooks', []);
  const { data: workflows } = useApi<WorkflowSummary[]>('/workflows', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    workflow_id: string;
    ticket_defaults: string;
    field_mapping: string;
  }>({ name: '', workflow_id: '', ticket_defaults: '{}', field_mapping: '{\n  "title": "$.title"\n}' });

  const reset = () => setForm({ name: '', workflow_id: '', ticket_defaults: '{}', field_mapping: '{\n  "title": "$.title"\n}' });

  const copyUrl = (token: string) => {
    navigator.clipboard.writeText(`${WEBHOOK_URL_BASE}/${token}`);
    toast.success('URL copied');
  };

  const handleCreate = async () => {
    let ticketDefaults: Record<string, unknown> = {};
    let fieldMapping: Record<string, string> = {};
    try {
      ticketDefaults = form.ticket_defaults.trim() ? JSON.parse(form.ticket_defaults) : {};
      fieldMapping = form.field_mapping.trim() ? JSON.parse(form.field_mapping) : {};
    } catch (e) {
      toast.error(`Invalid JSON: ${e instanceof Error ? e.message : ''}`);
      return;
    }
    try {
      await apiFetch('/workflow-webhooks', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          workflow_id: form.workflow_id,
          ticket_defaults: ticketDefaults,
          field_mapping: fieldMapping,
        }),
      });
      toast.success('Webhook created');
      setDialogOpen(false);
      reset();
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Create failed');
    }
  };

  const toggleActive = async (wh: Webhook) => {
    try {
      await apiFetch(`/workflow-webhooks/${wh.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !wh.active }),
      });
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  };

  const rotate = async (id: string) => {
    if (!confirm('Rotating the token invalidates the current URL. Continue?')) return;
    try {
      await apiFetch(`/workflow-webhooks/${id}/rotate-token`, { method: 'POST' });
      toast.success('Token rotated');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rotate failed');
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Delete this webhook? This cannot be undone.')) return;
    try {
      await apiFetch(`/workflow-webhooks/${id}`, { method: 'DELETE' });
      toast.success('Deleted');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const workflowNameById = (id: string) => workflows?.find((w) => w.id === id)?.name ?? '—';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
          <p className="text-muted-foreground mt-1">Public endpoints that trigger a workflow when an external system POSTs here.</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) reset(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={() => { reset(); setDialogOpen(true); }} />}>
            <Plus className="h-4 w-4" /> New Webhook
          </DialogTrigger>
          <DialogContent className="max-w-[560px]">
            <DialogHeader>
              <DialogTitle>Create Webhook</DialogTitle>
            </DialogHeader>
            <div className="grid gap-3 mt-2">
              <div className="grid gap-1.5">
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Zendesk issue → incident" />
              </div>
              <div className="grid gap-1.5">
                <Label>Workflow</Label>
                <Select value={form.workflow_id} onValueChange={(v) => setForm({ ...form, workflow_id: v ?? '' })}>
                  <SelectTrigger><SelectValue placeholder="Select a workflow" /></SelectTrigger>
                  <SelectContent>
                    {(workflows ?? []).map((wf) => (
                      <SelectItem key={wf.id} value={wf.id}>{wf.name} ({wf.status})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Ticket defaults (JSON)</Label>
                <Textarea
                  value={form.ticket_defaults}
                  onChange={(e) => setForm({ ...form, ticket_defaults: e.target.value })}
                  rows={4}
                  className="font-mono text-xs"
                  placeholder='{ "priority": "medium", "interaction_mode": "internal" }'
                />
                <p className="text-[10px] text-muted-foreground">Fixed values applied to every ticket created from this webhook.</p>
              </div>
              <div className="grid gap-1.5">
                <Label>Field mapping (JSON — ticket field → JSONPath in payload)</Label>
                <Textarea
                  value={form.field_mapping}
                  onChange={(e) => setForm({ ...form, field_mapping: e.target.value })}
                  rows={6}
                  className="font-mono text-xs"
                  placeholder='{\n  "title": "$.issue.title",\n  "description": "$.issue.body"\n}'
                />
                <p className="text-[10px] text-muted-foreground">Supports <code>$.foo.bar</code> and <code>$.items[0].name</code>.</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!form.name.trim() || !form.workflow_id}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead>URL</TableHead>
            <TableHead className="w-[180px]">Last received</TableHead>
            <TableHead className="w-[180px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No webhooks yet.</TableCell></TableRow>
          )}
          {(data ?? []).map((wh) => (
            <TableRow key={wh.id}>
              <TableCell className="font-medium">{wh.name}</TableCell>
              <TableCell className="text-sm text-muted-foreground">{workflowNameById(wh.workflow_id)}</TableCell>
              <TableCell>
                <Badge variant={wh.active ? 'default' : 'secondary'}>{wh.active ? 'active' : 'disabled'}</Badge>
              </TableCell>
              <TableCell>
                <button onClick={() => copyUrl(wh.token)} className="font-mono text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 max-w-[280px] truncate">
                  <Copy className="h-3 w-3 shrink-0" />
                  <span className="truncate">{WEBHOOK_URL_BASE}/{wh.token.slice(0, 12)}…</span>
                </button>
                {wh.last_error && <div className="text-[10px] text-red-600 mt-0.5">Last error: {wh.last_error}</div>}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(wh.last_received_at)}</TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => toggleActive(wh)} title={wh.active ? 'Disable' : 'Enable'}>
                    {wh.active ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => rotate(wh.id)} title="Rotate token">
                    <RotateCw className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-red-600" onClick={() => remove(wh.id)} title="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
