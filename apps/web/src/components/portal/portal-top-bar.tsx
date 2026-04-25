import { Link } from 'react-router-dom';
import {
  Home,
  FileText,
  CalendarDays,
  UserPlus,
  ShoppingCart,
} from 'lucide-react';
import { PortalNavLink } from './portal-nav-link';
import { PortalLocationPicker } from './portal-location-picker';
import { PortalAccountMenu } from './portal-account-menu';
import { ShellSwitcher } from '@/components/shell-switcher';
import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

export function PortalTopBar() {
  const { branding } = useBranding();
  const { data } = usePortal();

  const tenantName = data?.tenant?.name?.trim() || 'Workplace';
  const locationName = data?.current_location?.name ?? null;

  return (
    <header
      className="sticky top-0 z-40 h-16 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      {/* Desktop: 3-col grid (brand / nav / account) */}
      <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-6 lg:px-8 mx-auto max-w-[1600px]">
        <Link
          to="/portal"
          className="flex items-center gap-3 min-w-0 rounded-md py-1 -my-1 -ml-1 px-1 hover:bg-muted/40 transition-colors"
          style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
        >
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-8 w-auto shrink-0" />
          ) : (
            <div
              className="size-8 shrink-0 rounded-lg bg-gradient-to-br from-indigo-500 to-pink-500"
              aria-hidden
            />
          )}
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="truncate text-[13px] font-semibold tracking-tight">{tenantName}</span>
            {locationName && (
              <span className="truncate text-[11px] text-muted-foreground">{locationName}</span>
            )}
          </span>
        </Link>

        <nav className="flex items-center gap-1" aria-label="Portal navigation">
          <PortalNavLink to="/portal"          label="Home"     icon={Home}         matchExact />
          <PortalNavLink to="/portal/requests" label="Requests" icon={FileText} />
          <PortalNavLink to="/portal/rooms"    label="Rooms"    icon={CalendarDays} />
          <PortalNavLink to="/portal/visitors" label="Visitors" icon={UserPlus} />
          <PortalNavLink to="/portal/order"    label="Order"    icon={ShoppingCart} />
        </nav>

        <div className="flex items-center gap-3 justify-end">
          <PortalLocationPicker />
          <ShellSwitcher />
          <PortalAccountMenu />
        </div>
      </div>

      {/* Mobile: brand + location chip + account */}
      <div className="md:hidden flex h-full items-center gap-2 px-4">
        <Link to="/portal" className="flex items-center gap-2 min-w-0 flex-1">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-7 w-auto shrink-0" />
          ) : (
            <div
              className="size-7 shrink-0 rounded-md bg-gradient-to-br from-indigo-500 to-pink-500"
              aria-hidden
            />
          )}
          <span className="flex flex-col min-w-0 leading-tight">
            <span className="truncate text-[13px] font-semibold tracking-tight">{tenantName}</span>
            {locationName && (
              <span className="truncate text-[10px] text-muted-foreground">{locationName}</span>
            )}
          </span>
        </Link>
        <PortalLocationPicker compact />
        <PortalAccountMenu />
      </div>
    </header>
  );
}
