import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface InlineProperty {
  label: string;
  icon?: ReactNode;
  /** The interactive trigger (a Popover trigger, Select, click-to-edit button, etc.) */
  children: ReactNode;
  className?: string;
}

/**
 * One sidebar row: muted label on top, interactive trigger below.
 * Standardises spacing so every field looks identical regardless of editor type.
 */
export function InlineProperty({ label, icon, children, className }: InlineProperty) {
  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">
        {icon}
        {label}
      </div>
      {children}
    </div>
  );
}
