import { NavLink } from 'react-router-dom';
import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

interface Props {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  matchExact?: boolean;
}

/**
 * Top-nav link with icon + label. Active state: filled background pill +
 * foreground text. Hover: muted background tint.
 *
 * Hit-target is generous (h-9, px-3, gap-2) so the bar feels touch-friendly
 * on both desktop and tablet.
 */
export function PortalNavLink({ to, label, icon: Icon, matchExact }: Props) {
  return (
    <NavLink
      to={to}
      end={matchExact}
      className={({ isActive }) =>
        cn(
          'group inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium',
          'transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          isActive
            ? 'bg-foreground/10 text-foreground'
            : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        )
      }
      style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
    >
      <Icon className="size-4 shrink-0" />
      <span>{label}</span>
    </NavLink>
  );
}
