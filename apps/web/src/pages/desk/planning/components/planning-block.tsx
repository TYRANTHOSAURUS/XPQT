import { memo } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WorkOrderPlanningBlock } from '@prequest/shared';
import { cn } from '@/lib/utils';
import { formatTicketRef } from '@/lib/format-ref';
import { PriorityIcon, statusConfig } from '@/components/desk/ticket-row-cells';

/**
 * One renderable block on the planning grid. Visual contract:
 *
 * - Rounded rectangle, fixed height (~h-12) within the lane row.
 * - 4px status-coloured left bar (dot colour from `statusConfig`).
 * - White-ish background tinted 5% with status colour for at-a-glance scan.
 * - `WO-####` ref chip on the leading edge; truncated title; priority
 *   icon on the trailing edge.
 * - When `sla_resolution_due_at` falls inside [start, start+duration),
 *   render a vertical red rule at that point. When the block's end is
 *   past the deadline, paint a 2px red border on the right edge.
 * - Click → navigate to /desk/tickets/:id.
 * - When `can_plan === false`, the cursor is default and the whole block
 *   is slightly desaturated. (Drag wiring is added in Chunk 4.)
 *
 * The block does NOT own drag behaviour — `usePlanningDrag` wraps the
 * lane row and routes pointer events to whichever block was grabbed.
 * That keeps the visual component dumb and re-renderable.
 */

interface Props {
  block: WorkOrderPlanningBlock;
  /** Pixel offset from the lane's left edge, as a percentage of the lane width. */
  leftPct: number;
  /** Width of the block, as a percentage of the lane width. */
  widthPct: number;
  /** Block start ISO — used for the deadline overlay math. */
  startIso: string;
  /** Block end ISO (start + duration). Used for deadline overlay math. */
  endIso: string;
  /** When set, this block is currently being dragged — render translucent. */
  isDragging?: boolean;
  /** Custom pointer-down handler from the lane's drag controller. */
  onPointerDown?: (e: React.PointerEvent<HTMLDivElement>) => void;
}

export const PlanningBlock = memo(function PlanningBlock({
  block,
  leftPct,
  widthPct,
  startIso,
  endIso,
  isDragging,
  onPointerDown,
}: Props) {
  const navigate = useNavigate();
  const statusEntry = statusConfig[block.status_category] ?? statusConfig.new;
  const ref = formatTicketRef('work_order', block.module_number);
  const canPlan = block.can_plan;

  // Deadline math — compute the overlay position relative to the block's
  // own time span (not the window) so the rule lands at exactly the
  // deadline instant inside the block. If the deadline is outside this
  // span, the rule is omitted and we use the right-edge border to flag
  // the "block ends past deadline" case.
  const startMs = new Date(startIso).getTime();
  const endMs = new Date(endIso).getTime();
  const dueMs = block.sla_resolution_due_at ? new Date(block.sla_resolution_due_at).getTime() : null;
  const deadlineInside =
    dueMs != null && dueMs > startMs && dueMs < endMs
      ? ((dueMs - startMs) / (endMs - startMs)) * 100
      : null;
  const overdueEdge = dueMs != null && endMs > dueMs;

  const handleClick = (e: React.MouseEvent) => {
    if (isDragging) return;
    e.stopPropagation();
    navigate(`/desk/tickets/${block.id}`);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Open ${ref}: ${block.title}`}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigate(`/desk/tickets/${block.id}`);
        }
      }}
      onPointerDown={canPlan ? onPointerDown : undefined}
      className={cn(
        'absolute top-1.5 bottom-1.5 z-10 flex items-center gap-2 overflow-hidden rounded-md border bg-card pl-2 pr-2 text-xs shadow-sm',
        'border-border/60 transition-shadow',
        canPlan ? 'cursor-grab hover:bg-accent hover:shadow' : 'cursor-default opacity-70 saturate-50',
        isDragging && 'cursor-grabbing opacity-60 ring-1 ring-primary/40',
        overdueEdge && 'border-r-2 border-r-red-500',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
      )}
      style={{
        left: `${leftPct}%`,
        width: `${Math.max(widthPct, 0.6)}%`,
      }}
      data-status={block.status_category}
    >
      {/* Status-coloured left bar — same dotColor class set the chip
          uses. Keeps the visual identity tight with the rest of the
          desk. */}
      <span
        aria-hidden
        className={cn('absolute left-0 top-0 bottom-0 w-1', statusEntry.dotColor)}
      />

      {/* Faint status tint behind the content (5% opacity). Painted as
          a separate element so the white card background stays
          readable. */}
      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-0 opacity-[0.06]', statusEntry.dotColor)}
      />

      {/* Ref chip on the leading edge. */}
      <span className="relative shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground">
        {ref}
      </span>

      <span className="relative min-w-0 flex-1 truncate font-medium text-foreground">
        {block.title}
      </span>

      <span className="relative shrink-0">
        <PriorityIcon priority={block.priority} />
      </span>

      {/* Deadline rule inside the block. Painted last so it sits above
          the tint + content. */}
      {deadlineInside != null && (
        <span
          aria-hidden
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-red-500"
          style={{ left: `${deadlineInside}%`, boxShadow: '0 0 0 1px rgb(239 68 68 / 0.2)' }}
        />
      )}
    </div>
  );
});
