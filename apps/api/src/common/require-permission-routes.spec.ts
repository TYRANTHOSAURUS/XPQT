import 'reflect-metadata';
// BrandingController transitively imports svg-sanitizer → isomorphic-
// dompurify → jsdom, which fails to load under jest's environment. This
// is a metadata-only test (we never call sanitize), so stub the module.
jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (s: string) => s },
}));
import { validatePermission, type PermissionKey } from '@prequest/shared';
import { PERMISSION_KEY } from './require-permission.decorator';

// RLS audit Slice 11.2b (codex risk #2: "unit tests that assert every
// decorated mutation calls the expected permission key"). This is the
// compile-and-run mirror of the endpoint→key mapping table in
// docs/follow-ups/audits/04-rls-security.md (the 2026-05-16 Slice 11.3
// Update block). If a controller method's @RequirePermission key drifts
// from the audited mapping — or a re-gated method silently loses its
// decorator — this fails. SetMetadata(PERMISSION_KEY, key) (applied by
// @RequirePermission via applyDecorators) attaches the key to the method
// function (method-level) or the class constructor (class-level); we
// read it back with Reflect.getMetadata.

import {
  RoutingRuleController,
} from '../modules/routing/routing.controller';
import { RoutingPoliciesController } from '../modules/routing/policies.controller';
import { SpaceGroupsController } from '../modules/routing/space-groups.controller';
import { RoutingDomainsController } from '../modules/routing/domains.controller';
import { LocationTeamsController } from '../modules/routing/location-teams.controller';
import { DomainParentsController } from '../modules/routing/domain-parents.controller';
import { WorkflowController } from '../modules/workflow/workflow.controller';
import { SlaPolicyController } from '../modules/sla/sla-policy.controller';
import { WebhookAdminController } from '../modules/webhook/webhook-admin.controller';
import { ConfigEntityController } from '../modules/config-engine/config-entity.controller';
import {
  UsersController,
  RolesController,
  RoleAssignmentsController,
  PersonsAdminController,
} from '../modules/user-management/user-management.controller';
import { BrandingController } from '../modules/tenant/branding.controller';
import { PortalAnnouncementsController } from '../modules/portal-announcements/portal-announcements.controller';
import { PortalAppearanceController } from '../modules/portal-appearance/portal-appearance.controller';

type Ctor = new (...args: never[]) => object;

// [Controller, method, expected key]. Method-level decorators.
const METHOD_MAP: Array<[Ctor, string, PermissionKey]> = [
  // ── Slice-2: routing ──
  [RoutingRuleController, 'list', 'routing.read'],
  [RoutingRuleController, 'create', 'routing.create'],
  [RoutingRuleController, 'update', 'routing.update'],
  [RoutingPoliciesController, 'getSchemas', 'routing.read'],
  [RoutingPoliciesController, 'list', 'routing.read'],
  [RoutingPoliciesController, 'get', 'routing.read'],
  [RoutingPoliciesController, 'create', 'routing.create'],
  [RoutingPoliciesController, 'createVersion', 'routing.update'],
  [RoutingPoliciesController, 'publish', 'routing.publish'],
  [SpaceGroupsController, 'list', 'routing.read'],
  [SpaceGroupsController, 'create', 'routing.create'],
  [SpaceGroupsController, 'update', 'routing.update'],
  [SpaceGroupsController, 'remove', 'routing.delete'],
  [SpaceGroupsController, 'addMember', 'routing.update'],
  [SpaceGroupsController, 'removeMember', 'routing.update'],
  [RoutingDomainsController, 'list', 'routing.read'],
  [RoutingDomainsController, 'lookup', 'routing.read'],
  [RoutingDomainsController, 'get', 'routing.read'],
  [RoutingDomainsController, 'create', 'routing.create'],
  [RoutingDomainsController, 'update', 'routing.update'],
  [RoutingDomainsController, 'deactivate', 'routing.delete'],
  [LocationTeamsController, 'list', 'routing.read'],
  [LocationTeamsController, 'create', 'routing.create'],
  [LocationTeamsController, 'update', 'routing.update'],
  [LocationTeamsController, 'remove', 'routing.delete'],
  [DomainParentsController, 'list', 'routing.read'],
  [DomainParentsController, 'create', 'routing.create'],
  [DomainParentsController, 'remove', 'routing.delete'],
  // ── Slice-2: workflow (incl. the new workflows.execute) ──
  [WorkflowController, 'list', 'workflows.read'],
  [WorkflowController, 'getById', 'workflows.read'],
  [WorkflowController, 'create', 'workflows.create'],
  [WorkflowController, 'updateGraph', 'workflows.update'],
  [WorkflowController, 'publish', 'workflows.publish'],
  [WorkflowController, 'unpublish', 'workflows.publish'],
  [WorkflowController, 'clone', 'workflows.duplicate'],
  [WorkflowController, 'simulate', 'workflows.test'],
  [WorkflowController, 'startForTicket', 'workflows.execute'],
  [WorkflowController, 'resume', 'workflows.execute'],
  [WorkflowController, 'getInstancesForTicket', 'workflows.read'],
  [WorkflowController, 'getInstance', 'workflows.read'],
  [WorkflowController, 'listInstanceEvents', 'workflows.read'],
  // ── Slice-2: sla / webhook (new domain) / config-entity ──
  [SlaPolicyController, 'list', 'sla.read'],
  [SlaPolicyController, 'create', 'sla.create'],
  [SlaPolicyController, 'update', 'sla.update'],
  [WebhookAdminController, 'list', 'webhooks.read'],
  [WebhookAdminController, 'create', 'webhooks.create'],
  [WebhookAdminController, 'update', 'webhooks.update'],
  [WebhookAdminController, 'remove', 'webhooks.delete'],
  [WebhookAdminController, 'rotateApiKey', 'webhooks.rotate_key'],
  [WebhookAdminController, 'listEvents', 'webhooks.read'],
  [WebhookAdminController, 'test', 'webhooks.test'],
  [ConfigEntityController, 'list', 'request_types.read'],
  // Slice 11.4 (codex DECISION A): the portal/desk form-render path —
  // gated on the portal-reachable `request_types.use`, not admin .read.
  [ConfigEntityController, 'getById', 'request_types.use'],
  [ConfigEntityController, 'create', 'request_types.create'],
  [ConfigEntityController, 'createDraft', 'request_types.update'],
  [ConfigEntityController, 'updateDraft', 'request_types.update'],
  [ConfigEntityController, 'publish', 'request_types.publish'],
  [ConfigEntityController, 'rollback', 'request_types.publish'],
  // ── Slice-9: user-management (mutations only; open GETs untouched) ──
  [UsersController, 'create', 'users.create'],
  [UsersController, 'update', 'users.update'],
  [UsersController, 'addRole', 'roles.assign'],
  [UsersController, 'removeRole', 'roles.assign'],
  [RolesController, 'create', 'roles.create'],
  [RolesController, 'update', 'roles.update'],
  [PersonsAdminController, 'create', 'people.create'],
  [PersonsAdminController, 'update', 'people.update'],
  // ── Slice-11.3d: leftover AdminGuard → settings.* ──
  [BrandingController, 'updateBranding', 'settings.update'],
  [BrandingController, 'uploadLogo', 'settings.update'],
  [BrandingController, 'deleteLogo', 'settings.update'],
  [PortalAnnouncementsController, 'list', 'settings.read'],
  [PortalAnnouncementsController, 'publish', 'settings.update'],
  [PortalAnnouncementsController, 'unpublish', 'settings.update'],
  [PortalAppearanceController, 'list', 'settings.read'],
  [PortalAppearanceController, 'get', 'settings.read'],
  [PortalAppearanceController, 'update', 'settings.update'],
  [PortalAppearanceController, 'uploadHero', 'settings.update'],
  [PortalAppearanceController, 'removeHero', 'settings.update'],
];

