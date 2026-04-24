import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ReactFlowProvider } from 'reactflow';
import { toast } from 'sonner';
import { useWorkflow, useWorkflowMutations } from '@/hooks/use-workflow';
import { useGraphStore } from '@/components/workflow-editor/graph-store';
import { Canvas } from '@/components/workflow-editor/canvas';
import { Palette } from '@/components/workflow-editor/palette';
import { Inspector } from '@/components/workflow-editor/inspector';
import { Toolbar } from '@/components/workflow-editor/toolbar';
import { useKeyboardShortcuts } from '@/components/workflow-editor/use-keyboard-shortcuts';
import { validate } from '@/components/workflow-editor/validation';
import { SimulatePanel } from '@/components/workflow-editor/simulate-panel';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

export function WorkflowEditorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: wf, isPending: loading, refetch } = useWorkflow(id);
  const { saveGraph, publish, unpublish, simulate } = useWorkflowMutations(id);

  const setGraph = useGraphStore((s) => s.setGraph);
  const toJSON = useGraphStore((s) => s.toJSON);
  const markSaved = useGraphStore((s) => s.markSaved);
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const dirty = useGraphStore((s) => s.dirty);

  const [saving, setSaving] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  const [simOpen, setSimOpen] = useState(false);
  const [unpublishOpen, setUnpublishOpen] = useState(false);

  useEffect(() => {
    if (wf) setGraph(wf.graph_definition ?? { nodes: [], edges: [] });
  }, [wf, setGraph]);

  const readOnly = wf?.status === 'published';

  // Autosave: debounce 2s after last change
  useEffect(() => {
    if (!dirty || readOnly) return;
    const t = setTimeout(() => {
      saveGraph(toJSON()).then(() => markSaved()).catch(() => { /* user can still manually save */ });
    }, 2000);
    return () => clearTimeout(t);
  }, [nodes, edges, dirty, readOnly, saveGraph, toJSON, markSaved]);

  // Warn on unload if there are unsaved changes
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGraph(toJSON());
      markSaved();
      toast.success('Saved');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    const errs = validate(toJSON());
    if (errs.length > 0) { setErrorsOpen(true); return; }
    setSaving(true);
    try {
      await saveGraph(toJSON());
      await publish();
      toast.success('Published');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Publish failed');
    } finally {
      setSaving(false);
    }
  };

  const doUnpublish = async () => {
    try {
      await unpublish();
      toast.success('Unpublished');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unpublish failed');
    }
  };

  const handleUnpublish = () => setUnpublishOpen(true);

  useKeyboardShortcuts({ onSave: handleSave, onPublish: handlePublish, enabled: !readOnly });

  const errors = useMemo(() => validate({ nodes, edges }), [nodes, edges]);

  if (loading) return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <div className="border-b px-4 py-2 flex items-center gap-3">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-5 w-16" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-20" />
          <Skeleton className="h-8 w-20" />
        </div>
      </div>
      <div className="flex-1 flex">
        <aside className="w-[160px] border-r p-3 space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </aside>
        <Skeleton className="flex-1 m-4" />
        <aside className="w-[300px] border-l p-4 space-y-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </aside>
      </div>
    </div>
  );
  if (!wf) return (
    <EmptyState
      size="hero"
      title="Workflow not found"
      description="This workflow may have been deleted or you don't have access to it."
      action={
        <Button variant="outline" onClick={() => navigate('/admin/workflow-templates')}>
          Back to workflows
        </Button>
      }
    />
  );

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      <Breadcrumb className="px-4 pt-2">
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/admin/workflow-templates" />}>Workflows</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{wf.name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <Toolbar
        name={wf.name}
        status={wf.status}
        saving={saving}
        onSave={handleSave}
        onPublish={handlePublish}
        onUnpublish={handleUnpublish}
        onSimulate={() => setSimOpen(true)}
        onValidate={() => setErrorsOpen(true)}
      />
      <div className="flex-1 min-h-0 flex">
        {!readOnly && <Palette />}
        <div className="flex-1 min-w-0">
          <ReactFlowProvider>
            <Canvas readOnly={readOnly} />
          </ReactFlowProvider>
        </div>
        <Inspector readOnly={readOnly} />
      </div>

      <SimulatePanel
        open={simOpen}
        onOpenChange={setSimOpen}
        onRun={async (ticket) => {
          if (useGraphStore.getState().dirty) {
            await saveGraph(toJSON());
            markSaved();
          }
          return simulate(ticket);
        }}
      />

      <Dialog open={errorsOpen} onOpenChange={setErrorsOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Validation</DialogTitle></DialogHeader>
          {errors.length === 0 ? (
            <Alert>
              <CheckCircle2 />
              <AlertTitle>All checks passed</AlertTitle>
              <AlertDescription>This workflow is ready to publish.</AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-2 max-h-80 overflow-auto">
              {errors.map((e, i) => (
                <Alert key={i} variant="destructive">
                  <AlertTriangle />
                  <AlertTitle className="font-mono text-xs">{e.code}</AlertTitle>
                  <AlertDescription>{e.message}</AlertDescription>
                </Alert>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setErrorsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={unpublishOpen}
        onOpenChange={setUnpublishOpen}
        title="Unpublish workflow"
        description="This flips the workflow back to draft. Running instances keep executing on the current graph; future edits apply on their next advance."
        confirmLabel="Unpublish"
        onConfirm={doUnpublish}
      />
    </div>
  );
}
