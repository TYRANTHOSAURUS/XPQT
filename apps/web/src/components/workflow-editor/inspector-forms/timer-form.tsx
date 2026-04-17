import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

export function TimerForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { delay_minutes?: number };
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Delay (minutes)</Label>
      <Input
        type="number"
        min={1}
        value={c.delay_minutes ?? 60}
        onChange={(e) => update(node.id, { delay_minutes: Number(e.target.value) })}
        disabled={readOnly}
      />
    </div>
  );
}
