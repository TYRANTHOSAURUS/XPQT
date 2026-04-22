import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Undo2, Redo2, Save, Send, RotateCcw, FlaskConical, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useGraphStore } from './graph-store';
import { validate } from './validation';

interface ToolbarProps {
  name: string;
  status: 'draft' | 'published';
  saving: boolean;
  onSave: () => void;
  onPublish: () => void;
  onUnpublish: () => void;
  onSimulate: () => void;
  onValidate: () => void;
}

export function Toolbar({ name, status, saving, onSave, onPublish, onUnpublish, onSimulate, onValidate }: ToolbarProps) {
  const nodes = useGraphStore((s) => s.nodes);
  const edges = useGraphStore((s) => s.edges);
  const dirty = useGraphStore((s) => s.dirty);
  const undo = useGraphStore((s) => s.undo);
  const redo = useGraphStore((s) => s.redo);
  const past = useGraphStore((s) => s.past);
  const future = useGraphStore((s) => s.future);

  const errors = validate({ nodes, edges });
  const valid = errors.length === 0;
  const readOnly = status === 'published';

  return (
    <div className="flex items-center gap-2 border-b px-4 py-2 bg-background">
      <div className="flex-1 min-w-0">
        <div className="font-semibold truncate">{name}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <Badge variant={status === 'published' ? 'default' : 'secondary'} className="capitalize text-[10px]">{status}</Badge>
          {dirty && <span className="text-[10px] text-amber-600">● unsaved</span>}
          {valid ? (
            <span className="text-[10px] text-emerald-600 flex items-center gap-0.5"><CheckCircle2 className="h-3 w-3" /> valid</span>
          ) : (
            <button onClick={onValidate} className="text-[10px] text-red-600 flex items-center gap-0.5 hover:underline">
              <AlertTriangle className="h-3 w-3" /> {errors.length} issue(s)
            </button>
          )}
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              onClick={undo}
              disabled={past.length === 0 || readOnly}
            />
          }
        >
          <Undo2 className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>Undo (⌘Z)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              onClick={redo}
              disabled={future.length === 0 || readOnly}
            />
          }
        >
          <Redo2 className="h-4 w-4" />
        </TooltipTrigger>
        <TooltipContent>Redo (⌘⇧Z)</TooltipContent>
      </Tooltip>

      <Button variant="outline" size="sm" onClick={onSimulate} className="gap-1.5">
        <FlaskConical className="h-3.5 w-3.5" /> Simulate
      </Button>

      {status === 'draft' ? (
        <>
          <Button variant="outline" size="sm" onClick={onSave} disabled={saving || !dirty} className="gap-1.5">
            <Save className="h-3.5 w-3.5" /> {saving ? 'Saving…' : 'Save'}
          </Button>
          <Button size="sm" onClick={onPublish} disabled={saving || !valid} className="gap-1.5">
            <Send className="h-3.5 w-3.5" /> Publish
          </Button>
        </>
      ) : (
        <Button variant="outline" size="sm" onClick={onUnpublish} className="gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" /> Unpublish
        </Button>
      )}
    </div>
  );
}
