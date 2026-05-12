import { memo } from 'react';
import type { WorkOrderPlanningBlock } from '@prequest/shared';
import { cn } from '@/lib/utils';
import { formatTicketRef } from '@/lib/format-ref';
import { PriorityIcon, statusConfig } from '@/components/desk/ticket-row-cells';

/**
 * One renderable block on the planning grid. v1 visual contract:
 *
 * - Rounded rectangle inside its lane row.
 * - 4px status-coloured left bar (dot colour from `statusConfig`).
 * - `WO-####` ref chip on the leading edge; truncated title; priority
 *   icon on the trailing edge.
 *
 * Click-through navigation, deadline overlay, and drag interactions are
 * added in subsequent chunks — this initial render path keeps the file
 * lean enough to review one concern at a time.
 */

interface Props {
  block: WorkOrderPlanningBlock;
  leftPct: number;
  widthPct: number;
}

export const PlanningBlock = memo(function PlanningBlock({ block, leftPct, widthPct }: Props) {
  const statusEntry = statusConfig[block.status_category] ?? statusConfig.new;
  const ref = formatTicketRef('work_order', block.module_number);

  return (
    <div
      className={cn(
        'absolute top-1.5 bottom-1.5 z-10 flex items-center gap-2 overflow-hidden rounded-md border bg-card pl-2 pr-2 text-xs shadow-sm',
        'border-border/60',
      )}
      style={{
        left: `${leftPct}%`,
        width: `${Math.max(widthPct, 0.6)}%`,
      }}
      data-status={block.status_category}
    >
      <span aria-hidden className={cn('absolute left-0 top-0 bottom-0 w-1', statusEntry.dotColor)} />
      <span
        aria-hidden
        className={cn('pointer-events-none absolute inset-0 opacity-[0.06]', statusEntry.dotColor)}
      />

      <span className="relative shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground">
        {ref}
      </span>

      <span className="relative min-w-0 flex-1 truncate font-medium text-foreground">
        {block.title}
      </span>

      <span className="relative shrink-0">
        <PriorityIcon priority={block.priority} />
      </span>
    </div>
  );
});
