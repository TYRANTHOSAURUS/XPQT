import { useState, useEffect } from 'react';
import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

export function UpdateTicketForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const fields = (node.config as { fields?: Record<string, unknown> }).fields ?? {};
  const [text, setText] = useState(() => JSON.stringify(fields, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify((node.config as { fields?: Record<string, unknown> }).fields ?? {}, null, 2));
  }, [node.id]);

  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">Fields (JSON)</Label>
      <Textarea
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          try {
            const parsed = JSON.parse(v);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              update(node.id, { fields: parsed });
              setError(null);
            } else {
              setError('Must be an object');
            }
          } catch {
            setError('Invalid JSON');
          }
        }}
        rows={6}
        className="font-mono text-xs"
        disabled={readOnly}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <p className="text-xs text-muted-foreground">e.g. {'{"status": "in_progress", "priority": "high"}'}</p>
    </div>
  );
}
