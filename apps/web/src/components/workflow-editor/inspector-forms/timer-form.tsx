import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';

export function TimerForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { delay_minutes?: number };
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`timer-${node.id}-delay`} className="text-xs">Delay (minutes)</FieldLabel>
        <Input
          id={`timer-${node.id}-delay`}
          type="number"
          min={1}
          value={c.delay_minutes ?? 60}
          onChange={(e) => update(node.id, { delay_minutes: Number(e.target.value) })}
          disabled={readOnly}
        />
      </Field>
    </FieldGroup>
  );
}
