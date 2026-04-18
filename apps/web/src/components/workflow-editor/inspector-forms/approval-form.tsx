import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Team { id: string; name: string }
interface Person { id: string; full_name: string; email?: string }

export function ApprovalForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: persons } = useApi<Person[]>('/persons', []);
  const c = node.config as { approver_person_id?: string | null; approver_team_id?: string | null };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`approval-${node.id}-person`} className="text-xs">Approver person</FieldLabel>
        <Select
          value={c.approver_person_id ?? ''}
          onValueChange={(v) => update(node.id, { approver_person_id: v || null, approver_team_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger id={`approval-${node.id}-person`}><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(persons ?? []).map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`approval-${node.id}-team`} className="text-xs">Or approver team</FieldLabel>
        <Select
          value={c.approver_team_id ?? ''}
          onValueChange={(v) => update(node.id, { approver_team_id: v || null, approver_person_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger id={`approval-${node.id}-team`}><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(teams ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldDescription>
          Node pauses the workflow until the approver decides. Outgoing edges must be labeled "approved" and "rejected".
        </FieldDescription>
      </Field>
    </FieldGroup>
  );
}
