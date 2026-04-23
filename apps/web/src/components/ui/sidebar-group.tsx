import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

export interface SidebarGroupProps {
  title: string;
  children: ReactNode;
  /** Right-aligned node in the header (e.g. an action button). Stays outside the trigger. */
  action?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
}

/**
 * Linear-style collapsible card for sidebar property groups. Gives each logical
 * cluster of fields its own container so separation is visible without extra dividers.
 */
export function SidebarGroup({
  title,
  children,
  action,
  defaultOpen = true,
  className,
  contentClassName,
}: SidebarGroupProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn(
        'rounded-lg bg-muted/30',
        className,
      )}
    >
      <div className="flex h-10 items-center justify-between gap-2 pl-3 pr-2">
        <CollapsibleTrigger
          className="flex h-full flex-1 items-center justify-between text-left outline-none"
          aria-label={`Toggle ${title}`}
        >
          <span className="text-xs font-medium text-foreground/80">
            {title}
          </span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
              !open && '-rotate-90',
            )}
          />
        </CollapsibleTrigger>
        {action && <div className="flex items-center">{action}</div>}
      </div>
      <CollapsibleContent>
        <div className={cn('space-y-3 px-3 pb-3 pt-1', contentClassName)}>
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
