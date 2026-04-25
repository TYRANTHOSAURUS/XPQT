import { Link } from 'react-router-dom';
import { PortalNavLink } from './portal-nav-link';
import { PortalLocationPicker } from './portal-location-picker';
import { PortalAccountMenu } from './portal-account-menu';
import { useBranding } from '@/hooks/use-branding';
import { usePortal } from '@/providers/portal-provider';

export function PortalTopBar() {
  const { branding } = useBranding();
  const { data } = usePortal();

  return (
    <header
      className="sticky top-0 z-40 h-14 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75"
      style={{ transitionTimingFunction: 'var(--ease-smooth)' }}
    >
      {/* Desktop: 3-col grid (brand / nav / account) */}
      <div className="hidden md:grid h-full grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-6 lg:px-8 mx-auto max-w-[1600px]">
        <Link to="/portal" className="flex items-center gap-2 min-w-0">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-6 w-auto" />
          ) : (
            <div className="size-6 rounded-md bg-gradient-to-br from-indigo-500 to-pink-500" aria-hidden />
          )}
          <span className="truncate font-semibold tracking-tight text-sm">
            {data?.current_location?.name ?? 'Portal'}
          </span>
        </Link>

        <nav className="flex items-center gap-6" aria-label="Portal navigation">
          <PortalNavLink to="/portal"          label="Home"     matchExact />
          <PortalNavLink to="/portal/requests" label="Requests" />
          <PortalNavLink to="/portal/rooms"    label="Rooms"    />
          <PortalNavLink to="/portal/visitors" label="Visitors" />
          <PortalNavLink to="/portal/order"    label="Order"    />
        </nav>

        <div className="flex items-center gap-3 justify-end">
          <PortalLocationPicker />
          <PortalAccountMenu />
        </div>
      </div>

      {/* Mobile: brand + location chip + account */}
      <div className="md:hidden flex h-full items-center gap-2 px-4">
        <Link to="/portal" className="flex items-center gap-2 min-w-0 flex-1">
          {branding?.logo_light_url ? (
            <img src={branding.logo_light_url} alt="" className="h-5 w-auto" />
          ) : (
            <div className="size-5 rounded bg-gradient-to-br from-indigo-500 to-pink-500" aria-hidden />
          )}
          <span className="truncate font-semibold tracking-tight text-sm">
            {data?.current_location?.name ?? 'Portal'}
          </span>
        </Link>
        <PortalLocationPicker compact />
        <PortalAccountMenu />
      </div>
    </header>
  );
}
