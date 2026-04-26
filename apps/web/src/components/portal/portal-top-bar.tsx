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
import { SearchTrigger } from '@/components/command-palette/search-trigger';
import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

export function PortalTopBar() {
  const { branding } = useBranding();
  const { data } = usePortal();

  const tenantName = data?.tenant?.name?.trim() || 'Workplace';

  return (
    <header className="sticky top-0 z-40 h-16 bg-background">
      {/* Desktop: brand · nav · actions */}
      <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] items-center gap-6 px-3 md:px-4 lg:px-6 mx-auto max-w-[1600px]">
        <Link
          to="/portal"
          className="group inline-flex items-center gap-2.5 min-w-0 -ml-1 rounded-md px-1 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-7 w-auto shrink-0" />
          ) : (
            <div
              className="size-6 shrink-0 rounded-md bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500 ring-1 ring-foreground/10"
              aria-hidden
            />
          )}
          <span className="truncate text-[13px] font-semibold tracking-tight text-foreground/90 group-hover:text-foreground transition-colors">
            {tenantName}
          </span>
        </Link>

        <nav className="flex items-center gap-0.5" aria-label="Portal navigation">
          <PortalNavLink to="/portal"          label="Home"     icon={Home}         matchExact />
          <PortalNavLink to="/portal/requests" label="Requests" icon={FileText} />
          <PortalNavLink to="/portal/rooms"    label="Rooms"    icon={CalendarDays} />
          <PortalNavLink to="/portal/visitors" label="Visitors" icon={UserPlus} />
          <PortalNavLink to="/portal/order"    label="Order"    icon={ShoppingCart} />
        </nav>

        <div className="flex items-center gap-2 justify-end">
          <SearchTrigger variant="bar" className="w-[220px] xl:w-[260px]" />
          <PortalLocationPicker />
          <div className="h-5 w-px bg-border/70" aria-hidden />
          <ShellSwitcher />
          <PortalAccountMenu />
        </div>
      </div>

      {/* Mobile: brand · search · location · account */}
      <div className="md:hidden flex h-full items-center gap-2 px-3">
        <Link to="/portal" className="flex items-center gap-2 min-w-0 flex-1">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-6 w-auto shrink-0" />
          ) : (
            <div
              className="size-6 shrink-0 rounded-md bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-pink-500"
              aria-hidden
            />
          )}
          <span className="truncate text-[13px] font-semibold tracking-tight">{tenantName}</span>
        </Link>
        <SearchTrigger variant="icon" />
        <PortalLocationPicker compact />
        <PortalAccountMenu />
      </div>
    </header>
  );
}
