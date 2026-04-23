import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SettingsGroupProps {
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

/**
 * Vertical list of SettingsRows. No card border. Rows separated by subtle
 * dividers. Use for "stacks of individual decisions" per Linear's pattern —
 * not for grouping form fields that are saved together.
 */
export function SettingsGroup({ title, description, children, className }: SettingsGroupProps) {
  return (
    <section className={cn('flex flex-col gap-3', className)}>
      {(title || description) && (
        <div className="flex flex-col gap-1">
          {title && <h2 className="text-base font-medium">{title}</h2>}
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="flex flex-col rounded-lg border bg-card divide-y overflow-hidden">
        {children}
      </div>
    </section>
  );
}

interface SettingsRowProps {
  label: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /**
   * When provided, the entire row becomes a button that opens a deeper view
   * (modal, sub-page). Renders a trailing chevron after the control.
   */
  onClick?: () => void;
  className?: string;
}

/**
 * One row with label + description on the left and a control (or trailing
 * text + chevron) on the right. No borders — just generous padding and a
 * divider to the next row.
 */
export function SettingsRow({ label, description, children, onClick, className }: SettingsRowProps) {
  const content = (
    <div
      className={cn(
        'flex items-center gap-4 px-4 py-3',
        onClick && 'cursor-pointer hover:bg-muted/40 transition-colors',
        className,
      )}
    >
      <div className="flex flex-col gap-0.5 min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {children}
        {onClick && <ChevronRight className="size-4 text-muted-foreground" />}
      </div>
    </div>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="text-left w-full block">
        {content}
      </button>
    );
  }
  return content;
}

/**
 * A row whose trailing content is a short display string (e.g. "Integrations
 * Bot" or "5 rules" or "None"). Use alongside `onClick` to produce Linear's
 * "pick something" pattern.
 */
export function SettingsRowValue({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>;
}
