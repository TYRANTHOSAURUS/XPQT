import { memo } from 'react';
import type { WorkOrderPlanningBlock } from '@prequest/shared';
import { cn } from '@/lib/utils';
import { formatRelativeTime } from '@/lib/format';
import { formatTicketRef } from '@/lib/format-ref';
import { PriorityIcon, statusConfig } from '@/components/desk/ticket-row-cells';

interface Props {
  items: WorkOrderPlanningBlock[];
  isLoading?: boolean;
}

/**
 * Unscheduled rail — sorted by `sla_resolution_due_at` ASC so the most
 * urgent work surfaces first. Smaller variant of `<PlanningBlock>`: no
 * time positioning, just ref + title + status chip + priority +
 * deadline tag.
 *
 * Drag-onto-lane is added in Chunk 5.
 */
export const UnscheduledRail = memo(function UnscheduledRail({ items, isLoading }: Props) {
  const sorted = [...items].sort((a, b) => {
    const ad = a.sla_resolution_due_at ? new Date(a.sla_resolution_due_at).getTime() : Number.POSITIVE_INFINITY;
    const bd = b.sla_resolution_due_at ? new Date(b.sla_resolution_due_at).getTime() : Number.POSITIVE_INFINITY;
    return ad - bd;
  });

  return (
    <aside className="flex h-full w-[280px] shrink-0 flex-col border-r bg-card/30">
      <div className="flex h-12 items-center justify-between border-b px-3">
        <div className="text-sm font-semibold">Unscheduled</div>
        <div className="text-xs tabular-nums text-muted-foreground">{items.length}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-md bg-muted/50" />
            ))}
          </div>
        ) : sorted.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-muted-foreground">
            Nothing waiting to be scheduled.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {sorted.map((block) => (
              <UnscheduledItem key={block.id} block={block} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
});

function UnscheduledItem({ block }: { block: WorkOrderPlanningBlock }) {
  const statusEntry = statusConfig[block.status_category] ?? statusConfig.new;
  const ref = formatTicketRef('work_order', block.module_number);
  const due = block.sla_resolution_due_at;
  const dueLabel = due ? formatRelativeTime(due) : null;
  const dueOverdue = due ? new Date(due).getTime() < Date.now() : false;

  return (
    <li>
      <div
        className={cn(
          'group relative w-full rounded-md border bg-background p-2 text-left text-xs',
          'opacity-90',
        )}
      >
        <span
          aria-hidden
          className={cn('absolute left-0 top-0 bottom-0 w-1 rounded-l', statusEntry.dotColor)}
        />
        <div className="ml-1.5 flex items-center gap-2">
          <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] font-medium tabular-nums text-muted-foreground">
            {ref}
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{block.title}</span>
          <PriorityIcon priority={block.priority} />
        </div>
        {dueLabel && (
          <div className="ml-1.5 mt-1 text-[11px] tabular-nums text-muted-foreground">
            Due <span className={cn(dueOverdue && 'font-medium text-red-500')}>{dueLabel}</span>
          </div>
        )}
      </div>
    </li>
  );
}
