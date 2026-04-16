import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Plus, Send } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

interface WorkflowTemplate {
  id: string;
  name: string;
  entity_type: string;
  status: 'draft' | 'published';
  version: number;
  published_at: string | null;
}

const entityTypes = [
  { value: 'ticket', label: 'Ticket' },
];

function formatDate(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function WorkflowTemplatesPage() {
  const { data, loading, refetch } = useApi<WorkflowTemplate[]>('/workflows', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState('');
  const [entityType, setEntityType] = useState('ticket');
  const [publishing, setPublishing] = useState<string | null>(null);

  const resetForm = () => {
    setName('');
    setEntityType('ticket');
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    await apiFetch('/workflows', {
      method: 'POST',
      body: JSON.stringify({ name, entity_type: entityType }),
    });
    resetForm();
    setDialogOpen(false);
    refetch();
  };

  const handlePublish = async (id: string) => {
    setPublishing(id);
    try {
      await apiFetch(`/workflows/${id}/publish`, { method: 'POST' });
      refetch();
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Workflow Templates</h1>
          <p className="text-muted-foreground mt-1">Manage workflow templates for request processing</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger render={<Button className="gap-2" onClick={() => { resetForm(); setDialogOpen(true); }} />}>
            <Plus className="h-4 w-4" /> New Workflow
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Workflow</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 mt-2">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. IT Incident Workflow"
                />
              </div>
              <div className="space-y-2">
                <Label>Entity Type</Label>
                <Select value={entityType} onValueChange={(v) => setEntityType(v ?? 'ticket')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {entityTypes.map((et) => (
                      <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button onClick={handleCreate} disabled={!name.trim()}>Create</Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="rounded-md border border-dashed border-input bg-muted/30 px-4 py-3 mb-6 text-sm text-muted-foreground">
        Visual workflow builder coming in Phase 3. For now, manage workflow templates here.
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[120px]">Entity Type</TableHead>
            <TableHead className="w-[80px]">Version</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[180px]">Published At</TableHead>
            <TableHead className="w-[120px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
          )}
          {!loading && (!data || data.length === 0) && (
            <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No workflows yet.</TableCell></TableRow>
          )}
          {(data ?? []).map((wf) => (
            <TableRow key={wf.id}>
              <TableCell className="font-medium">{wf.name}</TableCell>
              <TableCell>
                <Badge variant="outline" className="capitalize">{wf.entity_type}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground font-mono">v{wf.version}</TableCell>
              <TableCell>
                <Badge variant={wf.status === 'published' ? 'default' : 'secondary'} className="capitalize">
                  {wf.status}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{formatDate(wf.published_at)}</TableCell>
              <TableCell>
                {wf.status === 'draft' && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-7"
                    onClick={() => handlePublish(wf.id)}
                    disabled={publishing === wf.id}
                  >
                    <Send className="h-3.5 w-3.5" />
                    {publishing === wf.id ? 'Publishing...' : 'Publish'}
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
