import * as fs from 'fs';
import * as path from 'path';

/**
 * RLS audit Slice 11 — AdminGuard caller-free guarantee + residual-risk
 * parity pin.
 *
 * As of Slice 11.5 (2026-05-17) `@UseGuards(AdminGuard)` has **zero**
 * callers in non-spec code — every admin/config controller delegates to
 * `public.user_has_permission` via `@RequirePermission`. `AdminGuard`
 * survives only as a caller-free primitive (still exported by
 * AuthModule). codex's final review flagged that a caller-free
 * admin-only guard wired into AuthModule is a *reintroduction footgun*:
 * someone reaches for the familiar `@UseGuards(AdminGuard)` instead of
 * `@RequirePermission`, silently resurrecting the exact coarse-model
 * CRITICAL this whole slice closed.
 *
 * This spec is the cheap structural guard (fs + regex, no DB):
 *
 *   (0) CENSUS — zero `@UseGuards(...AdminGuard...)` decorators in any
 *       non-spec `apps/api/src` file. A new one fails CI loudly. This is
 *       the ban codex recommended in lieu of deleting the primitive.
 *
 *   (1)+(2) PARITY PIN — kept because the primitive still exists and
 *       could be reintroduced: if it ever is, its hand-mirrored
 *       assignment-validity must still match `user_has_permission`
 *       (active assignment + roles.active + starts_at/ends_at + tenant,
 *       admin.guard.ts:28-66). (1) both sources enforce the agreed
 *       validity set; (2) a closed-set canary — `user_has_permission`'s
 *       WHERE references NO `ura.`/`r.` column outside the documented
 *       allowlist, so a NEW validity predicate trips the test and forces
 *       a deliberate admin.guard.ts re-review.
 */

const REPO = path.resolve(__dirname, '../../../../..');
const MIGRATIONS = path.join(REPO, 'supabase/migrations');
const ADMIN_GUARD = path.join(__dirname, 'admin.guard.ts');

/** The latest migration that (re)defines public.user_has_permission. */
function latestUserHasPermissionSql(): { file: string; body: string } {
  const files = fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // zero-padded numeric prefixes → lexical == chronological
  let hit: { file: string; body: string } | null = null;
  for (const f of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), 'utf8');
    if (/create\s+or\s+replace\s+function\s+public\.user_has_permission/i.test(sql)) {
      hit = { file: f, body: sql };
    }
  }
  if (!hit) throw new Error('no migration defines public.user_has_permission');
  return hit;
}

/** Extract the EXISTS(...) subquery WHERE clause of user_has_permission. */
function whereClauseOf(sql: string): string {
  // from the join block down to the permissions ?| array — the validity
  // predicates live in between.
  const m = sql.match(/from\s+public\.user_role_assignments[\s\S]*?\?\|\s*array\[/i);
  if (!m) throw new Error('could not locate user_has_permission WHERE block');
  return m[0];
}

const API_SRC = path.join(REPO, 'apps/api/src');

/**
 * Every non-spec .ts file under apps/api/src that has a real
 * `@UseGuards(... AdminGuard ...)` DECORATOR (not a prose/JSDoc mention).
 * Comment lines (trimmed start `*`, `//`, `/*`) are skipped so the
 * Slice-11 explanatory comments that name the decorator don't false-fire.
 */
function adminGuardDecoratorFiles(): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.spec.ts')
      ) {
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        for (const raw of lines) {
          const t = raw.trim();
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) {
            continue;
          }
          if (/@UseGuards\([^)]*\bAdminGuard\b[^)]*\)/.test(raw)) {
            hits.push(path.relative(REPO, full));
            break;
          }
        }
      }
    }
  };
  walk(API_SRC);
  return hits.sort();
}

describe('AdminGuard ⇔ user_has_permission validity parity (Slice 11 residual-risk pin)', () => {
  const { file: sqlFile, body: sql } = latestUserHasPermissionSql();
  const where = whereClauseOf(sql);
  const guard = fs.readFileSync(ADMIN_GUARD, 'utf8');

  // (0) The ban codex recommended for the caller-free primitive. If
  // anyone re-introduces @UseGuards(AdminGuard) instead of
  // @RequirePermission, this fails — and the failure message tells them
  // which file + that the catalog model is the only sanctioned gate.
  it('has ZERO @UseGuards(AdminGuard) callers (the primitive stays caller-free)', () => {
    expect(adminGuardDecoratorFiles()).toEqual([]);
  });

  it(`canonical user_has_permission resolved from ${sqlFile}`, () => {
    expect(sqlFile).toMatch(/^\d{5}_.*\.sql$/);
  });

  // The agreed validity set both sides MUST enforce. [label, sqlRegex,
  // guardRegex]. If user_has_permission drops one, the SQL side fails;
  // if admin.guard.ts drops one, the guard side fails.
  const PARITY: Array<[string, RegExp, RegExp]> = [
    ['user scope', /ura\.user_id\s*=\s*p_user_id/i, /\.eq\(\s*['"]user_id['"]/],
    ['tenant scope', /ura\.tenant_id\s*=\s*p_tenant_id/i, /\.eq\(\s*['"]tenant_id['"]/],
    ['assignment active', /ura\.active\s*=\s*true/i, /\.eq\(\s*['"]active['"]\s*,\s*true\s*\)/],
    ['role active', /r\.active\s*=\s*true/i, /role\?\.active\s*!==\s*true/],
    [
      'starts_at lower bound',
      /ura\.starts_at\s+is\s+null\s+or\s+ura\.starts_at\s*<=\s*now\(\)/i,
      /starts_at[\s\S]{0,80}getTime\(\)\s*>\s*now/,
    ],
    [
      'ends_at upper bound',
      /ura\.ends_at\s+is\s+null\s+or\s+ura\.ends_at\s*>\s*now\(\)/i,
      /ends_at[\s\S]{0,80}getTime\(\)\s*<=\s*now/,
    ],
  ];

  it.each(PARITY)(
    '%s — enforced by BOTH user_has_permission and AdminGuard',
    (_label, sqlRe, guardRe) => {
      expect(where).toMatch(sqlRe);
      expect(guard).toMatch(guardRe);
    },
  );

  it('closed-set canary: user_has_permission references no ura./r. column outside the agreed set', () => {
    // Any token of the form ura.<col> or r.<col> inside the validity
    // block. Allowlist = join keys + the agreed validity columns +
    // the permission payload column. A NEW column here (e.g.
    // r.deleted_at) means a validity predicate changed → AdminGuard
    // parity must be re-reviewed, so fail loudly.
    const ALLOW = new Set([
      'ura.user_id',
      'ura.tenant_id',
      'ura.active',
      'ura.starts_at',
      'ura.ends_at',
      'ura.role_id', // join key
      'r.id', // join key
      'r.active',
      'r.permissions', // the permission payload (not a validity gate)
    ]);
    const referenced = new Set(
      [...where.matchAll(/\b(ura|r)\.[a-z_]+/gi)].map((m) => m[0].toLowerCase()),
    );
    const unexpected = [...referenced].filter((c) => !ALLOW.has(c));
    expect({ unexpected, file: sqlFile }).toEqual({ unexpected: [], file: sqlFile });
  });
});
