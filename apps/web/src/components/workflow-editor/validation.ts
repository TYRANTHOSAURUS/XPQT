import type { WorkflowGraph, ValidationError, WorkflowNode } from './types';

export function validate(graph: WorkflowGraph): ValidationError[] {
  const errors: ValidationError[] = [];
  const { nodes, edges } = graph;
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  const triggers = nodes.filter((n) => n.type === 'trigger');
  if (triggers.length === 0) errors.push({ code: 'NO_TRIGGER', message: 'Workflow must have a trigger node' });
  if (triggers.length > 1) errors.push({ code: 'MULTIPLE_TRIGGERS', message: 'Workflow must have exactly one trigger' });

  const ends = nodes.filter((n) => n.type === 'end');
  if (ends.length === 0) errors.push({ code: 'NO_END', message: 'Workflow must have at least one end node' });

  edges.forEach((e, i) => {
    if (!nodeById.has(e.from)) errors.push({ code: 'DANGLING_EDGE_FROM', message: `Edge references unknown node ${e.from}`, edgeIndex: i });
    if (!nodeById.has(e.to)) errors.push({ code: 'DANGLING_EDGE_TO', message: `Edge references unknown node ${e.to}`, edgeIndex: i });
  });

  for (const n of nodes) {
    const out = edges.filter((e) => e.from === n.id);
    if (n.type !== 'end' && out.length === 0) {
      errors.push({ code: 'NO_OUTGOING', message: `Node "${n.type}" has no outgoing edge`, nodeId: n.id });
    }
    if (n.type === 'condition') {
      const hasTrue = out.some((e) => e.condition === 'true');
      const hasFalse = out.some((e) => e.condition === 'false');
      if (!hasTrue) errors.push({ code: 'MISSING_TRUE_EDGE', message: 'Condition needs a "true" branch', nodeId: n.id });
      if (!hasFalse) errors.push({ code: 'MISSING_FALSE_EDGE', message: 'Condition needs a "false" branch', nodeId: n.id });
    }
    if (n.type === 'approval') {
      const hasApproved = out.some((e) => e.condition === 'approved');
      const hasRejected = out.some((e) => e.condition === 'rejected');
      if (!hasApproved) errors.push({ code: 'MISSING_APPROVED_EDGE', message: 'Approval needs an "approved" branch', nodeId: n.id });
      if (!hasRejected) errors.push({ code: 'MISSING_REJECTED_EDGE', message: 'Approval needs a "rejected" branch', nodeId: n.id });
    }
  }

  if (triggers.length === 1) {
    const reachable = bfs(triggers[0].id, edges);
    for (const n of nodes) {
      if (!reachable.has(n.id) && n.type !== 'trigger') {
        errors.push({ code: 'UNREACHABLE', message: `Node "${n.type}" is not reachable from trigger`, nodeId: n.id });
      }
    }
  }

  for (const n of nodes) errors.push(...validateNodeConfig(n));

  return errors;
}

function bfs(startId: string, edges: Array<{ from: string; to: string }>): Set<string> {
  const seen = new Set<string>([startId]);
  const queue = [startId];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const e of edges) {
      if (e.from === cur && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return seen;
}

function validateNodeConfig(n: WorkflowNode): ValidationError[] {
  const errs: ValidationError[] = [];
  const c = n.config as Record<string, unknown>;
  const req = (code: string, message: string, ok: boolean) => {
    if (!ok) errs.push({ code, message, nodeId: n.id });
  };

  switch (n.type) {
    case 'assign':
      req('ASSIGN_TARGET', 'Assign requires a team or user', !!(c.team_id || c.user_id));
      break;
    case 'approval':
      req('APPROVAL_APPROVER', 'Approval requires an approver (person or team)', !!(c.approver_person_id || c.approver_team_id));
      break;
    case 'notification':
      req('NOTIFY_SUBJECT', 'Notification requires subject', typeof c.subject === 'string' && c.subject.trim().length > 0);
      req('NOTIFY_BODY', 'Notification requires body', typeof c.body === 'string' && c.body.trim().length > 0);
      break;
    case 'condition':
      req('COND_FIELD', 'Condition requires a field', typeof c.field === 'string' && c.field.length > 0);
      req('COND_OP', 'Condition requires an operator', ['equals','not_equals','in'].includes(c.operator as string));
      break;
    case 'update_ticket':
      req('UPDATE_FIELDS', 'Update Ticket requires at least one field', typeof c.fields === 'object' && c.fields !== null && Object.keys(c.fields).length > 0);
      break;
    case 'create_child_tasks': {
      const tasks = c.tasks as Array<{ title?: string }> | undefined;
      req('CHILD_TASKS_NONEMPTY', 'Create Child Tasks requires at least one task', Array.isArray(tasks) && tasks.length > 0 && tasks.every((t) => typeof t.title === 'string' && t.title.trim().length > 0));
      break;
    }
    case 'wait_for':
      req('WAIT_TYPE', 'Wait For requires a wait_type', ['child_tasks','status','event'].includes(c.wait_type as string));
      break;
    case 'timer':
      req('TIMER_DELAY', 'Timer requires delay_minutes > 0', typeof c.delay_minutes === 'number' && c.delay_minutes > 0);
      break;
    case 'http_request':
      req('HTTP_URL', 'HTTP Request requires a URL', typeof c.url === 'string' && (c.url as string).trim().length > 0);
      req('HTTP_METHOD', 'HTTP Request requires a method', ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(c.method as string));
      break;
  }
  return errs;
}
