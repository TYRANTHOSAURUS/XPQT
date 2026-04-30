import {
  DEFAULT_ROLE_TEMPLATES,
  EXPLICITLY_NO_DEFAULT_ROLE,
  LEGACY_UNGRANTED_KEYS,
  PERMISSION_CATALOG,
  matches,
  validatePermission,
  type ConcretePermissionKey,
  type ModuleMeta,
  type PermissionKey,
} from '@prequest/shared';

/**
 * Permission catalog coverage tests.
 *
 * These tests are the gate that forces a real human decision when a new
 * permission is introduced. Without them, an agent can add `tickets.foo` to
 * PERMISSION_CATALOG, gate a new endpoint with it, and never wire it into
 * any default role — meaning nobody but `*.*` superadmin can use the new
 * feature, silently.
 *
 * The rules:
 *   - Every concrete (resource, action) and (resource, override) in
 *     PERMISSION_CATALOG must be granted by at least one DEFAULT_ROLE_TEMPLATES
 *     entry, OR be listed in EXPLICITLY_NO_DEFAULT_ROLE with a written reason.
 *   - The trivial `*.*` superadmin grant does NOT count toward coverage —
 *     a new permission requires an explicit decision about which non-admin
 *     role gets it (or a deliberate "no default role" entry).
 *   - Every role's permissions list must use well-formed catalog keys (or
 *     valid wildcards). No typos or stale references.
 *   - EXPLICITLY_NO_DEFAULT_ROLE entries must reference real catalog keys.
 */

const SUPERADMIN_KEY = '*.*' as const;

function listConcreteKeys(): ConcretePermissionKey[] {
  const keys: string[] = [];
  for (const [resource, modRaw] of Object.entries(PERMISSION_CATALOG)) {
    const mod = modRaw as ModuleMeta;
    for (const action of Object.keys(mod.actions)) {
      keys.push(`${resource}.${action}`);
    }
    if (mod.overrides) {
      for (const action of Object.keys(mod.overrides)) {
        keys.push(`${resource}.${action}`);
      }
    }
  }
  return keys.sort() as ConcretePermissionKey[];
}

function isCoveredByNonSuperadmin(
  key: ConcretePermissionKey,
  granted: readonly PermissionKey[],
): boolean {
  const filtered = granted.filter((g) => g !== SUPERADMIN_KEY);
  return matches(filtered, key);
}

function listCoverageExemptions(): Set<string> {
  return new Set<string>([
    ...EXPLICITLY_NO_DEFAULT_ROLE.map((e) => e.key),
    ...LEGACY_UNGRANTED_KEYS,
  ]);
}

