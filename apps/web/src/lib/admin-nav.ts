import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  BookOpen,
  Building2,
  Calendar,
  Clock,
  Compass,
  Filter,
  FormInput,
  GitBranch,
  HandCoins,
  Layers,
  ListTree,
  MapPin,
  Network,
  Package,
  Palette,
  PersonStanding,
  Route,
  Shield,
  Store,
  UserCog,
  Users,
  Webhook,
} from 'lucide-react';
import { features } from '@/lib/features';

export interface AdminNavItem {
  title: string;
  path: string;
  icon: LucideIcon;
  description: string;
}

export interface AdminNavGroup {
  label: string;
  items: AdminNavItem[];
}

const legacyRoutingNav: AdminNavItem[] = [
  {
    title: 'Routing Rules',
    path: '/admin/routing-rules',
    icon: Route,
    description: 'Conditional rules that direct tickets to teams',
  },
  {
    title: 'Location Teams',
    path: '/admin/location-teams',
    icon: MapPin,
    description: 'Team coverage per location',
  },
  {
    title: 'Space Groups',
    path: '/admin/space-groups',
    icon: Layers,
    description: 'Reusable groups of spaces for routing',
  },
  {
    title: 'Domain Hierarchy',
    path: '/admin/domain-parents',
    icon: Network,
    description: 'Parent-child request type inheritance',
  },
];

const configItems: AdminNavItem[] = [
  {
    title: 'Service Catalog',
    path: '/admin/catalog-hierarchy',
    icon: ListTree,
    description: 'Services, subtypes, and intake forms',
  },
  {
    title: 'Form Schemas',
    path: '/admin/form-schemas',
    icon: FormInput,
    description: 'Reusable form definitions for request intake',
  },
  {
    title: 'Criteria Sets',
    path: '/admin/criteria-sets',
    icon: Filter,
    description: 'Named expressions for matching tickets',
  },
  {
    title: 'SLA Policies',
    path: '/admin/sla-policies',
    icon: Clock,
    description: 'Response and resolution targets',
  },
  ...(features.routingStudio
    ? [
        {
          title: 'Routing Studio',
          path: '/admin/routing-studio',
          icon: Compass,
          description: 'Rules, location teams, space groups, fallbacks',
        },
      ]
    : legacyRoutingNav),
  {
    title: 'Business Hours',
    path: '/admin/business-hours',
    icon: Calendar,
    description: 'Operating hours that feed SLA clocks',
  },
  {
    title: 'Notifications',
    path: '/admin/notifications',
    icon: Bell,
    description: 'Channel and template settings',
  },
  {
    title: 'Workflows',
    path: '/admin/workflow-templates',
    icon: GitBranch,
    description: 'Automated workflows triggered by ticket events',
  },
  {
    title: 'Webhooks',
    path: '/admin/webhooks',
    icon: Webhook,
    description: 'Outbound event subscriptions for external systems',
  },
  {
    title: 'Branding',
    path: '/admin/branding',
    icon: Palette,
    description: 'Logo, colours, and tenant display name',
  },
];

const peopleItems: AdminNavItem[] = [
  {
    title: 'Organisations',
    path: '/admin/organisations',
    icon: Building2,
    description: 'Requester-side company and department hierarchy',
  },
  {
    title: 'Teams',
    path: '/admin/teams',
    icon: Users,
    description: 'Service-desk teams that own work',
  },
  {
    title: 'Persons',
    path: '/admin/persons',
    icon: PersonStanding,
    description: 'Requester directory and default locations',
  },
  {
    title: 'Delegations',
    path: '/admin/delegations',
    icon: HandCoins,
    description: 'Temporary stand-ins for approvals and ownership',
  },
];

const authorizationItems: AdminNavItem[] = [
  {
    title: 'Users',
    path: '/admin/users',
    icon: UserCog,
    description: 'Operator accounts and role assignments',
  },
  {
    title: 'User roles',
    path: '/admin/user-roles',
    icon: Shield,
    description: 'Permission bundles and scope definitions',
  },
];

const operationsItems: AdminNavItem[] = [
  {
    title: 'Locations',
    path: '/admin/locations',
    icon: MapPin,
    description: 'Sites, buildings, floors, and spaces',
  },
  {
    title: 'Assets',
    path: '/admin/assets',
    icon: Package,
    description: 'Tracked equipment linked to tickets',
  },
  {
    title: 'Vendors',
    path: '/admin/vendors',
    icon: Store,
    description: 'External suppliers that receive dispatched work',
  },
  {
    title: 'Vendor Menus',
    path: '/admin/vendor-menus',
    icon: BookOpen,
    description: 'Offerings and price lists per vendor',
  },
];

export const adminNavGroups: AdminNavGroup[] = [
  { label: 'Configuration', items: configItems },
  { label: 'People', items: peopleItems },
  { label: 'Authorisation & Permissions', items: authorizationItems },
  { label: 'Operations', items: operationsItems },
];
