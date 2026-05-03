import * as fs from 'fs';
import * as path from 'path';
import {
  DEFAULT_ROLE_TEMPLATES,
  type PermissionKey,
} from '@prequest/shared';

/**
 * TS-vs-SQL parity test for default role permissions.
 *
 * The slice that introduced `DEFAULT_ROLE_TEMPLATES` documented in the file
 * header that drift between TS and the SQL seed must be fixed in the same PR.
 * Within 3 days, the visitors workstream proved that comments-as-policy don't
 * survive: `visitors.reception` and `visitors.invite` landed in TS without a
 * SQL backfill, leaving every existing tenant out of sync.
 *
 * This test is the cheapest automated enforcement of the rule:
 *
 *   For every CONCRETE permission key in DEFAULT_ROLE_TEMPLATES, the literal
 *   string must appear *somewhere* in `supabase/migrations/**\/*.sql`.
 *
 * Wildcards (`*.*`, `*.read`, `tickets.*`, etc.) are exempt — they're seeded
 * as-is in 00112 and the test would create false positives. Concrete keys
 * (`tickets.create`, `visitors.invite`, etc.) MUST be acknowledged by some
 * migration — either the original seed (00112), an UPDATE that adds the key
 * to an existing role, or a new role definition.
 *
 * What this catches: "I added 'visitors.invite' to TS but never wrote SQL".
 *
 * What this doesn't catch (intentional, to keep the test simple):
 *   - Permission MOVED between roles in TS without a SQL counterpart
 *     (the literal still appears, just under a different role name)
 *   - Permission REMOVED from a role in TS without a SQL counterpart
 *     (the literal still appears in 00112 even after a hypothetical
 *     remove)
 *   - SQL-side keys that are NOT in TS (covered by the SQL coverage spec)
 *
 * If those weaker guarantees become a problem, upgrade to a real SQL parser
 * + state machine. Until then this catches the dominant failure mode.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../..', 'supabase/migrations');

function isWildcard(key: PermissionKey): boolean {
  return key.includes('*');
}

function loadMigrationCorpus(): string {
  if (!fs.existsSync(MIGRATIONS_DIR)) return '';
  const parts: string[] = [];
  for (const f of fs.readdirSync(MIGRATIONS_DIR).sort()) {
    if (!f.endsWith('.sql')) continue;
    parts.push(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
  }
  return parts.join('\n');
}

describe('TS role-defaults vs SQL seed parity', () => {
  const corpus = loadMigrationCorpus();

  it('migrations corpus loaded (sanity check)', () => {
    expect(corpus.length).toBeGreaterThan(1000);
  });

  it('every concrete permission in DEFAULT_ROLE_TEMPLATES appears as a string literal in some SQL migration', () => {
    const orphans: Array<{ role: string; key: string }> = [];
    for (const tpl of DEFAULT_ROLE_TEMPLATES) {
      for (const key of tpl.permissions) {
        if (isWildcard(key)) continue;
        /* The key may appear as a SQL string literal (`'tickets.read'`)
           in WHERE/UPDATE clauses, or as a double-quoted JSON string
           inside a JSONB literal (`'["tickets.read", ...]'::jsonb`)
           in INSERT seeds. Either form proves the key has been
           acknowledged by SQL. */
        const sqlLiteral = `'${key}'`;
        const jsonLiteral = `"${key}"`;
        if (!corpus.includes(sqlLiteral) && !corpus.includes(jsonLiteral)) {
          orphans.push({ role: tpl.name, key });
        }
      }
    }
    if (orphans.length > 0) {
      const lines = [
        `${orphans.length} permission(s) added to DEFAULT_ROLE_TEMPLATES without any SQL backfill:`,
        ...orphans.map((o) => `  - ${o.role}: '${o.key}'`),
        '',
        'role-defaults.ts and the SQL seed must agree per PR. Either:',
        '  (a) Write a backfill migration that adds the key(s) to existing seeded',
        '      roles via the pg_temp.merge_role_permissions pattern in 00284, OR',
        '  (b) If the key was renamed/removed, update DEFAULT_ROLE_TEMPLATES to match.',
        '',
        'This test catches the visitors-style drift class. Without it, brand-new',
        'tenants get stale role permissions and customer-visible features silently',
        'fail (e.g. reception staff can\'t open /reception/* because their seeded',
        'role lacks visitors.reception).',
      ];
      throw new Error(lines.join('\n'));
    }
  });
});
