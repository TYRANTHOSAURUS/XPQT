// B.2 dispatch idempotency-replay remediation — RUNNABLE GUARD.
//
// Mirrors the mechanism of the shipped 00407 booking-edit guard
// (the `assemble-edit-plan.idempotency.spec.ts` GUARD 2 in the
// booking-edit module): a static jest spec that readFileSync's the
// migration .sql files from the monorepo root (cwd-robust candidate
// walk) and regex-asserts a textual property of the *resolved* RPC
// definition. Picked up by the standard `jest` run exactly like the
// 00407 guard (jest.config.js: rootDir 'src', testRegex
// '.*\.spec\.tsx?$') — no extra wiring needed; `pnpm -C apps/api test`
// runs it. Same gate the 00407 guard sits in.
//
// The P0 (verified + codex-design-checked): dispatch_child_work_order
// (00341:153) and dispatch_child_work_orders_batch (00342:104) computed
// the command_operations idempotency hash over the WHOLE payload text
// (`md5(coalesce(p_payload::text,''))` / `md5(coalesce(p_tasks::text,
// ''))`). The dispatch payload carries the SLA timers[] array whose
// due_at is call-time now()-anchored by the producer, so a legitimate
// retry of the same logical dispatch under the same idempotency key
// hashed differently → spurious command_operations.payload_mismatch
// 409. 00428 fixes it by routing both RPCs through
// public.dispatch_idempotency_payload_hash(...).
//
// WHY THIS GUARD EXISTS (it would have caught C1): an adversarial
// review found 00428's batch block had been reproduced from the STALE
// 00337 (batch v1) instead of the LATEST 00342 (v3). Because
// `create or replace` makes the numerically-last applied body win,
// shipping 00428-from-00337 would have (a) silently REVERTED 00342's
// per-task routing_rule_id cross-tenant guard + sla_timers polymorphic
// columns AND (b) re-pointed the batch hash at raw
// `md5(coalesce(p_tasks::text,''))`. This guard resolves, for EACH
// dispatch function, the numerically-highest migration that contains a
// `create or replace function public.<sig>(` block (the body that wins
// under create-or-replace ordering) and asserts that winning body:
//   - assigns v_payload_hash via
//     public.dispatch_idempotency_payload_hash(...), AND
//   - contains NO raw `v_payload_hash := md5(coalesce(p_payload::text`
//     / `md5(coalesce(p_tasks::text` assignment.
// Run against the PRE-FIX 00428 this FAILS on the batch function (its
// winning body, 00428, carried `md5(coalesce(p_tasks::text,''))` from
// stale 00337) — i.e. it catches the exact C1 stale-source clobber.
//
// Citation discipline: every migration / line referenced below was
// Read in this session.
//   - supabase/migrations/00428_dispatch_idempotency_intent_hash.sql —
//     dispatch_idempotency_payload_hash helper + both reproduced RPCs.
//   - 00336/00338/00341 (single chain), 00337/00339/00342 (batch
//     chain) — historical create-or-replace definitions.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// jest cwd is apps/api; migrations live at the monorepo root. Walk the
// candidate roots until supabase/migrations resolves so the guard is
// robust to the runner's cwd (identical strategy to the 00407 guard).
function resolveMigrationsDir(): string {
  const candidates = [
    join(process.cwd(), 'supabase', 'migrations'),
    join(process.cwd(), '..', '..', 'supabase', 'migrations'),
  ];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    'dispatch idempotency guard: could not resolve supabase/migrations from cwd ' +
      process.cwd(),
  );
}

// The leading numeric prefix is the apply-order key. `create or replace`
// makes the highest-numbered body win, so the guard must inspect THAT
// migration's body (not the first/oldest definition).
function migrationNumber(fileName: string): number {
  const m = fileName.match(/^(\d+)/);
  return m ? Number.parseInt(m[1], 10) : -1;
}