describe('permission catalog coverage', () => {
  it('every concrete catalog key is granted by at least one default role OR explicitly opted out', () => {
    const exempt = listCoverageExemptions();
    const orphans: string[] = [];

    for (const key of listConcreteKeys()) {
      if (exempt.has(key)) continue;
      const covered = DEFAULT_ROLE_TEMPLATES.some((tpl) =>
        isCoveredByNonSuperadmin(key, tpl.permissions),
      );
      if (!covered) orphans.push(key);
    }

    if (orphans.length > 0) {
      throw new Error(
        [
          `${orphans.length} permission key(s) have no non-superadmin default role:`,
          ...orphans.map((k) => `  - ${k}`),
          '',
          'Each new permission must be granted by at least one role in',
          'packages/shared/src/role-defaults.ts (DEFAULT_ROLE_TEMPLATES) — exact',
          'match or wildcard (e.g. "tickets.*" or "*.read") — OR be listed in',
          'EXPLICITLY_NO_DEFAULT_ROLE with a written reason.',
          '',
          'The Tenant Admin "*.*" grant does NOT count: it would silently cover',
          'every key and defeat the purpose of this test.',
          '',
          'DO NOT add new keys to LEGACY_UNGRANTED_KEYS — that list is frozen',
          'pre-existing tech debt and should only ever shrink.',
        ].join('\n'),
      );
    }
  });

  it('LEGACY_UNGRANTED_KEYS only contains real catalog keys', () => {
    const concrete = new Set<string>(listConcreteKeys());
    const stale = LEGACY_UNGRANTED_KEYS.filter((k) => !concrete.has(k));
    if (stale.length > 0) {
      throw new Error(
        [
          'LEGACY_UNGRANTED_KEYS references keys not in PERMISSION_CATALOG:',
          ...stale.map((k) => `  - ${k}`),
          '',
          'These keys were probably renamed or removed from the catalog.',
          'Drop them from LEGACY_UNGRANTED_KEYS — the list should only ever shrink.',
        ].join('\n'),
      );
    }
  });

  it('LEGACY_UNGRANTED_KEYS does not double-cover keys that are now actually granted', () => {
    const stillUngranted = LEGACY_UNGRANTED_KEYS.filter((key) => {
      return !DEFAULT_ROLE_TEMPLATES.some((tpl) =>
        isCoveredByNonSuperadmin(key as ConcretePermissionKey, tpl.permissions),
      );
    });
    const nowGranted = LEGACY_UNGRANTED_KEYS.filter((k) => !stillUngranted.includes(k));
    if (nowGranted.length > 0) {
      throw new Error(
        [
          'LEGACY_UNGRANTED_KEYS contains keys that are NOW granted by a default role:',
          ...nowGranted.map((k) => `  - ${k}`),
          '',
          'Remove them from LEGACY_UNGRANTED_KEYS — they no longer need the exemption.',
          'This list should only ever shrink as new role templates absorb its members.',
        ].join('\n'),
      );
    }
  });

  it('every role template has only well-formed, catalog-known permissions (or wildcards)', () => {
    const failures: string[] = [];
    for (const tpl of DEFAULT_ROLE_TEMPLATES) {
      for (const key of tpl.permissions) {
        const result = validatePermission(key);
        if (!result.ok) {
          failures.push(`  - ${tpl.name}: "${key}" — ${result.reason}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new Error(
        ['Role template references invalid permission keys:', ...failures].join('\n'),
      );
    }
  });

  it('every EXPLICITLY_NO_DEFAULT_ROLE entry references a real catalog key', () => {
    const concrete = new Set<string>(listConcreteKeys());
    const failures: string[] = [];
    for (const entry of EXPLICITLY_NO_DEFAULT_ROLE) {
      if (!concrete.has(entry.key)) {
        failures.push(`  - ${entry.key} (reason: ${entry.reason})`);
      }
    }
    if (failures.length > 0) {
      throw new Error(
        [
          'EXPLICITLY_NO_DEFAULT_ROLE references key(s) not in PERMISSION_CATALOG:',
          ...failures,
          '',
          'Either add them to PERMISSION_CATALOG, or remove the EXPLICITLY_NO_DEFAULT_ROLE entry.',
        ].join('\n'),
      );
    }
  });

  it('every EXPLICITLY_NO_DEFAULT_ROLE entry has a non-empty reason', () => {
    const failures = EXPLICITLY_NO_DEFAULT_ROLE.filter(
      (e) => !e.reason || e.reason.trim().length < 20,
    );
    if (failures.length > 0) {
      throw new Error(
        [
          'EXPLICITLY_NO_DEFAULT_ROLE entries must have a meaningful reason (≥ 20 chars):',
          ...failures.map((e) => `  - ${e.key}: "${e.reason}"`),
        ].join('\n'),
      );
    }
  });

  it('role templates have unique names', () => {
    const names = DEFAULT_ROLE_TEMPLATES.map((t) => t.name);
    const duplicates = names.filter((n, i) => names.indexOf(n) !== i);
    expect(duplicates).toEqual([]);
  });

  /**
   * Pinned ceiling: LEGACY_UNGRANTED_KEYS must monotonically shrink as new
   * role templates absorb its members. If you find yourself raising this
   * number, stop — you're adding to legacy debt instead of granting the new
   * permission to a role or putting it in EXPLICITLY_NO_DEFAULT_ROLE.
   *
   * Lowering the number is fine and welcome — that means a key was actually
   * granted to a role and removed from the debt list.
   */
  it('LEGACY_UNGRANTED_KEYS does not grow beyond its initial ceiling', () => {
    const INITIAL_CEILING = 90;
    expect(LEGACY_UNGRANTED_KEYS.length).toBeLessThanOrEqual(INITIAL_CEILING);
  });
});
