import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

export function WorkflowEditorPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: wf, loading, refetch } = useWorkflow(id);
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

  const handleUnpublish = async () => {
    if (!confirm('Unpublishing will flip this workflow back to draft. Running instances will keep working on the current graph; future edits will apply on their next advance. Continue?')) return;
    try {
      await unpublish();
      toast.success('Unpublished');
      refetch();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Unpublish failed');
    }
  };

  useKeyboardShortcuts({ onSave: handleSave, onPublish: handlePublish, enabled: !readOnly });

  const errors = useMemo(() => validate({ nodes, edges }), [nodes, edges]);

  if (loading) return <div className="p-6 text-muted-foreground">Loading…</div>;
  if (!wf) return <div className="p-6">Not found. <Button variant="link" onClick={() => navigate('/admin/workflow-templates')}>Back</Button></div>;

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
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
            <p className="text-sm text-emerald-600">No issues.</p>
          ) : (
            <ul className="text-sm space-y-1 max-h-80 overflow-auto">
              {errors.map((e, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-red-600 font-mono text-xs">{e.code}</span>
                  <span>{e.message}</span>
                </li>
              ))}
            </ul>
          )}
          <DialogFooter>
            <Button onClick={() => setErrorsOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
