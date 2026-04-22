import { useState } from 'react';
import { toast } from 'sonner';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { WebhookDialog, type WebhookRow } from '@/components/admin/webhook-dialog';
import { Plus, Copy, RotateCw, Trash2, Power, PowerOff, Pencil } from 'lucide-react';

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
  const { data, loading, refetch } = useApi<WebhookRow[]>('/workflow-webhooks', []);
  const { data: workflows } = useApi<WorkflowSummary[]>('/workflows', []);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WebhookRow | null>(null);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (wh: WebhookRow) => {
    setEditing(wh);
    setDialogOpen(true);
  };

  const copyUrl = (token: string) => {
    navigator.clipboard.writeText(`${WEBHOOK_URL_BASE}/${token}`);
    toast.success('URL copied');
  };

  const toggleActive = async (wh: WebhookRow) => {
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

  const [pendingAction, setPendingAction] = useState<
    { kind: 'rotate' | 'delete'; id: string } | null
  >(null);

  const rotate = async (id: string) => {
    try {
      await apiFetch(`/workflow-webhooks/${id}/rotate-token`, { method: 'POST' });
      toast.success('Token rotated');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rotate failed');
    }
  };

  const remove = async (id: string) => {
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
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New Webhook
        </Button>
      </div>

      <WebhookDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        onSaved={refetch}
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Workflow</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead>URL</TableHead>
            <TableHead className="w-[180px]">Last received</TableHead>
            <TableHead className="w-[200px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={6} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={6} message="No webhooks yet." />}
          {(data ?? []).map((wh) => (
            <TableRow key={wh.id}>
              <TableCell className="font-medium">
                <button
                  className="text-left hover:underline underline-offset-2"
                  onClick={() => openEdit(wh)}
                >
                  {wh.name}
                </button>
              </TableCell>
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
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => openEdit(wh)}
                        />
                      }
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Edit</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => toggleActive(wh)}
                        />
                      }
                    >
                      {wh.active ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
                    </TooltipTrigger>
                    <TooltipContent>{wh.active ? 'Disable' : 'Enable'}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0"
                          onClick={() => setPendingAction({ kind: 'rotate', id: wh.id })}
                        />
                      }
                    >
                      <RotateCw className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Rotate token</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 p-0 text-red-600"
                          onClick={() => setPendingAction({ kind: 'delete', id: wh.id })}
                        />
                      }
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </TooltipTrigger>
                    <TooltipContent>Delete</TooltipContent>
                  </Tooltip>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <ConfirmDialog
        open={pendingAction?.kind === 'rotate'}
        onOpenChange={(open) => { if (!open) setPendingAction(null); }}
        title="Rotate webhook token"
        description="Rotating the token invalidates the current URL. Continue?"
        confirmLabel="Rotate"
        onConfirm={async () => {
          if (pendingAction?.kind === 'rotate') await rotate(pendingAction.id);
        }}
      />

      <ConfirmDialog
        open={pendingAction?.kind === 'delete'}
        onOpenChange={(open) => { if (!open) setPendingAction(null); }}
        title="Delete webhook"
        description="This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={async () => {
          if (pendingAction?.kind === 'delete') await remove(pendingAction.id);
        }}
      />
    </div>
  );
}
