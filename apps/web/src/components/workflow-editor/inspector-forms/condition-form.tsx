import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TICKET_FIELDS = ['priority', 'status', 'status_category', 'interaction_mode', 'source_channel'] as const;

export function ConditionForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { field?: string; operator?: string; value?: unknown };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Ticket field</Label>
        <Select value={c.field ?? ''} onValueChange={(v) => update(node.id, { field: v ?? '' })} disabled={readOnly}>
          <SelectTrigger><SelectValue placeholder="Select field" /></SelectTrigger>
          <SelectContent>
            {TICKET_FIELDS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Operator</Label>
        <Select value={c.operator ?? 'equals'} onValueChange={(v) => update(node.id, { operator: v ?? 'equals' })} disabled={readOnly}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="equals">equals</SelectItem>
            <SelectItem value="not_equals">not equals</SelectItem>
            <SelectItem value="in">in (comma-separated)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Value</Label>
        <Input
          value={Array.isArray(c.value) ? (c.value as string[]).join(',') : String(c.value ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            update(node.id, { value: c.operator === 'in' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v });
          }}
          disabled={readOnly}
        />
      </div>
      <p className="text-xs text-muted-foreground">Requires "true" and "false" outgoing edges.</p>
    </div>
  );
}
