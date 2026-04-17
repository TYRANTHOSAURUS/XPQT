import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function WaitForForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { wait_type?: string };
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Wait type</Label>
      <Select value={c.wait_type ?? 'child_tasks'} onValueChange={(v) => update(node.id, { wait_type: v ?? 'child_tasks' })} disabled={readOnly}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="child_tasks">Child tasks complete</SelectItem>
          <SelectItem value="status">Status change</SelectItem>
          <SelectItem value="event">External event</SelectItem>
        </SelectContent>
      </Select>
    </div>
  );
}
