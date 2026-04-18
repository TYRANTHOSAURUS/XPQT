import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function WaitForForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { wait_type?: string };
  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`wait-${node.id}-type`} className="text-xs">Wait type</FieldLabel>
        <Select
          value={c.wait_type ?? 'child_tasks'}
          onValueChange={(v) => update(node.id, { wait_type: v ?? 'child_tasks' })}
          disabled={readOnly}
        >
          <SelectTrigger id={`wait-${node.id}-type`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="child_tasks">Child tasks complete</SelectItem>
            <SelectItem value="status">Status change</SelectItem>
            <SelectItem value="event">External event</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  );
}
