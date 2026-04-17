import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function NotificationForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { subject?: string; body?: string; notification_type?: string };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Type</Label>
        <Input value={c.notification_type ?? ''} onChange={(e) => update(node.id, { notification_type: e.target.value })} disabled={readOnly} />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Subject</Label>
        <Input value={c.subject ?? ''} onChange={(e) => update(node.id, { subject: e.target.value })} disabled={readOnly} />
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Body</Label>
        <Textarea value={c.body ?? ''} onChange={(e) => update(node.id, { body: e.target.value })} rows={4} disabled={readOnly} />
      </div>
    </div>
  );
}
