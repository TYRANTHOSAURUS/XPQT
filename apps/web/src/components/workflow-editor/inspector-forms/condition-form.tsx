import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const TICKET_FIELDS = ['priority', 'status', 'status_category', 'interaction_mode', 'source_channel'] as const;

export function ConditionForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { field?: string; operator?: string; value?: unknown };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`cond-${node.id}-field`} className="text-xs">Ticket field</FieldLabel>
        <Select
          value={c.field ?? ''}
          onValueChange={(v) => update(node.id, { field: v ?? '' })}
          disabled={readOnly}
        >
          <SelectTrigger id={`cond-${node.id}-field`}><SelectValue placeholder="Select field" /></SelectTrigger>
          <SelectContent>
            {TICKET_FIELDS.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`cond-${node.id}-op`} className="text-xs">Operator</FieldLabel>
        <Select
          value={c.operator ?? 'equals'}
          onValueChange={(v) => update(node.id, { operator: v ?? 'equals' })}
          disabled={readOnly}
        >
          <SelectTrigger id={`cond-${node.id}-op`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="equals">equals</SelectItem>
            <SelectItem value="not_equals">not equals</SelectItem>
            <SelectItem value="in">in (comma-separated)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`cond-${node.id}-value`} className="text-xs">Value</FieldLabel>
        <Input
          id={`cond-${node.id}-value`}
          value={Array.isArray(c.value) ? (c.value as string[]).join(',') : String(c.value ?? '')}
          onChange={(e) => {
            const v = e.target.value;
            update(node.id, { value: c.operator === 'in' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v });
          }}
          disabled={readOnly}
        />
        <FieldDescription>Requires "true" and "false" outgoing edges.</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
