import type { RulePredicate } from '@/api/room-booking-rules';

/**
 * Best-effort plain-English render of a compiled rule predicate. Used in
 * SettingsRow summaries on the detail page (e.g. "When time outside business
 * hours AND requester role IN [executive, ea]").
 *
 * Not a full grammar — covers the shapes the 12 starter templates actually
 * emit plus generic and/or/not nesting. Anything else falls back to a
 * compact JSON snippet so admins still see something meaningful.
 */
export function describePredicate(node: RulePredicate | null | undefined): string {
  if (!node) return 'No predicate.';
  return render(node);
}

function render(node: RulePredicate): string {
  if ('and' in node) {
    return node.and.map(render).join(' AND ');
  }
  if ('or' in node) {
    return node.or.map(render).join(' OR ');
  }
  if ('not' in node) {
    const inner = render(node.not);
    // Special case the inverse forms our templates emit so it reads naturally.
    if (inner.startsWith('requester is in org subtree ')) {
      return 'requester is outside org subtree' + inner.slice('requester is in org subtree'.length);
    }
    if (inner.startsWith('time is in business hours ')) {
      return 'time is outside business hours' + inner.slice('time is in business hours'.length);
    }
    if (inner.startsWith('requester role intersects ')) {
      return 'requester role is not in ' + inner.slice('requester role intersects '.length);
    }
    return `NOT (${inner})`;
  }
  if ('fn' in node) return renderFn(node.fn, node.args);
  if ('op' in node) return renderOp(node.op, node.left, node.right);
  return JSON.stringify(node);
}

function renderFn(fn: string, args: unknown[]): string {
  switch (fn) {
    case 'in_business_hours':
      return `time is in business hours (calendar ${args[1] ?? '?'})`;
    case 'array_intersects':
      return `requester role intersects ${formatArg(args[1])}`;
    case 'in_org_descendants':
      return `requester is in org subtree ${formatArg(args[1])}`;
    case 'lead_minutes_lt':
      return `lead time < ${args[1]} min`;
    case 'lead_minutes_gt':
      return `lead time > ${args[1]} min`;
    case 'duration_minutes_gt':
      return `duration > ${args[2]} min`;
    case 'attendees_over_capacity_factor':
      return `attendees > capacity × ${args[2]}`;
    case 'attendees_below_min':
      return `attendees < room minimum`;
    case 'has_permission':
      return `actor has permission "${args[0]}"`;
    default:
      return `${fn}(${args.map(formatArg).join(', ')})`;
  }
}

function renderOp(op: string, left: unknown, right: unknown): string {
  const leftLabel = renderPathOrLiteral(left);
  const rightLabel = renderPathOrLiteral(right);
  const opLabel = OP_LABEL[op] ?? op;
  return `${leftLabel} ${opLabel} ${rightLabel}`;
}

const OP_LABEL: Record<string, string> = {
  eq: '=',
  ne: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  contains: 'contains',
};

function renderPathOrLiteral(value: unknown): string {
  if (typeof value !== 'string') return formatArg(value);
  // Pretty-print common JSONPaths.
  if (value.startsWith('$.booking.')) return value.slice(2);
  if (value.startsWith('$.requester.')) return value.slice(2);
  if (value.startsWith('$.space.')) return value.slice(2);
  if (value.startsWith('$.')) return value.slice(2);
  return JSON.stringify(value);
}

function formatArg(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length <= 3) return `[${value.map(formatArg).join(', ')}]`;
    return `[${value.slice(0, 2).map(formatArg).join(', ')}, +${value.length - 2}]`;
  }
  if (typeof value === 'string') return `"${truncate(value, 24)}"`;
  if (value === null || value === undefined) return 'null';
  return String(value);
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
