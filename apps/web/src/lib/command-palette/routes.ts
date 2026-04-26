import type { LucideIcon } from 'lucide-react';
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Inbox,
  LayoutDashboard,
  PlusCircle,
  Search,
  Settings,
  Ticket,
  User,
} from 'lucide-react';
import { adminNavGroups } from '@/lib/admin-nav';

export type RouteRoleScope = 'public' | 'agent' | 'admin';

export interface PaletteRoute {
  /** Stable id used for cmdk keys; not the URL. */
  id: string;
  title: string;
  /** Aliases improve fuzzy match on synonyms ("permissions" → roles). */
  aliases?: string[];
  description?: string;
  path: string;
  section: 'Portal' | 'Service Desk' | 'Admin';
  icon: LucideIcon;
  /** Lowest role required to see / use this entry. */
  scope: RouteRoleScope;
}

export interface PaletteAction extends PaletteRoute {
  /** Distinguishes from a navigation route in the UI grouping. */
  type: 'action';
}

export type PaletteEntry =
  | (PaletteRoute & { type: 'route' })
  | PaletteAction;

const portalRoutes: PaletteEntry[] = [
  {
    type: 'route',
    id: 'portal-home',
    title: 'Home',
    path: '/portal',
    section: 'Portal',
    icon: LayoutDashboard,
    scope: 'public',
    description: 'Employee portal home',
  },
  {
    type: 'route',
    id: 'portal-my-requests',
    title: 'My requests',
    aliases: ['tickets', 'requests', 'my tickets'],
    path: '/portal/requests',
    section: 'Portal',
    icon: Ticket,
    scope: 'public',
  },
  {
    type: 'route',
    id: 'portal-rooms',
    title: 'Book a room',
    aliases: ['room booking', 'meeting room', 'reserve'],
    path: '/portal/rooms',
    section: 'Portal',
    icon: CalendarDays,
    scope: 'public',
  },
  {
    type: 'route',
    id: 'portal-bookings',
    title: 'My bookings',
    aliases: ['reservations'],
    path: '/portal/me/bookings',
    section: 'Portal',
    icon: ClipboardList,
    scope: 'public',
  },
  {
    type: 'route',
    id: 'portal-profile',
    title: 'Profile',
    path: '/portal/profile',
    section: 'Portal',
    icon: User,
    scope: 'public',
  },
];

const portalActions: PaletteEntry[] = [
  {
    type: 'action',
    id: 'action-new-request',
    title: 'Submit a new request',
    aliases: ['create ticket', 'new ticket', 'submit'],
    path: '/portal/submit',
    section: 'Portal',
    icon: PlusCircle,
    scope: 'public',
  },
  {
    type: 'action',
    id: 'action-book-room',
    title: 'Book a room',
    aliases: ['new booking', 'reserve room'],
    path: '/portal/rooms',
    section: 'Portal',
    icon: CalendarDays,
    scope: 'public',
  },
];

const deskRoutes: PaletteEntry[] = [
  {
    type: 'route',
    id: 'desk-inbox',
    title: 'Inbox',
    aliases: ['queue', 'desk inbox'],
    path: '/desk/inbox',
    section: 'Service Desk',
    icon: Inbox,
    scope: 'agent',
  },
  {
    type: 'route',
    id: 'desk-tickets',
    title: 'Tickets',
    aliases: ['all tickets'],
    path: '/desk/tickets',
    section: 'Service Desk',
    icon: Ticket,
    scope: 'agent',
  },
  {
    type: 'route',
    id: 'desk-approvals',
    title: 'Approvals',
    aliases: ['pending approvals'],
    path: '/desk/approvals',
    section: 'Service Desk',
    icon: CheckCircle2,
    scope: 'agent',
  },
  {
    type: 'route',
    id: 'desk-scheduler',
    title: 'Scheduler',
    aliases: ['rooms scheduler'],
    path: '/desk/scheduler',
    section: 'Service Desk',
    icon: CalendarDays,
    scope: 'agent',
  },
  {
    type: 'route',
    id: 'desk-bookings',
    title: 'Bookings',
    path: '/desk/bookings',
    section: 'Service Desk',
    icon: ClipboardList,
    scope: 'agent',
  },
  {
    type: 'route',
    id: 'desk-reports',
    title: 'Reports',
    aliases: ['analytics', 'metrics'],
    path: '/desk/reports/overview',
    section: 'Service Desk',
    icon: LayoutDashboard,
    scope: 'agent',
  },
];

const deskActions: PaletteEntry[] = [
  {
    type: 'action',
    id: 'action-new-ticket-desk',
    title: 'Create a ticket',
    aliases: ['new ticket', 'log ticket'],
    path: '/desk/tickets?new=1',
    section: 'Service Desk',
    icon: PlusCircle,
    scope: 'agent',
  },
];

const adminAliasMap: Record<string, string[]> = {
  '/admin/users': ['operators', 'accounts'],
  '/admin/user-roles': ['permissions', 'rbac', 'roles'],
  '/admin/persons': ['employees', 'directory'],
  '/admin/teams': ['groups', 'desks'],
  '/admin/locations': ['spaces', 'sites', 'buildings', 'floors'],
  '/admin/assets': ['equipment', 'devices'],
  '/admin/vendors': ['suppliers'],
  '/admin/sla-policies': ['sla'],
  '/admin/webhooks': ['integrations'],
  '/admin/workflow-templates': ['workflows', 'automations'],
  '/admin/notifications': ['emails', 'alerts'],
  '/admin/criteria-sets': ['expressions'],
  '/admin/business-hours': ['operating hours', 'work hours'],
  '/admin/branding': ['theme', 'logo', 'colors'],
  '/admin/calendar-sync': ['outlook', 'google calendar'],
  '/admin/room-booking-rules': ['booking rules'],
  '/admin/routing-studio': ['routing', 'dispatch'],
};

const adminRoutes: PaletteEntry[] = adminNavGroups.flatMap((group) =>
  group.items.map<PaletteEntry>((item) => ({
    type: 'route',
    id: `admin-${item.path}`,
    title: item.title,
    aliases: adminAliasMap[item.path],
    description: item.description,
    path: item.path,
    section: 'Admin',
    icon: item.icon,
    scope: 'admin',
  })),
);

export const paletteRoutes: PaletteEntry[] = [
  ...portalRoutes,
  ...deskRoutes,
  ...adminRoutes,
];

export const paletteActions: PaletteEntry[] = [
  ...portalActions,
  ...deskActions,
];

export function visibleEntries(
  entries: PaletteEntry[],
  scope: RouteRoleScope,
): PaletteEntry[] {
  const allowed = scope === 'admin' ? 3 : scope === 'agent' ? 2 : 1;
  const rank = (s: RouteRoleScope) => (s === 'admin' ? 3 : s === 'agent' ? 2 : 1);
  return entries.filter((e) => rank(e.scope) <= allowed);
}

export const fallbackRouteIcon = Search;
export const fallbackSettingsIcon = Settings;
