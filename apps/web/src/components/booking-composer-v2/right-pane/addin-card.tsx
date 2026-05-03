import { type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface AddinCardProps {
  icon: LucideIcon;
  title: string;
  emptyPrompt: string;
  summary?: string;
  filled: boolean;
  expanded: boolean;
  onToggle: (next: boolean) => void;
  suggested?: boolean;
  suggestionReason?: string;
  children?: React.ReactNode;
}

/**
 * Collapsed-state card on the right pane. ~64px tall when collapsed;
 * expands inline via grid-template-rows 0fr→1fr (no measure-and-set).
 * Per spec, opening one card does NOT auto-collapse siblings —
 * AddinStack decides single-expand semantics.
 */
export function AddinCard({
  icon: Icon,
  title,
  emptyPrompt,
  summary,
  filled,
  expanded,
  onToggle,
  suggested,
  suggestionReason,
  children,
}: AddinCardProps) {
  return (
    <article
      className={cn(
        'overflow-hidden rounded-lg border bg-card transition-colors',
        filled ? 'border-foreground/10' : 'border-foreground/5',
        '[transition-duration:120ms] [transition-timing-function:var(--ease-snap)]',
      )}
    >
      <button
        type="button"
        onClick={() => onToggle(!expanded)}
        className={cn(
          'group/card flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left',
          'transition-colors hover:bg-accent/50',
          '[transition-duration:100ms] [transition-timing-function:var(--ease-snap)]',
        )}
        aria-expanded={expanded}
        aria-label={title}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon
            className={cn(
              'size-4 shrink-0',
              filled ? 'text-foreground' : 'text-foreground/40',
            )}
            aria-hidden
          />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-foreground">{title}</div>
            <div className="truncate text-[12px] text-muted-foreground">
              {summary ?? emptyPrompt}
            </div>
          </div>
        </div>
        {suggested && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={cn(
                      'shrink-0 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[11px] text-foreground/70',
                      'tabular-nums',
                    )}
                    aria-label={suggestionReason ? `Suggested: ${suggestionReason}` : 'Suggested'}
                  >
                    Suggested
                  </span>
                }
              />
              {suggestionReason && (
                <TooltipContent side="left" align="center" className="max-w-[220px]">
                  <p className="text-xs">{suggestionReason}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        )}
      </button>
      <div
        className={cn(
          'grid transition-[grid-template-rows] ease-[var(--ease-smooth)]',
          expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        )}
        style={{ transitionDuration: '240ms' }}
        aria-hidden={!expanded}
      >
        <div className="overflow-hidden">
          {expanded && (
            <div className="border-t border-border/60 px-3 py-3">{children}</div>
          )}
        </div>
      </div>
    </article>
  );
}
