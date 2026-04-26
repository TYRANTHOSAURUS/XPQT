import { Link } from 'react-router-dom';
import {
  Boxes,
  ChefHat,
  ListChecks,
  Truck,
} from 'lucide-react';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';

/**
 * /admin/booking-services — index page.
 *
 * Card layout per spec §6.1: vendors / menus / items + a fourth card for
 * the rules engine. Vendors and menus already have shipped admin pages
 * (/admin/vendors, /admin/vendor-menus, /admin/catalog-hierarchy) — we
 * link to them rather than duplicating a half-baked surface here.
 */
export function BookingServicesIndexPage() {
  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin"
        title="Booking services"
        description="Catering, AV, equipment, and room-setup services. Lives next to the room booking module — bundles join the two."
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Card
          to="/admin/vendors"
          icon={<Truck className="size-5" />}
          title="Vendors"
          body="External providers (caterers, AV teams, equipment rental). Configure service areas + priority + active windows."
        />
        <Card
          to="/admin/vendor-menus"
          icon={<ChefHat className="size-5" />}
          title="Menus"
          body="Banqueting menus and equipment catalogues. Vendor- or internal-team-owned; building-scoped or tenant-wide."
        />
        <Card
          to="/admin/catalog-hierarchy"
          icon={<Boxes className="size-5" />}
          title="Catalog items"
          body="The leaf items that menus list — sandwiches, projectors, cleaning slots. Used by service rules and bundle templates."
        />
        <Card
          to="/admin/booking-services/rules"
          icon={<ListChecks className="size-5" />}
          title="Service rules"
          body="Approval routing, lead-time enforcement, role-restricted items. Mirrors the room-booking rule engine, scoped to catalog items + menus."
        />
      </div>
    </SettingsPageShell>
  );
}

function Card({
  to,
  icon,
  title,
  body,
}: {
  to: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="group rounded-xl border bg-card p-4 transition-colors hover:bg-accent/30"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold tracking-tight group-hover:underline">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground text-pretty">{body}</p>
        </div>
      </div>
    </Link>
  );
}
