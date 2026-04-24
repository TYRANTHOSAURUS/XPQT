/**
 * Permission catalog — single source of truth for the authorization system.
 *
 * Grammar: `<resource>.<action>`. `*` is a wildcard in either position.
 *   tickets.read         exact
 *   tickets.*            all actions on a resource
 *   *.read               one action across every resource
 *   *.*                  super admin
 *
 * Overrides (grouped separately in the UI) bypass the scope filter applied
 * by user_role_assignments.domain_scope / location_scope. Ex: tickets.read
 * lets a user read tickets within their scope; tickets.read_all bypasses
 * that scope entirely.
 *
 * Runtime checks live in the `user_has_permission` SQL function — see
 * supabase/migrations/00109_permissions_wildcards.sql.
 */

export type ActionMeta = {
  label: string;
  description?: string;
  danger?: boolean;
};

export type ModuleMeta = {
  label: string;
  icon: string;
  description?: string;
  actions: Record<string, ActionMeta>;
  overrides?: Record<string, ActionMeta>;
};

export const PERMISSION_CATALOG = {
  tickets: {
    label: 'Tickets',
    icon: 'ticket',
    description: 'Cases, work orders, and service requests.',
    actions: {
      read: { label: 'View tickets', description: 'Read tickets within your scope.' },
      create: { label: 'Create tickets' },
      update: { label: 'Edit tickets' },
      assign: { label: 'Assign tickets', description: 'Set assignee, team, or vendor.' },
      close: { label: 'Close tickets' },
      reopen: { label: 'Reopen closed tickets' },
      delete: { label: 'Delete tickets', danger: true },
    },
    overrides: {
      read_all: {
        label: 'See all tickets',
        description: 'Bypass scope — view every ticket in the tenant.',
        danger: true,
      },
      write_all: {
        label: 'Edit all tickets',
        description: 'Bypass scope — edit/assign any ticket in the tenant.',
        danger: true,
      },
    },
  },
  people: {
    label: 'People',
    icon: 'users',
    description: 'Persons (employees, contractors, visitors, vendor contacts).',
    actions: {
      read: { label: 'View people' },
      create: { label: 'Create people' },
      update: { label: 'Edit people' },
      delete: { label: 'Delete people', danger: true },
      invite: { label: 'Invite to platform', description: 'Create a user account for a person.' },
    },
  },
  users: {
    label: 'Users',
    icon: 'user-cog',
    description: 'Platform accounts linked to a person.',
    actions: {
      read: { label: 'View users' },
      create: { label: 'Create users', danger: true },
      update: { label: 'Edit users' },
      suspend: { label: 'Suspend or reactivate users', danger: true },
    },
  },
  roles: {
    label: 'Roles & permissions',
    icon: 'shield',
    description: 'Role definitions and assignment of roles to users.',
    actions: {
      read: { label: 'View roles' },
      create: { label: 'Create roles', danger: true },
      update: { label: 'Edit roles', danger: true },
      delete: { label: 'Delete roles', danger: true },
      assign: { label: 'Assign roles to users', danger: true },
    },
  },
  teams: {
    label: 'Teams',
    icon: 'users-round',
    description: 'Service desk and fulfilment teams.',
    actions: {
      read: { label: 'View teams' },
      create: { label: 'Create teams' },
      update: { label: 'Edit teams' },
      delete: { label: 'Delete teams', danger: true },
      manage_members: { label: 'Add or remove team members' },
    },
  },
  request_types: {
    label: 'Request types',
    icon: 'file-text',
    description: 'Catalog of requestable items and their forms.',
    actions: {
      read: { label: 'View request types' },
      create: { label: 'Create request types' },
      update: { label: 'Edit request types' },
      delete: { label: 'Delete request types', danger: true },
      publish: { label: 'Publish or unpublish' },
    },
  },
  routing: {
    label: 'Routing',
    icon: 'route',
    description: 'Routing rules, resolver studio, and simulation.',
    actions: {
      read: { label: 'View routing config' },
      create: { label: 'Create routing rules' },
      update: { label: 'Edit routing rules' },
      delete: { label: 'Delete routing rules', danger: true },
      simulate: { label: 'Run the routing simulator' },
    },
  },
  service_catalog: {
    label: 'Service catalog',
    icon: 'book-open',
    description: 'Service items, coverage, and fulfilment links.',
    actions: {
      read: { label: 'View service catalog' },
      create: { label: 'Create service items' },
      update: { label: 'Edit service items' },
      delete: { label: 'Delete service items', danger: true },
      publish: { label: 'Publish or unpublish items' },
    },
  },
  organisations: {
    label: 'Organisations',
    icon: 'building',
    description: 'Requester-side org tree, memberships, and location grants.',
    actions: {
      read: { label: 'View organisations' },
      create: { label: 'Create org nodes' },
      update: { label: 'Edit org nodes' },
      delete: { label: 'Delete org nodes', danger: true },
      manage_grants: { label: 'Manage org → location grants' },
    },
  },
  spaces: {
    label: 'Spaces',
    icon: 'map-pin',
    description: 'Sites, buildings, floors, and rooms.',
    actions: {
      read: { label: 'View spaces' },
      create: { label: 'Create spaces' },
      update: { label: 'Edit spaces' },
      delete: { label: 'Delete spaces', danger: true },
      manage_grants: { label: 'Manage space grants' },
    },
  },
  assets: {
    label: 'Assets',
    icon: 'package',
    description: 'Tracked assets and their lifecycle.',
    actions: {
      read: { label: 'View assets' },
      create: { label: 'Create assets' },
      update: { label: 'Edit assets' },
      delete: { label: 'Delete assets', danger: true },
      transfer: { label: 'Transfer ownership or location' },
      retire: { label: 'Retire or dispose of assets', danger: true },
    },
  },
  criteria_sets: {
    label: 'Criteria sets',
    icon: 'sliders-horizontal',
    description: 'Reusable boolean expressions used by routing, coverage, etc.',
    actions: {
      read: { label: 'View criteria sets' },
      create: { label: 'Create criteria sets' },
      update: { label: 'Edit criteria sets' },
      delete: { label: 'Delete criteria sets', danger: true },
    },
  },
  workflows: {
    label: 'Workflows',
    icon: 'workflow',
    description: 'Workflow templates and automation steps.',
    actions: {
      read: { label: 'View workflows' },
      create: { label: 'Create workflows' },
      update: { label: 'Edit workflows' },
      delete: { label: 'Delete workflows', danger: true },
      publish: { label: 'Publish workflow versions' },
    },
  },
  sla: {
    label: 'SLA policies',
    icon: 'timer',
    description: 'Service-level agreement policies and timers.',
    actions: {
      read: { label: 'View SLA policies' },
      create: { label: 'Create SLA policies' },
      update: { label: 'Edit SLA policies' },
      delete: { label: 'Delete SLA policies', danger: true },
      pause: { label: 'Pause or resume SLA timers' },
    },
  },
  vendors: {
    label: 'Vendors',
    icon: 'briefcase',
    description: 'External vendors and their contacts.',
    actions: {
      read: { label: 'View vendors' },
      create: { label: 'Create vendors' },
      update: { label: 'Edit vendors' },
      delete: { label: 'Delete vendors', danger: true },
      manage_contacts: { label: 'Manage vendor contacts' },
    },
  },
  reports: {
    label: 'Reports',
    icon: 'bar-chart-3',
    description: 'Analytics, dashboards, and exports.',
    actions: {
      read: { label: 'View reports' },
      create: { label: 'Create reports' },
      update: { label: 'Edit reports' },
      delete: { label: 'Delete reports', danger: true },
      export: { label: 'Export report data' },
    },
  },
  notifications: {
    label: 'Notifications',
    icon: 'bell',
    description: 'Tenant-level notification templates and preferences.',
    actions: {
      read: { label: 'View notification settings' },
      update: { label: 'Edit notification settings' },
    },
  },
  tags: {
    label: 'Tags',
    icon: 'tag',
    description: 'Tags applied to tickets, assets, and other records.',
    actions: {
      read: { label: 'View tags' },
      create: { label: 'Create tags' },
      update: { label: 'Edit tags' },
      delete: { label: 'Delete tags', danger: true },
    },
  },
  settings: {
    label: 'Tenant settings',
    icon: 'settings',
    description: 'Tenant-wide branding, domains, and platform config.',
    actions: {
      read: { label: 'View tenant settings' },
      update: { label: 'Edit tenant settings', danger: true },
    },
  },
} as const satisfies Record<string, ModuleMeta>;

