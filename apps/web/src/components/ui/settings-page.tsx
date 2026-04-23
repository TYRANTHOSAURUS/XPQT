import { ArrowLeft } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';

interface SettingsPageShellProps {
  children: React.ReactNode;
  className?: string;
}

export function SettingsPageShell({ children, className }: SettingsPageShellProps) {
  return (
    <div className={cn('mx-auto w-full max-w-[640px] px-6 py-10 flex flex-col gap-8', className)}>
      {children}
    </div>
  );
}

interface SettingsPageHeaderProps {
  backTo?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export function SettingsPageHeader({ backTo, title, description, actions }: SettingsPageHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      {backTo && (
        <Link
          to={backTo}
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors w-fit"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>
      )}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

interface SettingsSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  /**
   * Wraps children in a bordered card container (default true). Linear-style
   * settings pages use a card per section to visually scope each block. Set
   * false for sections that contain only a single action (e.g. a Delete
   * button) where a card would feel heavy.
   */
  bordered?: boolean;
  /**
   * Internal padding inside the card. Default 'normal' (p-6). Use 'tight'
   * (p-4) for sections containing dense list rows that already have their
   * own padding (e.g. members panel).
   */
  density?: 'normal' | 'tight';
}

export function SettingsSection({
  title,
  description,
  children,
  className,
  bordered = true,
  density = 'normal',
}: SettingsSectionProps) {
  const body = bordered ? (
    <div
      className={cn(
        'rounded-lg border bg-card flex flex-col gap-4',
        density === 'tight' ? 'p-4' : 'p-6',
      )}
    >
      {children}
    </div>
  ) : (
    <div className="flex flex-col gap-4">{children}</div>
  );

  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-medium">{title}</h2>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {body}
    </section>
  );
}

interface ActionConfig {
  label: string;
  onClick?: () => void;
  href?: string;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost';
}

interface SettingsFooterActionsProps {
  primary: ActionConfig;
  secondary?: ActionConfig;
}

export function SettingsFooterActions({ primary, secondary }: SettingsFooterActionsProps) {
  return (
    <div className="flex items-center justify-end gap-2 pt-2">
      {secondary &&
        (secondary.href ? (
          <Link
            to={secondary.href}
            className={cn(
              buttonVariants({ variant: secondary.variant ?? 'ghost' }),
              secondary.disabled && 'pointer-events-none opacity-50',
            )}
          >
            {secondary.label}
          </Link>
        ) : (
          <Button
            variant={secondary.variant ?? 'ghost'}
            onClick={secondary.onClick}
            disabled={secondary.disabled}
          >
            {secondary.label}
          </Button>
        ))}
      {primary.href ? (
        <Link
          to={primary.href}
          className={cn(
            buttonVariants({ variant: primary.variant ?? 'default' }),
            (primary.disabled || primary.loading) && 'pointer-events-none opacity-50',
          )}
        >
          {primary.loading ? 'Saving…' : primary.label}
        </Link>
      ) : (
        <Button
          variant={primary.variant ?? 'default'}
          onClick={primary.onClick}
          disabled={primary.disabled || primary.loading}
        >
          {primary.loading ? 'Saving…' : primary.label}
        </Button>
      )}
    </div>
  );
}
