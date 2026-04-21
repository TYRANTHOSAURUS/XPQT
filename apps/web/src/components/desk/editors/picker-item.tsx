import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PickerOption {
  id: string;
  label: string;
  sublabel?: string | null;
  /** Optional leading node rendered on the left of the row (e.g. an avatar or icon). */
  leading?: ReactNode;
}

export interface PickerItemBodyProps {
  leading?: ReactNode;
  label: string;
  sublabel?: string | null;
  /** Node rendered on the right (e.g. a check mark for single-select). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * Shared row layout for picker menus: optional leading slot, stacked label + sublabel,
 * optional trailing slot. Sublabel wraps under the label instead of beside it so long
 * names are never truncated by email/metadata to their right.
 */
export function PickerItemBody({ leading, label, sublabel, trailing, className }: PickerItemBodyProps) {
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-2.5', className)}>
      {leading && <span className="flex shrink-0 items-center">{leading}</span>}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm leading-tight">{label}</span>
        {sublabel && (
          <span className="truncate text-[11px] leading-tight text-muted-foreground mt-0.5">
            {sublabel}
          </span>
        )}
      </div>
      {trailing && <span className="flex shrink-0 items-center">{trailing}</span>}
    </div>
  );
}