export type PermissionModule = keyof typeof PERMISSION_CATALOG;

type ActionKeyOf<M extends PermissionModule> =
  | keyof (typeof PERMISSION_CATALOG)[M]['actions']
  | (M extends keyof { [K in PermissionModule as typeof PERMISSION_CATALOG[K] extends { overrides: infer _ } ? K : never]: true }
      ? keyof NonNullable<(typeof PERMISSION_CATALOG)[M]['overrides']>
      : never);

export type ConcretePermissionKey = {
  [M in PermissionModule]: `${M & string}.${Extract<ActionKeyOf<M>, string>}`;
}[PermissionModule];

export type WildcardPermissionKey =
  | `${PermissionModule & string}.*`
  | `*.${string}`
  | '*.*';

export type PermissionKey = ConcretePermissionKey | WildcardPermissionKey;

/**
 * Canonical permission string shape: 2 segments separated by a dot, both
 * non-empty. Either segment may be "*" (wildcard) but not both empty.
 */
export function isWellFormedPermission(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0) return false;
  const parts = key.split('.');
  if (parts.length !== 2) return false;
  const [resource, action] = parts;
  if (!resource || !action) return false;
  return /^[*a-z0-9_]+$/.test(resource) && /^[*a-z0-9_]+$/.test(action);
}

