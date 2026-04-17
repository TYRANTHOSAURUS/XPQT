import type { WorkflowNode } from './types';

export function summarizeNode(n: WorkflowNode): string {
  const c = n.config as Record<string, unknown>;
  switch (n.type) {
    case 'assign': {
      const t = c.team_id ? 'team' : c.user_id ? 'user' : null;
      return t ? `Assign to ${t}` : 'Unassigned';
    }
    case 'approval': return c.approver_person_id || c.approver_team_id ? 'Approver set' : 'No approver';
    case 'notification': return (c.subject as string) || 'No subject';
    case 'condition': return c.field ? `${c.field} ${c.operator} ${JSON.stringify(c.value)}` : 'Unconfigured';
    case 'update_ticket': return `Update ${Object.keys((c.fields as object) || {}).length} field(s)`;
    case 'create_child_tasks': return `${((c.tasks as unknown[]) || []).length} task(s)`;
    case 'wait_for': return `Wait for ${c.wait_type ?? '—'}`;
    case 'timer': return `Delay ${c.delay_minutes ?? 0} min`;
    default: return '';
  }
}