// Two dispatch RPCs; the `(`-anchored signature disambiguates single
// from batch (`dispatch_child_work_order(` does NOT match
// `dispatch_child_work_orders_batch(` thanks to the trailing paren).
const RPCS = [
  {
    fn: 'dispatch_child_work_order',
    createNeedle: 'create or replace function public.dispatch_child_work_order(',
    rawMd5: 'md5(coalesce(p_payload::text',
    helperCall: 'v_payload_hash := public.dispatch_idempotency_payload_hash(p_payload)',
  },
  {
    fn: 'dispatch_child_work_orders_batch',
    createNeedle:
      'create or replace function public.dispatch_child_work_orders_batch(',
    rawMd5: 'md5(coalesce(p_tasks::text',
    helperCall: 'v_payload_hash := public.dispatch_idempotency_payload_hash(p_tasks)',
  },
] as const;

// Slice the text of ONE `create or replace function public.<sig>( ... $$;`
// block out of a migration so the assertions only look at the function
// body that defines THIS RPC (a migration like 00428 defines both, plus
// the hash-helper which legitimately contains `md5(`).
function extractFunctionBlock(sql: string, createNeedle: string): string | null {
  const start = sql.indexOf(createNeedle);
  if (start < 0) return null;
  // The plpgsql body is delimited by the first `$$` after the header and
  // its matching close `$$;`. Find the opening `$$`, then the next `$$;`.
  const open = sql.indexOf('$$', start);
  if (open < 0) return null;
  const close = sql.indexOf('$$;', open + 2);
  if (close < 0) return null;
  return sql.slice(start, close + 3);
}

