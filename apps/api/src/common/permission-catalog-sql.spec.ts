import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_ROLE_TEMPLATES,
  EXPLICITLY_NO_DEFAULT_ROLE,
  LEGACY_UNGRANTED_KEYS,
  matches,
  validatePermission,
  type PermissionKey,
} from '@prequest/shared';

/**
 * SQL-side permission-catalog coverage tests.
 *
 * The TypeScript-side gate (permission-catalog.spec.ts) catches typos at
 * `requirePermission(...)` callsites. But Postgres functions inside
 * migrations also call `user_has_permission(p_user_id, p_tenant_id, 'X.Y')`
 * with arbitrary string literals — that path bypasses the TS gate entirely.
 *
 * History: `rooms.read_all` was referenced in 00245 + 00255-style migrations
 * for months without ever existing in PERMISSION_CATALOG. Anyone querying
 * the catalog for it got nothing; the only role that satisfied it was `*.*`
 * superadmin. This spec exists so that class of orphan can't recur.
 *
 * The grep is intentionally narrow: only `user_has_permission(_, _, '<key>')`
 * with a string literal in the third arg position. Functions that build
 * the key dynamically (concat / format / variable) escape the check — we
 * accept that to keep the regex simple and the false-positive rate at zero.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../..', 'supabase/migrations');

/**
 * Match `user_has_permission(<arg>, <arg>, '<key>')`. Tolerates whitespace,
 * newlines, and comments between args. The key must be a single-quoted
 * literal — dynamic concatenation is intentionally out of scope.
 */
const USER_HAS_PERMISSION_RE =
  /user_has_permission\s*\(\s*[^,]+,\s*[^,]+,\s*'([^']+)'\s*\)/g;

interface SqlKeyHit {
  file: string;
  key: string;
}

function listMigrationKeys(): SqlKeyHit[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const hits: SqlKeyHit[] = [];
  for (const file of files) {
    const body = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    let match: RegExpExecArray | null;
    USER_HAS_PERMISSION_RE.lastIndex = 0;
    while ((match = USER_HAS_PERMISSION_RE.exec(body)) !== null) {
      hits.push({ file, key: match[1] });
    }
  }
  return hits;
}

describe('SQL migration permission keys vs PERMISSION_CATALOG', () => {
  const hits = listMigrationKeys();

  it('found at least one user_has_permission call (sanity check)', () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it('every user_has_permission key in supabase/migrations/*.sql is well-formed and registered', () => {
    const failures: Array<{ file: string; key: string; reason: string }> = [];
    for (const hit of hits) {
      const result = validatePermission(hit.key);
      if (!result.ok) {
        failures.push({ file: hit.file, key: hit.key, reason: result.reason });
      }
    }
    if (failures.length > 0) {
      const lines = [
        `${failures.length} SQL migration(s) reference unregistered permission keys:`,
        ...failures.map(
          (f) => `  - ${f.file}: '${f.key}' — ${f.reason}`,
        ),
        '',
        'Either add the key to PERMISSION_CATALOG (packages/shared/src/permissions.ts)',
        'with a default-role decision per role-defaults.ts, or change the SQL to use',
        'a registered key. The TS-side type guard catches this in controllers; this',
        'test catches it in migrations.',
      ];
      throw new Error(lines.join('\n'));
    }
  });

  it('every user_has_permission key is granted by some default role OR explicitly opted out (matches the TS gate semantics)', () => {
    /* Mirrors the TS-side coverage gate: a SQL-side check that resolves
       only via `*.*` superadmin is the same security antipattern as a
       TS-side one. The exemption sets are unioned so a key that's
       intentionally Tenant-Admin-only (e.g. gdpr.*) doesn't trip the
       SQL gate either. */
    const exempt = new Set<string>([
      ...EXPLICITLY_NO_DEFAULT_ROLE.map((e) => e.key as string),
      ...LEGACY_UNGRANTED_KEYS.map((k) => k as string),
    ]);
    const failures: Array<{ file: string; key: string }> = [];
    const filteredGrants = (perms: readonly PermissionKey[]): string[] =>
      perms.filter((g) => g !== '*.*') as string[];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (seen.has(hit.key)) continue;
      seen.add(hit.key);
      if (exempt.has(hit.key)) continue;
      const covered = DEFAULT_ROLE_TEMPLATES.some((tpl) =>
        matches(filteredGrants(tpl.permissions), hit.key),
      );
      if (!covered) failures.push(hit);
    }
    if (failures.length > 0) {
      const lines = [
        `${failures.length} SQL-side permission key(s) only resolve via *.* superadmin:`,
        ...failures.map((f) => `  - ${f.file}: '${f.key}'`),
        '',
        'Grant the key to a default role in role-defaults.ts, or list it in',
        'EXPLICITLY_NO_DEFAULT_ROLE with a written reason. Same rule as the TS',
        'gate — the *.* trivial grant doesn’t count.',
      ];
      throw new Error(lines.join('\n'));
    }
  });
});
