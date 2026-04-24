import { NavLink } from 'react-router-dom';
import { Home, FileText, CalendarDays, UserPlus, ShoppingCart } from 'lucide-react';
import { cn } from '@/lib/utils';

const tabs = [
  { to: '/portal',          label: 'Home',     icon: Home,         matchExact: true },
  { to: '/portal/requests', label: 'Requests', icon: FileText,     matchExact: false },
  { to: '/portal/rooms',    label: 'Rooms',    icon: CalendarDays, matchExact: false },
  { to: '/portal/visitors', label: 'Visitors', icon: UserPlus,     matchExact: false },
  { to: '/portal/order',    label: 'Order',    icon: ShoppingCart, matchExact: false },
] as const;

export function PortalBottomTabs() {
  return (
    <nav
      aria-label="Portal primary"
      className="md:hidden fixed bottom-0 inset-x-0 z-40 h-16 border-t bg-background/95 backdrop-blur
                 supports-[backdrop-filter]:bg-background/85
                 pb-[env(safe-area-inset-bottom)]
                 grid grid-cols-5"
    >
      {tabs.map(({ to, label, icon: Icon, matchExact }) => (
        <NavLink
          key={to}
          to={to}
          end={matchExact}
          aria-label={label}
          className={({ isActive }) =>
            cn(
              'flex flex-col items-center justify-center gap-1 text-[11px] transition-colors',
              'text-muted-foreground active:translate-y-px',
              isActive && 'text-foreground font-medium',
            )
          }
          style={{ transitionTimingFunction: 'var(--ease-swift-out)', transitionDuration: '160ms' }}
        >
          <Icon className="size-5" />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