describe('Dispatch idempotency-hash determinism (B.2 P0 guard)', () => {
  const migrationsDir = resolveMigrationsDir();
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

  for (const rpc of RPCS) {
    it(`${rpc.fn}: the resolved (numerically-highest) definition routes v_payload_hash through public.dispatch_idempotency_payload_hash and uses no raw md5(...)`, () => {
      // Every migration that contains a `create or replace` for this
      // exact signature, ordered by numeric prefix. The LAST one wins
      // under create-or-replace apply ordering.
      const definers = files
        .filter((f) =>
          readFileSync(join(migrationsDir, f), 'utf8').includes(
            rpc.createNeedle,
          ),
        )
        .sort((a, b) => migrationNumber(a) - migrationNumber(b));

      // Sanity: there is at least one definition (catches a rename /
      // path move that would otherwise make the guard vacuously pass).
      expect(definers.length).toBeGreaterThan(0);

      const winningFile = definers[definers.length - 1];
      const winningSql = readFileSync(
        join(migrationsDir, winningFile),
        'utf8',
      );
      const block = extractFunctionBlock(winningSql, rpc.createNeedle);
      expect(block).not.toBeNull();
      const body = block as string;

      // The winning body MUST route the idempotency hash through the
      // deterministic helper.
      expect(body).toContain(rpc.helperCall);

      // …and MUST NOT carry a raw whole-payload md5 assignment. This is
      // the exact line that the stale-source (00337/00339) reproduction
      // would have re-introduced — i.e. the C1 failure mode. Scoped to
      // the v_payload_hash assignment so the strip helper's own internal
      // `md5(...)` (a different function block) is never matched.
      const rawAssignment = new RegExp(
        String.raw`v_payload_hash\s*:=\s*md5\(coalesce\(p_(payload|tasks)::text`,
        'i',
      );
      expect(rawAssignment.test(body)).toBe(false);
      // Belt-and-braces: the substring form too (regex + literal both
      // must agree the raw form is absent in this function block).
      expect(body.includes(rpc.rawMd5)).toBe(false);
    });
  }

  it('the dispatch idempotency hash helper exists and is the single source of the strip+md5', () => {
    // The helper is defined once (00428). If a later migration ever
    // redefines it with a non-deterministic body the booking-edit-style
    // dynamic guard would be the place to catch behaviour; here we only
    // assert the helper + strip primitive are present in the resolved
    // set so the RPC-side assertions above are not pointing at a
    // dangling function.
    const helperDefiners = files.filter((f) =>
      readFileSync(join(migrationsDir, f), 'utf8').includes(
        'create or replace function public.dispatch_idempotency_payload_hash(',
      ),
    );
    expect(helperDefiners.length).toBeGreaterThan(0);

    const stripDefiners = files.filter((f) =>
      readFileSync(join(migrationsDir, f), 'utf8').includes(
        'create or replace function public.dispatch_strip_hash_server_fields(',
      ),
    );
    expect(stripDefiners.length).toBeGreaterThan(0);
  });

  it('the resolved dispatch_strip_hash_server_fields body is the path-scoped timers[].due_at strip and not neutered (identity / flat-exclusion / due_at-not-stripped)', () => {
    // The codex binding constraint for 00428 was a PATH-SCOPED strip:
    // remove due_at ONLY from elements of an array stored under a key
    // literally named `timers`, so an arbitrary routing_context.due_at
    // is preserved. Two neuter classes would silently re-open the P0
    // (timer replays still mismatch) or the codex constraint (a flat
    // `key not in (...)` revert over-strips routing_context.due_at):
    //   - identity  : the body just returns its input untouched
    //                  (`select p_value` / `returns p_payload`) with no
    //                  timers / due_at handling → due_at never stripped.
    //   - flat-revert: a recursive flat `key not in ('due_at', …)`
    //                  exclusion list (the explicitly-rejected shape).
    // This resolves the numerically-highest migration that contains a
    // `create or replace` for the strip helper (the body that wins under
    // create-or-replace apply ordering — same resolution discipline as
    // the RPC guards above) and asserts the winning body keeps the
    // path-scoped shape. Out of scope (codex-marked): CREATE
    // FUNCTION-without-OR-REPLACE / DO-block dynamic SQL — the realistic
    // regression is helper neutering / flat-revert / identity.
    const stripNeedle =
      'create or replace function public.dispatch_strip_hash_server_fields(';
    const definers = files
      .filter((f) =>
        readFileSync(join(migrationsDir, f), 'utf8').includes(stripNeedle),
      )
      .sort((a, b) => migrationNumber(a) - migrationNumber(b));

    // Sanity: at least one definition (catches a rename / path move that
    // would otherwise make this guard vacuously pass).
    expect(definers.length).toBeGreaterThan(0);

    const winningFile = definers[definers.length - 1];
    const winningSql = readFileSync(join(migrationsDir, winningFile), 'utf8');
    const block = extractFunctionBlock(winningSql, stripNeedle);
    expect(block).not.toBeNull();
    const body = block as string;

    // MUST be path-scoped: a branch keyed on the literal `timers` key.
    // Accept either ordering of the equality (`key = 'timers'` /
    // `'timers' = key`) and either quote style around the literal.
    const timersBranch = new RegExp(
      String.raw`(\bkey\s*=\s*'timers'|'timers'\s*=\s*\bkey\b)`,
      'i',
    );
    expect(timersBranch.test(body)).toBe(true);

    // MUST delete the `due_at` key off timer array elements
    // (`elem - 'due_at'` / `value - 'due_at'` — the jsonb `-` operator).
    const dueAtDeletion = new RegExp(String.raw`-\s*'due_at'`, 'i');
    expect(dueAtDeletion.test(body)).toBe(true);

    // MUST NOT be an identity / no-op: a body whose only return is the
    // raw input with no timers/due_at handling. (The real body contains
    // both `timers` and `due_at`, so these neuter shapes are mutually
    // exclusive with the assertions above — encoded explicitly so the
    // failure mode is named, not implied.)
    const stripsDueAt = dueAtDeletion.test(body);
    const hasTimersBranch = timersBranch.test(body);
    expect(hasTimersBranch && stripsDueAt).toBe(true);

    // MUST NOT have reverted to the explicitly-rejected flat recursive
    // exclusion list (`key not in ('due_at', …)`). The codex binding
    // constraint was path-scoped, NOT a flat exclusion set.
    const flatExclusion = /key\s+not\s+in\s*\(/i;
    expect(flatExclusion.test(body)).toBe(false);
  });
});
