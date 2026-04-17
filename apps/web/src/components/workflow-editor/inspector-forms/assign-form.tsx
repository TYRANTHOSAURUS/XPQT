import type { WorkflowNode } from '../types';
import { useGraphStore } from '../graph-store';
import { useApi } from '@/hooks/use-api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface Team { id: string; name: string }
interface User { id: string; email: string; full_name?: string }

export function AssignForm({ node, readOnly }: { node: WorkflowNode; readOnly: boolean }) {
  const update = useGraphStore((s) => s.updateNodeConfig);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: users } = useApi<User[]>('/users', []);
  const c = node.config as { team_id?: string | null; user_id?: string | null };

  return (
    <div className="grid gap-3">
      <div className="grid gap-1.5">
        <Label className="text-xs">Team</Label>
        <Select
          value={c.team_id ?? ''}
          onValueChange={(v) => update(node.id, { team_id: v || null, user_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(teams ?? []).map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Or user</Label>
        <Select
          value={c.user_id ?? ''}
          onValueChange={(v) => update(node.id, { user_id: v || null, team_id: null })}
          disabled={readOnly}
        >
          <SelectTrigger><SelectValue placeholder="— none —" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="">— none —</SelectItem>
            {(users ?? []).map((u) => <SelectItem key={u.id} value={u.id}>{u.full_name ?? u.email}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">Pick one or the other.</p>
    </div>
  );
}
