import { NavLink } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { PORTAL_NAV } from './portal-nav';

/**
 * Mobile bottom nav. Active tabs get an animated dot above the icon;
 * the dot morphs between siblings via the `portal-tab-marker`
 * view-transition name when the route changes.
 *
 * Hidden on md+ — desktop uses the top bar.
 */
export function PortalBottomTabs() {
  return (
    <nav
      aria-label="Portal primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 h-16
                 border-t border-border/60
                 bg-background/85 backdrop-blur
                 supports-[backdrop-filter]:bg-background/70
                 pb-[env(safe-area-inset-bottom)]
                 grid grid-cols-5 items-stretch
                 [touch-action:manipulation]
                 [-webkit-tap-highlight-color:transparent]"
    >
      {PORTAL_NAV.map((t) => (
        <BottomTab
          key={t.to}
          to={t.to}
          label={t.label}
          icon={t.icon}
          matchExact={t.matchExact}
        />
      ))}
    </nav>
  );
}

interface BottomTabProps {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  matchExact: boolean;
}

function BottomTab({ to, label, icon: Icon, matchExact }: BottomTabProps) {
  return (
    <NavLink
      to={to}
      end={matchExact}
      viewTransition
      className={({ isActive }) =>
        cn(
          'relative flex min-h-12 flex-col items-center justify-center gap-1 text-[11px]',
          'transition-[color,transform] active:translate-y-px',
          'text-muted-foreground',
          isActive && 'text-foreground font-medium',
        )
      }
      style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span
              aria-hidden
              className="absolute top-1.5 left-1/2 -translate-x-1/2 size-1 rounded-full bg-foreground"
              style={{ viewTransitionName: 'portal-tab-marker' }}
            />
          )}
          <Icon className="size-5" aria-hidden />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}