// Class-level @RequirePermission (covers every route on the class).
const CLASS_MAP: Array<[Ctor, PermissionKey]> = [
  [RoleAssignmentsController, 'roles.assign'],
];

// Routes that MUST stay open (no @RequirePermission) — re-gating must
// not silently widen OR narrow these. Slice-9 operational pickers +
// the pre-auth public branding read.
const MUST_BE_OPEN: Array<[Ctor, string]> = [
  [UsersController, 'me'],
  [UsersController, 'list'],
  [UsersController, 'getById'],
  [UsersController, 'getRoles'],
  [UsersController, 'audit'],
  [RolesController, 'list'],
  [RolesController, 'audit'],
  [PersonsAdminController, 'list'],
  [BrandingController, 'getBranding'],
];

const readKey = (target: unknown): unknown =>
  Reflect.getMetadata(PERMISSION_KEY, target as object);

describe('Slice 11.2b — @RequirePermission route → catalog-key mapping', () => {
  it.each(METHOD_MAP)(
    '%p.%s is gated @RequirePermission(%p)',
    (Ctrl, method, expected) => {
      const fn = (Ctrl.prototype as Record<string, unknown>)[method];
      expect(typeof fn).toBe('function');
      expect(readKey(fn)).toBe(expected);
    },
  );

  it.each(CLASS_MAP)(
    '%p is class-level @RequirePermission(%p)',
    (Ctrl, expected) => {
      expect(readKey(Ctrl)).toBe(expected);
    },
  );

  it.each(MUST_BE_OPEN)(
    '%p.%s stays open (no @RequirePermission — not widened/narrowed)',
    (Ctrl, method) => {
      const fn = (Ctrl.prototype as Record<string, unknown>)[method];
      expect(typeof fn).toBe('function');
      expect(readKey(fn)).toBeUndefined();
    },
  );

  // A class-level @RequirePermission is only authoritative if no method
  // silently carries its own (method metadata wins via getAllAndOverride
  // [handler, class]). Pin RoleAssignments' methods to "no method-level
  // key" so a future stray @RequirePermission on one of them — which
  // would override the class gate for that route — fails here.
  it.each([
    [RoleAssignmentsController, 'assign'],
    [RoleAssignmentsController, 'update'],
    [RoleAssignmentsController, 'remove'],
  ] as Array<[Ctor, string]>)(
    'class-gated %p.%s carries NO conflicting method-level key',
    (Ctrl, method) => {
      const fn = (Ctrl.prototype as Record<string, unknown>)[method];
      expect(typeof fn).toBe('function');
      expect(readKey(fn)).toBeUndefined();
    },
  );

  it('every mapped key is a well-formed, known catalog permission', () => {
    for (const [, , key] of METHOD_MAP) {
      expect(validatePermission(key)).toEqual({ ok: true });
    }
    for (const [, key] of CLASS_MAP) {
      expect(validatePermission(key)).toEqual({ ok: true });
    }
  });
});
