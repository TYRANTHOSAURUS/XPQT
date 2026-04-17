import { Injectable } from '@nestjs/common';

export interface ValidationError { code: string; message: string; nodeId?: string; edgeIndex?: number }
export interface ValidationResult { ok: boolean; errors: ValidationError[] }
interface Node { id: string; type: string; config: Record<string, unknown> }
interface Edge { from: string; to: string; condition?: string }
interface Graph { nodes: Node[]; edges: Edge[] }

@Injectable()
export class WorkflowValidatorService {
  validate(g: Graph): ValidationResult {
    const errors: ValidationError[] = [];
    const nodeById = new Map(g.nodes.map((n) => [n.id, n]));

    const triggers = g.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length === 0) errors.push({ code: 'NO_TRIGGER', message: 'Workflow must have a trigger node' });
    if (triggers.length > 1) errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Workflow must have exactly one trigger' });
    if (g.nodes.filter((n) => n.type === 'end').length === 0) errors.push({ code: 'NO_END', message: 'Workflow must have at least one end node' });

    g.edges.forEach((e, i) => {
      if (!nodeById.has(e.from)) errors.push({ code: 'DANGLING_EDGE_FROM', message: `Edge references unknown node ${e.from}`, edgeIndex: i });
      if (!nodeById.has(e.to)) errors.push({ code: 'DANGLING_EDGE_TO', message: `Edge references unknown node ${e.to}`, edgeIndex: i });
    });

    for (const n of g.nodes) {
      const out = g.edges.filter((e) => e.from === n.id);
      if (n.type !== 'end' && out.length === 0) errors.push({ code: 'NO_OUTGOING', message: `Node "${n.type}" has no outgoing edge`, nodeId: n.id });
      if (n.type === 'condition') {
        if (!out.some((e) => e.condition === 'true')) errors.push({ code: 'MISSING_TRUE_EDGE', message: 'Condition needs a "true" branch', nodeId: n.id });
        if (!out.some((e) => e.condition === 'false')) errors.push({ code: 'MISSING_FALSE_EDGE', message: 'Condition needs a "false" branch', nodeId: n.id });
      }
      if (n.type === 'approval') {
        if (!out.some((e) => e.condition === 'approved')) errors.push({ code: 'MISSING_APPROVED_EDGE', message: 'Approval needs an "approved" branch', nodeId: n.id });
        if (!out.some((e) => e.condition === 'rejected')) errors.push({ code: 'MISSING_REJECTED_EDGE', message: 'Approval needs a "rejected" branch', nodeId: n.id });
      }
      errors.push(...this.validateNodeConfig(n));
    }

    if (triggers.length === 1) {
      const reachable = this.bfs(triggers[0].id, g.edges);
      for (const n of g.nodes) {
        if (n.type !== 'trigger' && !reachable.has(n.id)) {
          errors.push({ code: 'UNREACHABLE', message: `Node "${n.type}" is not reachable from trigger`, nodeId: n.id });
        }
      }
    }

    return { ok: errors.length === 0, errors };
  }

  private bfs(start: string, edges: Edge[]): Set<string> {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges) if (e.from === cur && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
    return seen;
  }

  private validateNodeConfig(n: Node): ValidationError[] {
    const errs: ValidationError[] = [];
    const c = n.config;
    const req = (code: string, msg: string, ok: boolean) => { if (!ok) errs.push({ code, message: msg, nodeId: n.id }); };
    switch (n.type) {
      case 'assign': req('ASSIGN_TARGET', 'Assign requires a team or user', !!(c.team_id || c.user_id)); break;
      case 'approval': req('APPROVAL_APPROVER', 'Approval requires an approver', !!(c.approver_person_id || c.approver_team_id)); break;
      case 'notification':
        req('NOTIFY_SUBJECT', 'Notification requires subject', typeof c.subject === 'string' && (c.subject as string).trim().length > 0);
        req('NOTIFY_BODY', 'Notification requires body', typeof c.body === 'string' && (c.body as string).trim().length > 0);
        break;
      case 'condition':
        req('COND_FIELD', 'Condition requires a field', typeof c.field === 'string' && (c.field as string).length > 0);
        req('COND_OP', 'Condition requires an operator', ['equals','not_equals','in'].includes(c.operator as string));
        break;
      case 'update_ticket':
        req('UPDATE_FIELDS', 'Update Ticket requires fields', typeof c.fields === 'object' && c.fields !== null && Object.keys(c.fields as object).length > 0);
        break;
      case 'create_child_tasks': {
        const tasks = c.tasks as Array<{ title?: string }> | undefined;
        req('CHILD_TASKS_NONEMPTY', 'Create Child Tasks requires at least one task with a title',
          Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => typeof t.title === 'string' && t.title.trim().length > 0));
        break;
      }
      case 'wait_for':
        req('WAIT_TYPE', 'Wait For requires a wait_type', ['child_tasks','status','event'].includes(c.wait_type as string));
        break;
      case 'timer':
        req('TIMER_DELAY', 'Timer requires delay_minutes > 0', typeof c.delay_minutes === 'number' && (c.delay_minutes as number) > 0);
        break;
    }
    return errs;
  }
}