/**
 * Normalise a legacy colon-form permission (`tickets:read_all`) to dot-form
 * (`tickets.read_all`). Idempotent; lowercases the string.
 *
 * Kept in sync with the SQL `user_has_permission` normalisation.
 */
export function normalisePermission(key: string): string {
  return key.toLowerCase().replace(/:/g, '.');
}

/**
 * True when the resource segment matches an entry in the catalog (or is "*").
 * Used by the role editor to reject permission keys for unknown modules.
 */
export function isKnownResource(resource: string): boolean {
  if (resource === '*') return true;
  return resource in PERMISSION_CATALOG;
}

/**
 * True when the action segment is either "*" or a known action/override for
 * the given resource. `*` in `resource` accepts any action that's known in
 * at least one module.
 */
export function isKnownAction(resource: string, action: string): boolean {
  if (action === '*') return true;
  if (resource === '*') {
    for (const mod of Object.values(PERMISSION_CATALOG) as ModuleMeta[]) {
      if (action in mod.actions) return true;
      if (mod.overrides && action in mod.overrides) return true;
    }
    return false;
  }
  const mod = (PERMISSION_CATALOG as Record<string, ModuleMeta>)[resource];
  if (!mod) return false;
  if (action in mod.actions) return true;
  if (mod.overrides && action in mod.overrides) return true;
  return false;
}

/**
 * Validate a permission string for storage. Rejects unknown resources or
 * actions; accepts wildcards.
 */
export function validatePermission(key: string): { ok: true } | { ok: false; reason: string } {
  const norm = normalisePermission(key);
  if (!isWellFormedPermission(norm)) {
    return { ok: false, reason: `Malformed permission "${key}"` };
  }
  const [resource, action] = norm.split('.');
  if (!isKnownResource(resource)) {
    return { ok: false, reason: `Unknown module "${resource}"` };
  }
  if (!isKnownAction(resource, action)) {
    return { ok: false, reason: `Unknown action "${action}" for module "${resource}"` };
  }
  return { ok: true };
}

/**
 * True when the granted permission array (from a role) satisfies the
 * requested permission — client-side mirror of the SQL evaluator. Useful for
 * UI gating before the server has been asked.
 */
export function matches(granted: readonly string[], requested: string): boolean {
  const req = normalisePermission(requested);
  const [resource, action] = req.split('.');
  if (!resource || !action) return false;
  const set = new Set(granted.map(normalisePermission));
  return (
    set.has(req) ||
    set.has(`${resource}.*`) ||
    set.has(`*.${action}`) ||
    set.has('*.*')
  );
}

/**
 * Expand a granted permission array into the concrete permission keys it
 * resolves to (with wildcard expansion). Used by the Effective Permissions
 * panel on the user detail page.
 */
export function expandGranted(granted: readonly string[]): ConcretePermissionKey[] {
  const out = new Set<string>();
  const norm = granted.map(normalisePermission);
  const fullWildcard = norm.includes('*.*');
  for (const [resource, modRaw] of Object.entries(PERMISSION_CATALOG)) {
    const mod = modRaw as ModuleMeta;
    const actions = Object.keys(mod.actions);
    const overrides = mod.overrides ? Object.keys(mod.overrides) : [];
    const allActions = [...actions, ...overrides];
    const resourceWildcard = fullWildcard || norm.includes(`${resource}.*`);
    for (const action of allActions) {
      const key = `${resource}.${action}`;
      if (
        resourceWildcard ||
        norm.includes(key) ||
        norm.includes(`*.${action}`)
      ) {
        out.add(key);
      }
    }
  }
  return [...out].sort() as ConcretePermissionKey[];
}

/**
 * Human-readable listing of the catalog, ordered for the UI picker.
 */
export function listCatalog(): Array<{
  resource: PermissionModule;
  meta: ModuleMeta;
}> {
  return (Object.entries(PERMISSION_CATALOG) as Array<[PermissionModule, ModuleMeta]>).map(
    ([resource, meta]) => ({ resource, meta }),
  );
}
