import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Vertical padding preset. `default` ≈ py-12, `compact` ≈ py-6, `hero` ≈ py-20 for full-page "not found" screens. */
  size?: 'compact' | 'default' | 'hero';
}

const paddingBySize: Record<NonNullable<EmptyStateProps['size']>, string> = {
  compact: 'py-6',
  default: 'py-12',
  hero: 'py-20',
};

/**
 * Generic empty-state / not-found placeholder. Use inside any container that needs a
 * "nothing here yet" message. For tables, keep using TableEmpty (which lives in a <tr>).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  size = 'default',
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        paddingBySize[size],
        className,
      )}
    >
      {Icon && (
        <div className="mb-3 rounded-full bg-muted p-3 text-muted-foreground">
          <Icon className="h-5 w-5" />
        </div>
      )}
      <p className="font-medium">{title}</p>
      {description && (
        <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
