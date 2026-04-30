import { Link } from 'react-router-dom';
import { PortalNavLink } from './portal-nav-link';
import { PortalLocationPicker } from './portal-location-picker';
import { PortalAccountMenu } from './portal-account-menu';
import { PortalBrandMark } from './portal-brand-mark';
import { PORTAL_NAV } from './portal-nav';
import { ShellSwitcher } from '@/components/shell-switcher';
import { SearchTrigger } from '@/components/command-palette/search-trigger';
import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

export function PortalTopBar() {
  const { branding } = useBranding();
  const { data } = usePortal();

  const tenantName = data?.tenant?.name?.trim() || 'Workplace';
  const tenantLabel = (
    <span translate="no" className="truncate text-[13px] font-semibold tracking-tight text-foreground">
      {tenantName}
    </span>
  );

  return (
    <header
      className="
        sticky top-0 z-40 h-16
        bg-background/85 backdrop-blur
        supports-[backdrop-filter]:bg-background/70
        border-b border-border/50
      "
    >
      {/* Desktop: brand · nav · actions */}
      <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] items-center gap-6 px-3 md:px-4 lg:px-6 mx-auto max-w-[1600px]">
        <Link
          to="/portal"
          viewTransition
          className="inline-flex items-center gap-2.5 min-w-0 -ml-1 rounded-md px-1 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {branding?.logo_light_url ? (
            <img
              src={branding.logo_light_url}
              alt=""
              width={28}
              height={28}
              className="h-7 w-auto shrink-0"
            />
          ) : (
            <PortalBrandMark size="size-6" />
          )}
          {tenantLabel}
        </Link>

        <nav className="flex items-center gap-0.5" aria-label="Portal navigation">
          {PORTAL_NAV.map((item) => (
            <PortalNavLink
              key={item.to}
              to={item.to}
              label={item.label}
              icon={item.icon}
              matchExact={item.matchExact}
            />
          ))}
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
        <Link
          to="/portal"
          viewTransition
          className="flex items-center gap-2 min-w-0 flex-1 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {branding?.logo_light_url ? (
            <img
              src={branding.logo_light_url}
              alt=""
              width={24}
              height={24}
              className="h-6 w-auto shrink-0"
            />
          ) : (
            <PortalBrandMark size="size-6" />
          )}
          {tenantLabel}
        </Link>
        <SearchTrigger variant="icon" />
        <PortalLocationPicker compact />
        <PortalAccountMenu />
      </div>
    </header>
  );
}
