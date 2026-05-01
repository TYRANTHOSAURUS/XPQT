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
      update: {
        label: 'Edit ticket fields',
        description: 'Change title, description, and non-structural fields.',
      },
      assign: {
        label: 'Assign tickets',
        description: 'Set or change assignee (user, team, or vendor).',
      },
      change_type: {
        label: 'Change request type',
        description: 'Reclassify a ticket. Re-runs routing, SLA, and workflow.',
      },
      change_priority: {
        label: 'Change priority',
        description: 'Upgrade or downgrade priority. Affects SLA timers.',
      },
      change_location: {
        label: 'Change location',
        description: 'Move a ticket to a different site / building / space.',
      },
      watch: {
        label: 'Manage watchers',
        description: 'Add or remove watchers on a ticket.',
      },
      comment: {
        label: 'Add public comments',
        description: 'Comments visible to the requester.',
      },
      post_private_note: {
        label: 'Post internal notes',
        description: 'Agent-only notes not visible to the requester.',
      },
      approve: {
        label: 'Approve or reject',
        description: 'Act on tickets in an approval-gated state.',
      },
      escalate: {
        label: 'Escalate',
        description: 'Escalate to a higher tier or named escalation team.',
      },
      merge: {
        label: 'Merge tickets',
        description: 'Combine duplicates into one canonical ticket.',
      },
      bulk_edit: {
        label: 'Bulk edit',
        description: 'Apply a change to many tickets at once.',
      },
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
      invite: { label: 'Invite to platform', description: 'Create a user account for a person.' },
      merge: { label: 'Merge duplicates', description: 'Merge two person records into one canonical.' },
      deactivate: { label: 'Deactivate or reactivate' },
      import: { label: 'Import from CSV / HRIS', danger: true },
      export: { label: 'Export person data' },
      delete: { label: 'Delete people', danger: true },
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
      reset_password: { label: 'Force password reset' },
      impersonate: {
        label: 'Impersonate',
        description: 'Act as another user for support / debugging. Always audited.',
        danger: true,
      },
      delete: { label: 'Delete users', danger: true },
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
      duplicate: { label: 'Duplicate a role' },
      assign: { label: 'Assign roles to users', danger: true },
      export: { label: 'Export role definitions' },
      delete: { label: 'Delete roles', danger: true },
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
      manage_members: { label: 'Add or remove team members' },
      change_leader: { label: 'Change team leader' },
      delete: { label: 'Delete teams', danger: true },
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
      publish: { label: 'Publish or unpublish' },
      duplicate: { label: 'Duplicate a request type' },
      archive: { label: 'Archive or restore' },
      reorder: { label: 'Reorder in the catalog' },
      delete: { label: 'Delete request types', danger: true },
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
      simulate: { label: 'Run the routing simulator' },
      publish: { label: 'Activate a rule set', description: 'Promote a draft rule set to live.' },
      rollback: { label: 'Roll back to a previous rule set', danger: true },
      delete: { label: 'Delete routing rules', danger: true },
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
      publish: { label: 'Publish or unpublish items' },
      feature: { label: 'Feature on the portal', description: 'Pin to the top of the catalog.' },
      archive: { label: 'Archive or restore' },
      delete: { label: 'Delete service items', danger: true },
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
      manage_grants: { label: 'Manage org → location grants' },
      manage_memberships: { label: 'Add or remove org memberships' },
      import: { label: 'Import from HRIS / LDAP', danger: true },
      delete: { label: 'Delete org nodes', danger: true },
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
      manage_grants: { label: 'Manage space grants' },
      import: { label: 'Import floor plans / CSV', danger: true },
      archive: { label: 'Archive or restore' },
      delete: { label: 'Delete spaces', danger: true },
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
      transfer: { label: 'Transfer ownership or location' },
      check_in: { label: 'Check in / return', description: 'Mark a loanable asset as returned.' },
      check_out: { label: 'Check out / loan', description: 'Assign a loanable asset to a person.' },
      audit: { label: 'Run a physical audit' },
      import: { label: 'Import from CSV / CMDB', danger: true },
      export: { label: 'Export asset register' },
      retire: { label: 'Retire or dispose of assets', danger: true },
      delete: { label: 'Delete assets', danger: true },
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
      duplicate: { label: 'Duplicate a criteria set' },
      preview: { label: 'Preview matches', description: 'Dry-run against live persons.' },
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
      publish: { label: 'Publish a new version' },
      duplicate: { label: 'Duplicate a workflow' },
      test: { label: 'Run a test execution', description: 'Dry-run without side effects.' },
      rollback: { label: 'Roll back to a previous version', danger: true },
      archive: { label: 'Archive or restore' },
      delete: { label: 'Delete workflows', danger: true },
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
      duplicate: { label: 'Duplicate a policy' },
      pause: { label: 'Pause an SLA timer' },
      resume: { label: 'Resume a paused timer' },
      override: {
        label: 'One-off override',
        description: 'Apply a different SLA to a specific ticket.',
        danger: true,
      },
      delete: { label: 'Delete SLA policies', danger: true },
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
      manage_contacts: { label: 'Manage vendor contacts' },
      deactivate: { label: 'Deactivate or reactivate' },
      import: { label: 'Import vendor list' },
      admin: {
        label: 'Manage daily list & fulfillment',
        description:
          'Regenerate, resend, and operate per-vendor daily-list (daglijst) and fulfillment surfaces.',
      },
      delete: { label: 'Delete vendors', danger: true },
    },
  },
  rooms: {
    label: 'Rooms',
    icon: 'door-open',
    description:
      'Room-booking subsystem admin — booking rules, bundle templates, simulation, and related fulfillment config.',
    actions: {
      read: { label: 'View room-booking config' },
      admin: {
        label: 'Administer room-booking config',
        description:
          'Manage booking rules, bundle templates, simulation, scenarios, and related admin surfaces.',
        danger: true,
      },
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
      share: { label: 'Share with others' },
      schedule: { label: 'Schedule recurring delivery' },
      subscribe: { label: 'Subscribe another user' },
      export: { label: 'Export report data' },
      delete: { label: 'Delete reports', danger: true },
    },
  },
  notifications: {
    label: 'Notifications',
    icon: 'bell',
    description: 'Tenant-level notification templates and preferences.',
    actions: {
      read: { label: 'View notification settings' },
      update: { label: 'Edit notification settings' },
      manage_templates: { label: 'Edit notification templates' },
      send_test: { label: 'Send a test notification' },
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
      merge: { label: 'Merge duplicate tags' },
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
      export: { label: 'Export tenant config', description: 'Full-tenant JSON export for migration or backup.' },
      billing: { label: 'View billing + plan', danger: true },
    },
  },
  visitors: {
    label: 'Visitors',
    icon: 'user-check',
    description:
      'Visitor invitations, reception workspace, and pass pool. Visitors are persons (type=visitor); visit events live on visitors.',
    actions: {
      invite: {
        label: 'Invite visitors',
        description:
          'Create visitor invitations from the portal or booking composer. Inviter must have location-grant scope to the target building.',
      },
      reception: {
        label: 'Operate reception workspace',
        description:
          'Access /reception/* and /desk/visitors. Check visitors in/out, manage walk-ups, run the pass pool. Off by default — granted explicitly to reception/service-desk roles.',
      },
    },
    overrides: {
      read_all: {
        label: 'See all visitors',
        description: 'Bypass scope — view every visitor in the tenant regardless of building scope.',
        danger: true,
      },
    },
  },
  gdpr: {
    label: 'Privacy & compliance (GDPR)',
    icon: 'shield-check',
    description:
      'Retention settings, LIA, data-subject access/erasure/portability requests, and legal holds.',
    actions: {
      configure: {
        label: 'Configure retention & LIA',
        description: 'Edit retention windows, LIA text, and per-category settings.',
        danger: true,
      },
      fulfill_request: {
        label: 'Fulfill DSR requests',
        description: 'Initiate and complete access, erasure, and portability requests.',
        danger: true,
      },
      audit_reads: {
        label: 'Audit personal-data reads',
        description: 'Query the personal_data_access_logs read-side audit trail.',
      },
      place_legal_hold: {
        label: 'Place or release legal holds',
        description: 'Suspend retention for specific records under legal review.',
        danger: true,
      },
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

/**
 * Union of every concrete action segment across every module — used to keep
 * `*.<action>` wildcards honest. Without this, `*.${string}` would accept
 * `*.banana` at compile time even though no module has a `banana` action.
 */
export type AnyActionKey = {
  [M in PermissionModule]: Extract<ActionKeyOf<M>, string>;
}[PermissionModule];

export type WildcardPermissionKey =
  | `${PermissionModule & string}.*`
  | `*.${AnyActionKey}`
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
