import { type LucideIcon } from 'lucide-react';
import { type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface SummaryCardProps {
  icon: LucideIcon;
  title: string;
  emptyPrompt: string;
  onChange?: () => void;
  filled?: boolean;
  summary?: ReactNode;
  onRemove?: () => void;
  suggested?: boolean;
  suggestionReason?: string;
}

/**
 * Shared primitive for the right-pane summary stack. Two states:
 *
 * - **Empty**: a single full-card `<button>` that invites the user to make
 *   a decision (e.g. "Pick a room"). When `suggested` is set, a chip is
 *   rendered on the right with the reason as a native tooltip.
 * - **Filled**: the card is no longer a single button. The body renders
 *   the caller-supplied `summary` ReactNode and an inline action row with
 *   `[Change]` and (optionally) `[Remove]` buttons.
 *
 * The Suggested chip styling carries over from the legacy add-in card so
 * the visual treatment stays consistent through the redesign.
 */
export function SummaryCard({
  icon: Icon,
  title,
  emptyPrompt,
  onChange,
  filled = false,
  summary,
  onRemove,
  suggested = false,
  suggestionReason,
}: SummaryCardProps) {
  if (!filled) {
    return (
      <button
        type="button"
        onClick={onChange}
        aria-label={`${title}: ${emptyPrompt}`}
        className={cn(
          'flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
          'transition-colors duration-[150ms] ease-[var(--ease-snap)]',
          'hover:bg-muted/50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring rounded-md',
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-foreground/40" aria-hidden />
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">{title}</div>
            <div className="truncate text-sm text-muted-foreground">{emptyPrompt}</div>
          </div>
        </div>
        {suggested && (
          <span
            className={cn(
              'shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[11px] text-foreground/70',
              'tabular-nums',
            )}
            title={suggestionReason}
            aria-label={suggestionReason ? `Suggested: ${suggestionReason}` : 'Suggested'}
          >
            Suggested
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="p-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className="mt-0.5 size-4 shrink-0 text-foreground" aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {summary !== undefined && (
            <div className="mt-1 text-sm text-muted-foreground">{summary}</div>
          )}
        </div>
      </div>
      <div
        className={cn(
          'mt-2 flex items-center justify-end gap-1 border-t border-border/60 pt-2',
        )}
      >
        <button
          type="button"
          onClick={onChange}
          className={cn(
            'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium',
            'text-muted-foreground transition-colors duration-[120ms] ease-[var(--ease-snap)]',
            'hover:bg-muted/50 hover:text-foreground',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          Change
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className={cn(
              'inline-flex items-center rounded-md px-2 py-1 text-xs font-medium',
              'text-muted-foreground transition-colors duration-[120ms] ease-[var(--ease-snap)]',
              'hover:bg-muted/50 hover:text-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            )}
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
