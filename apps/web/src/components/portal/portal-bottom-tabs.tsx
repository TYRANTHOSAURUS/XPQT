import { NavLink, Link } from 'react-router-dom';
import { Home, FileText, CalendarDays, UserPlus, ShoppingCart, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Mobile bottom nav: 5 tabs + a floating "Submit a request" FAB above
 * the bar. Active tabs get an animated dot above the icon; the dot
 * morphs between siblings via the `portal-tab-marker` view-transition
 * name when the route changes.
 *
 * Hidden on md+ — desktop uses the top bar.
 */

const tabs = [
  { to: '/portal',          label: 'Home',     icon: Home,         matchExact: true },
  { to: '/portal/requests', label: 'Requests', icon: FileText,     matchExact: false },
  { to: '/portal/rooms',    label: 'Rooms',    icon: CalendarDays, matchExact: false },
  { to: '/portal/visitors', label: 'Visitors', icon: UserPlus,     matchExact: false },
  { to: '/portal/order',    label: 'Order',    icon: ShoppingCart, matchExact: false },
] as const;

export function PortalBottomTabs() {
  return (
    <>
      {/* Floating submit FAB — sits above the tab bar, slightly off-grid */}
      <Link
        to="/portal/submit"
        aria-label="Submit a request"
        viewTransition
        className="
          md:hidden fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] right-4 z-50
          inline-flex size-12 items-center justify-center rounded-full
          bg-foreground text-background
          shadow-[0_4px_14px_-2px_rgba(0,0,0,0.3)]
          ring-1 ring-foreground/10
          transition-transform active:scale-[0.94]
        "
        style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
      >
        <Plus className="size-5" strokeWidth={2.4} />
      </Link>

      <nav
        aria-label="Portal primary"
        className="md:hidden fixed bottom-0 inset-x-0 z-40 h-16
                   border-t border-border/60
                   bg-background/85 backdrop-blur
                   supports-[backdrop-filter]:bg-background/70
                   pb-[env(safe-area-inset-bottom)]
                   grid grid-cols-5 items-stretch"
      >
        {tabs.map((t) => <BottomTab key={t.to} {...t} />)}
      </nav>
    </>
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
      aria-label={label}
      viewTransition
      className={({ isActive }) =>
        cn(
          'relative flex flex-col items-center justify-center gap-1 text-[11px]',
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
          <Icon className="size-5" />
          <span>{label}</span>
        </>
      )}
    </NavLink>
  );
}
