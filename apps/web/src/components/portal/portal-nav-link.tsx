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
 * foreground text + 2px underline that morphs between siblings via the
 * `portal-nav-indicator` view-transition name. Hover: muted background tint.
 *
 * The press feedback (`active:translate-y-px`) matches the bottom tabs so
 * the two nav surfaces feel like one component family.
 */
export function PortalNavLink({ to, label, icon: Icon, matchExact }: Props) {
  return (
    <NavLink
      to={to}
      end={matchExact}
      viewTransition
      className={({ isActive }) =>
        cn(
          'group relative inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium',
          'transition-[color,background-color,transform] active:translate-y-px',
          'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
          // Single signal: the morphing underline marks active. Hover gets
          // a subtle bg tint for affordance only — never on the active link.
          isActive
            ? 'text-foreground'
            : 'text-muted-foreground/90 hover:bg-foreground/[0.04] hover:text-foreground',
        )
      }
      style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
    >
      {({ isActive }) => (
        <>
          <Icon className="size-4 shrink-0" />
          <span>{label}</span>
          {isActive && (
            <span
              aria-hidden
              className="absolute -bottom-[15px] left-2 right-2 h-[2px] rounded-full bg-foreground"
              style={{ viewTransitionName: 'portal-nav-indicator' }}
            />
          )}
        </>
      )}
    </NavLink>
  );
}
