import { Home, FileText, CalendarDays, UserPlus, ShoppingCart } from 'lucide-react';
import type { ComponentType } from 'react';

export interface PortalNavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  matchExact: boolean;
}

/**
 * Single source of truth for the portal's primary nav entries. Consumed
 * by the desktop top bar and the mobile bottom-tab nav so both shells
 * stay in lockstep.
 */
export const PORTAL_NAV: readonly PortalNavItem[] = [
  { to: '/portal',          label: 'Home',     icon: Home,         matchExact: true  },
  { to: '/portal/requests', label: 'Requests', icon: FileText,     matchExact: false },
  { to: '/portal/rooms',    label: 'Rooms',    icon: CalendarDays, matchExact: false },
  { to: '/portal/visitors', label: 'Visitors', icon: UserPlus,     matchExact: false },
  { to: '/portal/order',    label: 'Order',    icon: ShoppingCart, matchExact: false },
] as const;
