import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function NotificationForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const c = node.config as { subject?: string; body?: string; notification_type?: string };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`notif-${node.id}-type`} className="text-xs">Type</FieldLabel>
        <Input
          id={`notif-${node.id}-type`}
          value={c.notification_type ?? ''}
          onChange={(e) => update(node.id, { notification_type: e.target.value })}
          disabled={readOnly}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`notif-${node.id}-subject`} className="text-xs">Subject</FieldLabel>
        <Input
          id={`notif-${node.id}-subject`}
          value={c.subject ?? ''}
          onChange={(e) => update(node.id, { subject: e.target.value })}
          disabled={readOnly}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`notif-${node.id}-body`} className="text-xs">Body</FieldLabel>
        <Textarea
          id={`notif-${node.id}-body`}
          value={c.body ?? ''}
          onChange={(e) => update(node.id, { body: e.target.value })}
          rows={4}
          disabled={readOnly}
        />
      </Field>
    </FieldGroup>
  );
}
