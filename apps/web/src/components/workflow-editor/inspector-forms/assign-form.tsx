import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useTeams } from '@/api/teams';
import { useUsers, userLabel } from '@/api/users';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export function AssignForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const { data: teams } = useTeams();
  const { data: users } = useUsers();
  const c = node.config as { team_id?: string | null; user_id?: string | null };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor={`assign-${node.id}-team`} className="text-xs">Team</FieldLabel>
        <Select
          value={c.team_id ?? ''}
          onValueChange={(v) => update(node.id, { team_id: v || null, user_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger id={`assign-${node.id}-team`}><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(teams ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={`assign-${node.id}-user`} className="text-xs">Or user</FieldLabel>
        <Select
          value={c.user_id ?? ''}
          onValueChange={(v) => update(node.id, { user_id: v || null, team_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger id={`assign-${node.id}-user`}><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{userLabel(u)}</SelectItem>)}
          </SelectContent>
        </Select>
        <FieldDescription>Pick one or the other.</FieldDescription>
      </Field>
    </FieldGroup>
  );
}
