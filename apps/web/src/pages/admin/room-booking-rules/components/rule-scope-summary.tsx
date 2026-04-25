import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useSpaces, type Space } from '@/api/spaces';
import { formatCount } from '@/lib/format';
import type { TargetScope } from '@/api/room-booking-rules';

interface RuleScopeSummaryProps {
  target_scope: TargetScope;
  target_id: string | null;
  /**
   * When known, the human-readable type label for `target_scope='room_type'`.
   * The schema stores `target_id` as a uuid, so the label has to travel
   * separately. See detail page for how it's derived.
   */
  typeLabel?: string | null;
}

interface ResolvedSet {
  /** "All rooms in tenant", "Conference room A", etc. */
  primary: string;
  /** "12 rooms" if it expands. Null if it's a single room. */
  count: string | null;
  /** Detailed tooltip body. */
  tooltipBody: string;
}

/**
 * Summarises a rule scope to a one-liner with a hover tooltip giving the
 * resolved-set count. Used in the index-page table and the detail page's
 * scope summary row.
 */
export function RuleScopeSummary({ target_scope, target_id, typeLabel }: RuleScopeSummaryProps) {
  const { data: spaces } = useSpaces();
  const resolved = useMemo(
    () => describeScope(target_scope, target_id, spaces ?? [], typeLabel ?? null),
    [target_scope, target_id, spaces, typeLabel],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex items-center gap-1.5 text-sm">
            <span>{resolved.primary}</span>
            {resolved.count && (
              <span className="text-xs text-muted-foreground">{resolved.count}</span>
            )}
          </span>
        }
      />
      <TooltipContent>{resolved.tooltipBody}</TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function describeScope(
  target_scope: TargetScope,
  target_id: string | null,
  spaces: Space[],
  typeLabel: string | null,
): ResolvedSet {
  if (target_scope === 'tenant') {
    const rooms = spaces.filter((s) => s.type === 'room');
    return {
      primary: 'Tenant',
      count: `${formatCount(rooms.length)} ${rooms.length === 1 ? 'room' : 'rooms'}`,
      tooltipBody: `Applies to every reservable room in this tenant (${formatCount(rooms.length)}).`,
    };
  }

  if (target_scope === 'room') {
    const space = spaces.find((s) => s.id === target_id);
    return {
      primary: space ? space.name : 'Specific room',
      count: null,
      tooltipBody: space
        ? `Applies only to "${space.name}".`
        : 'Applies to a single room. The room has not been picked yet or has been deleted.',
    };
  }

  if (target_scope === 'space_subtree') {
    const root = spaces.find((s) => s.id === target_id);
    if (!root) {
      return {
        primary: 'Space subtree',
        count: null,
        tooltipBody: 'Applies to a space subtree. Pick a root in the scope dialog.',
      };
    }
    const descendants = collectDescendantRooms(root.id, spaces);
    return {
      primary: root.name,
      count: `${formatCount(descendants)} ${descendants === 1 ? 'room' : 'rooms'}`,
      tooltipBody: `Applies to every room under "${root.name}" (${formatCount(descendants)}).`,
    };
  }

  // room_type
  return {
    primary: typeLabel ? `Type · ${typeLabel}` : 'Room type',
    count: null,
    tooltipBody: typeLabel
      ? `Applies to every room with type "${typeLabel}".`
      : 'Applies to every room of a specific type.',
  };
}

function collectDescendantRooms(rootId: string, spaces: Space[]): number {
  const childrenByParent = new Map<string, Space[]>();
  for (const s of spaces) {
    const list = childrenByParent.get(s.parent_id ?? '') ?? [];
    list.push(s);
    childrenByParent.set(s.parent_id ?? '', list);
  }
  let count = 0;
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const children = childrenByParent.get(id) ?? [];
    for (const c of children) {
      if (c.type === 'room') count += 1;
      stack.push(c.id);
    }
  }
  return count;
}
