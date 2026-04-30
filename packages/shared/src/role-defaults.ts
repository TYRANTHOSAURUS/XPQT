/**
 * Default role templates — TypeScript source of truth.
 *
 * Mirrors the SQL seed in `supabase/migrations/00112_seed_role_templates.sql`
 * (and any subsequent migrations that extend it). Whenever a permission is
 * added to PERMISSION_CATALOG, the catalog-coverage test in
 * `apps/api/src/common/permission-catalog.spec.ts` requires that the new key
 * be either:
 *
 *   1. Granted by at least one role here (via exact match or wildcard,
 *      excluding the trivial `*.*` superadmin), OR
 *   2. Listed in `EXPLICITLY_NO_DEFAULT_ROLE` with a written reason.
 *
 * The point is to force a real human decision at the moment a permission is
 * introduced — "should the Service Desk Lead get this by default?" — instead
 * of letting orphaned keys drift in (silently usable only by `*.*`
 * superadmins).
 *
 * **Drift between this file and the SQL seed must be fixed in the same PR**.
 * Either update the SQL via a new migration to match this file, or update
 * this file to match SQL — both must agree before merge.
 */

import type { ConcretePermissionKey, PermissionKey } from './permissions';

export type RoleTemplateName =
  | 'Tenant Admin'
  | 'IT Agent'
  | 'FM Agent'
  | 'Service Desk Lead'
  | 'Requester'
  | 'Auditor';

export type RoleTemplateType = 'admin' | 'agent' | 'employee';

export interface RoleTemplate {
  name: RoleTemplateName;
  description: string;
  permissions: readonly PermissionKey[];
  type: RoleTemplateType;
}

/**
 * Canonical role templates seeded per tenant. The order here is the order
 * they appear in the admin Roles & permissions UI.
 */
export const DEFAULT_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    name: 'Tenant Admin',
    description: 'Full tenant administration — use sparingly.',
    permissions: ['*.*'],
    type: 'admin',
  },
  {
    name: 'IT Agent',
    description:
      'Handles IT tickets end-to-end. Grant domain_scope=["it"] on assignment.',
    permissions: [
      'tickets.*',
      'request_types.read',
      'assets.read',
      'people.read',
      'vendors.read',
    ],
    type: 'agent',
  },
  {
    name: 'FM Agent',
    description:
      'Handles facilities tickets. Grant domain_scope=["fm"] on assignment.',
    permissions: [
      'tickets.*',
      'assets.*',
      'spaces.read',
      'people.read',
      'vendors.read',
    ],
    type: 'agent',
  },
  {
    name: 'Service Desk Lead',
    description:
      'Agent permissions plus team admin, reporting, and workplace config (rooms + vendor fulfillment).',
    permissions: [
      'tickets.*',
      'request_types.read',
      'assets.read',
      'people.read',
      'people.update',
      'teams.*',
      'reports.read',
      'reports.export',
      'routing.read',
      'rooms.admin',
      'vendors.admin',
    ],
    type: 'agent',
  },
  {
    name: 'Requester',
    description: 'Portal-only access. Creates and views their own tickets.',
    permissions: [
      'tickets.create',
      'tickets.read',
      'service_catalog.read',
      'people.read',
    ],
    type: 'employee',
  },
  {
    name: 'Auditor',
    description:
      'Read-only access across every module — for compliance and reviews.',
    permissions: ['*.read'],
    type: 'agent',
  },
] as const;

/**
 * Permissions that intentionally have no non-superadmin default role.
 * Each entry MUST include a reason. The catalog-coverage test allows these
 * keys to escape the "must be granted somewhere" check because the Tenant
 * Admin (`*.*`) is the deliberate sole holder until a dedicated role is
 * introduced.
 *
 * If you're tempted to add an entry here just to silence the coverage test,
 * stop and pick a default role instead. This list is for genuine "no role
 * should auto-receive this" cases (DPO operations, billing, destructive
 * tenant-wide config), not for "I haven't decided yet".
 */
