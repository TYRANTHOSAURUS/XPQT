import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Plus, Send, Pencil, Copy } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { emptyGraph } from '@/components/workflow-editor/graph-utils';

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
  const navigate = useNavigate();
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
    try {
      const created = await apiFetch<{ id: string }>('/workflows', {
        method: 'POST',
        body: JSON.stringify({ name, entity_type: entityType, graph_definition: emptyGraph() }),
      });
      resetForm();
      setDialogOpen(false);
      toast.success('Workflow created');
      refetch();
      navigate(`/admin/workflow-templates/${created.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Create failed');
    }
  };

  const handlePublish = async (id: string) => {
    setPublishing(id);
    try {
      await apiFetch(`/workflows/${id}/publish`, { method: 'POST' });
      toast.success('Published');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setPublishing(null);
    }
  };

  const handleClone = async (id: string) => {
    try {
      const newWf = await apiFetch<{ id: string }>(`/workflows/${id}/clone`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      toast.success('Cloned');
      refetch();
      navigate(`/admin/workflow-templates/${newWf.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Clone failed');
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
              <DialogDescription>Define a new workflow template for request processing.</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="wf-name">Name</FieldLabel>
                <Input
                  id="wf-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. IT Incident Workflow"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="wf-entity-type">Entity Type</FieldLabel>
                <Select value={entityType} onValueChange={(v) => setEntityType(v ?? 'ticket')}>
                  <SelectTrigger id="wf-entity-type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {entityTypes.map((et) => (
                      <SelectItem key={et.value} value={et.value}>{et.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={handleCreate} disabled={!name.trim()}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[120px]">Entity Type</TableHead>
            <TableHead className="w-[80px]">Version</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[180px]">Published At</TableHead>
            <TableHead className="w-[180px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={6} message="No workflows yet." />}
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
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 h-7"
                    onClick={() => navigate(`/admin/workflow-templates/${wf.id}`)}
                  >
                    <Pencil className="h-3.5 w-3.5" /> {wf.status === 'draft' ? 'Edit' : 'View'}
                  </Button>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => handleClone(wf.id)}
                        />
                      }
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Clone</TooltipContent>
                  </Tooltip>
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
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
