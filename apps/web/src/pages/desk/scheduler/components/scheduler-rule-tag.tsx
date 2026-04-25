import { AlertTriangle, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export type RuleTagOutcome = 'allow' | 'warn' | 'require_approval' | 'deny';

interface Props {
  outcome: RuleTagOutcome;
  message?: string | null;
  className?: string;
}

/**
 * Tiny inline tag the row paints over a hovered cell when "Booking for:
 * <person>" is set. The full-cell amber tint / hatched dim is applied by
 * the row at a layer above the empty-cell background; this component is
 * the leading-edge label that explains why.
 *
 * Hover → tooltip with the rule's denial / warning message.
 */
export function SchedulerRuleTag({ outcome, message, className }: Props) {
  if (outcome === 'allow') return null;

  const config = (() => {
    switch (outcome) {
      case 'deny':
        return {
          label: 'Denied',
          icon: <Lock className="size-3" />,
          className:
            'bg-red-50 text-red-700 border-red-200 dark:bg-red-500/10 dark:text-red-400 dark:border-red-500/30',
        };
      case 'require_approval':
        return {
          label: 'Needs approval',
          icon: <AlertTriangle className="size-3" />,
          className:
            'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:border-amber-500/30',
        };
      case 'warn':
        return {
          label: 'Warning',
          icon: <AlertTriangle className="size-3" />,
          className:
            'bg-yellow-50 text-yellow-800 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/30',
        };
    }
  })();

  const tag = (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium',
        config.className,
        className,
      )}
    >
      {config.icon}
      {config.label}
    </span>
  );

  if (!message) return tag;

  return (
    <Tooltip>
      <TooltipTrigger render={<span>{tag}</span>} />
      <TooltipContent className="max-w-[260px] text-xs">{message}</TooltipContent>
    </Tooltip>
  );
}