export const EXPLICITLY_NO_DEFAULT_ROLE: ReadonlyArray<{
  key: ConcretePermissionKey;
  reason: string;
}> = [
  {
    key: 'gdpr.configure',
    reason:
      'DPO-tier operation: edits retention windows + LIA. Should not auto-attach to any agent role. Tenant Admin grants explicitly per person.',
  },
  {
    key: 'gdpr.fulfill_request',
    reason:
      'DPO-tier operation: initiates and completes data-subject access/erasure/portability requests. Manually granted; no default role.',
  },
  {
    key: 'gdpr.audit_reads',
    reason:
      'DPO-tier operation: queries personal_data_access_logs. Manually granted to compliance reviewers; not part of the Auditor read-only template (would expose log volume to broad audit).',
  },
  {
    key: 'gdpr.place_legal_hold',
    reason:
      'Legal-tier operation: suspends retention. Tenant Admin grants explicitly to legal counsel. No default role.',
  },
  {
    key: 'settings.billing',
    reason:
      'Sensitive (plan + payment surface). Tenant Admin only by default; manually granted to finance contacts.',
  },
  {
    key: 'users.impersonate',
    reason:
      'Always-audited destructive op for support/debugging. Tenant Admin only; manually granted to platform support staff.',
  },
];

/**
 * ⚠️ DO NOT ADD NEW KEYS HERE. ⚠️
 *
 * Pre-existing tech debt. These permission keys exist in PERMISSION_CATALOG
 * but have no non-superadmin default role today — meaning every customer's
 * admins are forced to use Tenant Admin (`*.*`) to perform routine
 * configuration, which is a real security antipattern.
 *
 * The right fix is a "Workplace Admin" / "Config Admin" / "Process Admin"
 * role template design that distributes these grants properly. That work is
 * tracked separately. Until then, this list captures the exact gap and the
 * coverage test treats these as exempt — so the test still gates *new*
 * permissions, while honestly accounting for the historical state.
 *
 * **NEW PERMISSIONS GO INTO A ROLE OR INTO `EXPLICITLY_NO_DEFAULT_ROLE` —
 * NEVER INTO THIS LIST.** This list should only ever shrink (as new role
 * templates absorb its members), never grow.
 */
export const LEGACY_UNGRANTED_KEYS: ReadonlyArray<ConcretePermissionKey> = [
  'criteria_sets.create',
  'criteria_sets.delete',
  'criteria_sets.duplicate',
  'criteria_sets.preview',
  'criteria_sets.update',
  'notifications.manage_templates',
  'notifications.send_test',
  'notifications.update',
  'organisations.create',
  'organisations.delete',
  'organisations.import',
  'organisations.manage_grants',
  'organisations.manage_memberships',
  'organisations.update',
  'people.create',
  'people.deactivate',
  'people.delete',
  'people.export',
  'people.import',
  'people.invite',
  'people.merge',
  'reports.create',
  'reports.delete',
  'reports.schedule',
  'reports.share',
  'reports.subscribe',
  'reports.update',
  'request_types.archive',
  'request_types.create',
  'request_types.delete',
  'request_types.duplicate',
  'request_types.publish',
  'request_types.reorder',
  'request_types.update',
  'roles.assign',
  'roles.create',
  'roles.delete',
  'roles.duplicate',
  'roles.export',
  'roles.update',
  'routing.create',
  'routing.delete',
  'routing.publish',
  'routing.rollback',
  'routing.simulate',
  'routing.update',
  'service_catalog.archive',
  'service_catalog.create',
  'service_catalog.delete',
  'service_catalog.feature',
  'service_catalog.publish',
  'service_catalog.update',
  'settings.export',
  'settings.update',
  'sla.create',
  'sla.delete',
  'sla.duplicate',
  'sla.override',
  'sla.pause',
  'sla.resume',
  'sla.update',
  'spaces.archive',
  'spaces.create',
  'spaces.delete',
  'spaces.import',
  'spaces.manage_grants',
  'spaces.update',
  'tags.create',
  'tags.delete',
  'tags.merge',
  'tags.update',
  'users.create',
  'users.delete',
  'users.reset_password',
  'users.suspend',
  'users.update',
  'vendors.create',
  'vendors.deactivate',
  'vendors.delete',
  'vendors.import',
  'vendors.manage_contacts',
  'vendors.update',
  'workflows.archive',
  'workflows.create',
  'workflows.delete',
  'workflows.duplicate',
  'workflows.publish',
  'workflows.rollback',
  'workflows.test',
  'workflows.update',
];
