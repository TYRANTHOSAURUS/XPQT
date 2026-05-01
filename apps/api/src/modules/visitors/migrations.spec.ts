/**
 * Visitor Management v1 — schema integration tests.
 *
 * Validates the migration block 00248–00258:
 *   1. Cross-tenant leak — every new table refuses to return tenant-A rows
 *      to a tenant-B caller via the RLS predicate (set local request.jwt.claims).
 *   2. Composite-FK guard — visitor_pass_pool.{current,reserved}_visitor_id
 *      cannot reference a visitor in a different tenant; raises
 *      foreign_key_violation.
 *   3. State machine — assert_visitor_status_transition() trigger blocks
 *      illegal transitions (expected → checked_out, expected → pending_approval),
 *      allows expected → arrived.
 *
 * Connects directly via pg to the local Supabase Postgres (port 54322 by
 * default, override via SUPABASE_DB_URL or PG_TEST_URL). Skips the suite
 * cleanly when no DB is reachable so CI stages without a DB don't break.
 */

import { Client } from 'pg';

const PG_URL = process.env.PG_TEST_URL ?? process.env.SUPABASE_DB_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

let client: Client;
let dbAvailable = false;

const TENANT_A = '99000000-0000-0000-0000-000000000aaa';
const TENANT_B = '99000000-0000-0000-0000-000000000bbb';

beforeAll(async () => {
  client = new Client({ connectionString: PG_URL });
  try {
    await client.connect();
    // Smoke probe — does the visitors v1 schema exist? If not, the tests can't run.
    const probe = await client.query("select to_regclass('public.visitor_types') as t");
    if (!probe.rows[0].t) {
      console.warn('[visitors-v1.spec] visitor_types missing — skipping suite (apply migration 00248-00258 first).');
      dbAvailable = false;
      return;
    }
    dbAvailable = true;
  } catch (err) {
    console.warn(`[visitors-v1.spec] cannot reach Postgres at ${PG_URL} — skipping suite.`, err);
    dbAvailable = false;
  }
});

afterAll(async () => {
  if (!client) return;
  // Best-effort cleanup of fixtures we created. ON DELETE CASCADE handles
  // descendants (visitor_hosts → visitors, tokens → visitors, pool composite
  // FK requires nulling first).
  try {
    await client.query("set local role postgres");
    await client.query(`update public.visitor_pass_pool set status='available', current_visitor_id=null, reserved_for_visitor_id=null where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.visit_invitation_tokens where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.visitor_hosts where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.visitor_pass_pool where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.visitor_types where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.visitors where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    // user_role_assignments / users / roles — cleaned up before persons because of FKs.
    await client.query(`delete from public.user_role_assignments where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.users where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.roles where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.persons where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.spaces where tenant_id=$1 or tenant_id=$2`, [TENANT_A, TENANT_B]);
    await client.query(`delete from public.tenants where id=$1 or id=$2`, [TENANT_A, TENANT_B]);
  } finally {
    await client.end();
  }
});

/** Wrap each test in a transaction and roll back so fixtures don't bleed between tests. */
async function withTxn<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await fn();
    await client.query('rollback');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}

/**
 * Set the JWT claims for the current transaction. `current_tenant_id()`
 * reads from `request.jwt.claims->>'tenant_id'` so this is what RLS sees.
 */
async function setTenantClaim(tenantId: string): Promise<void> {
  // Postgres SET commands do not accept parameter binding ($1). Validate the
  // input ourselves (UUID-shape only) and interpolate the JSON literal.
  if (!/^[0-9a-fA-F-]{36}$/.test(tenantId)) {
    throw new Error(`refusing to set claim with non-UUID tenant_id: ${tenantId}`);
  }
  const claims = JSON.stringify({ tenant_id: tenantId, sub: '00000000-0000-0000-0000-000000000000' });
  // Quote the JSON literal as a SQL string (single-quote-escape).
  const quoted = `'${claims.replace(/'/g, "''")}'`;
  await client.query(`set local request.jwt.claims = ${quoted}`);
  // Drop role to authenticated so RLS predicates evaluate (postgres role bypasses RLS).
  await client.query(`set local role authenticated`);
}

async function ensureBaseFixtures(): Promise<void> {
  // Tenants (no FK → safe to upsert). slug is NOT NULL; use a unique-ish value.
  // session_replication_role=replica suppresses AFTER INSERT triggers — the
  // GDPR retention seed trigger references a column that drifted out of sync
  // with the table schema (pre-existing repo bug, unrelated to v1 visitors).
  // The visitor-types seed trigger fires too, but it's idempotent (ON CONFLICT
  // DO NOTHING) so re-running the test is fine.
  await client.query(`set local session_replication_role = replica`);
  await client.query(
    `insert into public.tenants (id, name, slug) values
       ($1, 'Tenant A', 'visitors-spec-tenant-a'),
       ($2, 'Tenant B', 'visitors-spec-tenant-b')
     on conflict (id) do nothing`,
    [TENANT_A, TENANT_B],
  );
  await client.query(`set local session_replication_role = origin`);
  // One site per tenant — required as space anchor for pool + buildings.
  await client.query(`
    insert into public.spaces (id, tenant_id, type, name, parent_id) values
      ('99000000-0000-0000-0000-000000000a01', $1, 'site', 'A Site', null),
      ('99000000-0000-0000-0000-000000000b01', $2, 'site', 'B Site', null)
    on conflict (id) do nothing
  `, [TENANT_A, TENANT_B]);
  // One persons row per tenant for host references.
  await client.query(`
    insert into public.persons (id, tenant_id, type, first_name, last_name) values
      ('99000000-0000-0000-0000-000000000a99', $1, 'employee', 'Alice', 'Host'),
      ('99000000-0000-0000-0000-000000000b99', $2, 'employee', 'Bob', 'Host')
    on conflict (id) do nothing
  `, [TENANT_A, TENANT_B]);
}

// --------------------------------------------------------------------------
// 1. Cross-tenant leak tests — every new table.
//
// "Opaque" here means: from tenant B's claim, the row is unreachable. Two
// outcomes both qualify:
//   (a) zero rows returned (RLS predicate filtered the row).
//   (b) `permission denied for table` (grants are service_role-only — even
//       stronger isolation; the table is not even readable as authenticated).
// Either is a valid demonstration that tenant B cannot exfiltrate tenant A's
// data through PostgREST. The current visitor_types / visitor_hosts /
// visitor_pass_pool / visit_invitation_tokens migrations chose option (b).
// --------------------------------------------------------------------------

async function expectOpaqueAcrossTenants(query: string): Promise<void> {
  let rowCount: number | null = null;
  try {
    const r = await client.query(query);
    rowCount = r.rowCount;
  } catch (err: any) {
    // 42501 = insufficient_privilege (Postgres "permission denied for ...").
    if (err?.code === '42501') return;
    throw err;
  }
  expect(rowCount).toBe(0);
}

describe('visitors v1 schema — cross-tenant isolation', () => {
  test('visitor_types is opaque across tenants', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      await client.query(
        `insert into public.visitor_types (tenant_id, type_key, display_name) values ($1, 'spec_test_only', 'Spec Test Only')`,
        [TENANT_A],
      );

      await setTenantClaim(TENANT_B);
      await expectOpaqueAcrossTenants(`select id from public.visitor_types where type_key = 'spec_test_only'`);
    });
  });

  test('visitor_hosts is opaque across tenants', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      // Need a visitor in tenant A first (for the host FK).
      const v = await client.query(
        `insert into public.visitors (tenant_id, person_id, host_person_id, visit_date, status, primary_host_person_id)
         values ($1, $2, $2, current_date, 'expected', $2) returning id`,
        [TENANT_A, '99000000-0000-0000-0000-000000000a99'],
      );
      await client.query(
        `insert into public.visitor_hosts (visitor_id, person_id, tenant_id) values ($1, $2, $3)`,
        [v.rows[0].id, '99000000-0000-0000-0000-000000000a99', TENANT_A],
      );

      await setTenantClaim(TENANT_B);
      // Inline the visitor_id literal — Postgres SET barriers prevent param binding here, but the id was generated server-side.
      await expectOpaqueAcrossTenants(`select visitor_id from public.visitor_hosts where visitor_id = '${v.rows[0].id}'`);
    });
  });

  test('visitor_pass_pool is opaque across tenants', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      await client.query(
        `insert into public.visitor_pass_pool (tenant_id, space_id, pass_number, space_kind)
         values ($1, '99000000-0000-0000-0000-000000000a01', 'A-001', 'site')`,
        [TENANT_A],
      );

      await setTenantClaim(TENANT_B);
      await expectOpaqueAcrossTenants(`select id from public.visitor_pass_pool where pass_number = 'A-001'`);
    });
  });

  test('visit_invitation_tokens is opaque across tenants', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      const v = await client.query(
        `insert into public.visitors (tenant_id, person_id, host_person_id, visit_date, status, primary_host_person_id)
         values ($1, $2, $2, current_date, 'expected', $2) returning id`,
        [TENANT_A, '99000000-0000-0000-0000-000000000a99'],
      );
      await client.query(
        `insert into public.visit_invitation_tokens (visitor_id, tenant_id, token_hash, purpose, expires_at)
         values ($1, $2, 'spec-test-hash', 'cancel', now() + interval '7 days')`,
        [v.rows[0].id, TENANT_A],
      );

      await setTenantClaim(TENANT_B);
      await expectOpaqueAcrossTenants(`select id from public.visit_invitation_tokens where token_hash = 'spec-test-hash'`);
    });
  });

  test('kiosk_tokens is opaque across tenants (service_role only)', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      // Insert as service_role — the only role with INSERT grant. Authenticated
      // and anon roles have no grants on this table; anonymous lookups go
      // through a SECURITY DEFINER function (added in slice 2). RLS is on with
      // no tenant_isolation policy because access is gated at the grant level.
      await client.query(`set local role service_role`);
      await client.query(
        `insert into public.kiosk_tokens (tenant_id, building_id, token_hash)
         values ($1, '99000000-0000-0000-0000-000000000a01', 'spec-test-kiosk-hash')`,
        [TENANT_A],
      );

      // Tenant B claim — must NOT see tenant A's row. expectOpaqueAcrossTenants
      // accepts either zero rows (RLS predicate) or 42501 (revoked grants);
      // for kiosk_tokens this hits the 42501 path because authenticated has no
      // SELECT grant at all. Wrap in a savepoint so the 42501 error doesn't
      // poison the outer transaction (we run a second select after this).
      await setTenantClaim(TENANT_B);
      await client.query('savepoint sp_kiosk_b');
      try {
        await expectOpaqueAcrossTenants(`select id from public.kiosk_tokens where token_hash = 'spec-test-kiosk-hash'`);
      } finally {
        await client.query('rollback to savepoint sp_kiosk_b');
      }

      // Tenant A claim — also must NOT see the row, because the table is
      // service_role-only by design (no authenticated grant). This is the
      // critical assertion for the access model: even the owning tenant's
      // authenticated role cannot read kiosk_tokens directly; only the
      // SECURITY DEFINER lookup function (slice 2) can.
      await setTenantClaim(TENANT_A);
      await client.query('savepoint sp_kiosk_a');
      try {
        await expectOpaqueAcrossTenants(`select id from public.kiosk_tokens where token_hash = 'spec-test-kiosk-hash'`);
      } finally {
        await client.query('rollback to savepoint sp_kiosk_a');
      }
    });
  });
});

// --------------------------------------------------------------------------
// 2. Composite-FK guard — pool cannot reference a visitor in another tenant.
// --------------------------------------------------------------------------

describe('visitors v1 schema — composite FK guard (pool ↔ visitor)', () => {
  test('visitor_pass_pool.current_visitor_id rejects cross-tenant visitor', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();
      // Tenant A pool.
      const pool = await client.query(
        `insert into public.visitor_pass_pool (tenant_id, space_id, pass_number, space_kind)
         values ($1, '99000000-0000-0000-0000-000000000a01', 'A-FKTEST', 'site') returning id`,
        [TENANT_A],
      );
      // Tenant B visitor.
      const v = await client.query(
        `insert into public.visitors (tenant_id, person_id, host_person_id, visit_date, status, primary_host_person_id)
         values ($1, $2, $2, current_date, 'expected', $2) returning id`,
        [TENANT_B, '99000000-0000-0000-0000-000000000b99'],
      );

      // Update should fail with foreign_key_violation (the composite FK
      // (tenant_id, current_visitor_id) → visitors(tenant_id, id) cannot
      // resolve a tenant-A pool's UUID against tenant-B's visitors row).
      await expect(
        client.query(
          `update public.visitor_pass_pool set status='in_use', current_visitor_id=$1 where id=$2`,
          [v.rows[0].id, pool.rows[0].id],
        ),
      ).rejects.toMatchObject({ code: '23503' /* foreign_key_violation */ });
    });
  });
});

// --------------------------------------------------------------------------
// 3. Status state machine — defense-in-depth trigger.
// --------------------------------------------------------------------------

describe('visitors v1 schema — status FSM trigger', () => {
  async function freshVisitor(): Promise<string> {
    await client.query(`set local role postgres`);
    await ensureBaseFixtures();
    const v = await client.query(
      `insert into public.visitors (tenant_id, person_id, host_person_id, visit_date, status, primary_host_person_id)
       values ($1, $2, $2, current_date, 'expected', $2) returning id`,
      [TENANT_A, '99000000-0000-0000-0000-000000000a99'],
    );
    return v.rows[0].id;
  }

  test('expected → checked_out (skip arrived) raises', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      const id = await freshVisitor();
      await expect(
        client.query(
          `update public.visitors set status='checked_out', checkout_source='reception' where id=$1`,
          [id],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('invalid visitor status transition') });
    });
  });

  test('expected → arrived succeeds', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      const id = await freshVisitor();
      const r = await client.query(
        `update public.visitors set status='arrived' where id=$1 returning status`,
        [id],
      );
      expect(r.rows[0].status).toBe('arrived');
    });
  });

  test('expected → pending_approval (backward arrow) raises', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      const id = await freshVisitor();
      await expect(
        client.query(
          `update public.visitors set status='pending_approval' where id=$1`,
          [id],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('invalid visitor status transition') });
    });
  });

  test('checked_out is terminal — further transitions raise', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      const id = await freshVisitor();
      await client.query(`update public.visitors set status='arrived' where id=$1`, [id]);
      await client.query(
        `update public.visitors set status='checked_out', checkout_source='reception' where id=$1`,
        [id],
      );
      await expect(
        client.query(`update public.visitors set status='arrived' where id=$1`, [id]),
      ).rejects.toMatchObject({ message: expect.stringContaining('invalid visitor status transition') });
    });
  });
});

// --------------------------------------------------------------------------
// 4. Visibility predicate — Tier 2 empty-scope leak regression (00259).
//
// Bug being prevented:
//   00255 used `array_length(rc.location_closure, 1) is null
//                 OR v.building_id = any(rc.location_closure)
//                 OR v.building_id is null`
//   array_length on an empty array is NULL, so a user with
//   `visitors.reception` permission and NULL/{} location_scope would see
//   every visitor in the tenant — silent Tier 3 escalation. 00259 replaces
//   that with `cardinality(...) > 0 AND (...)` so empty scope = no rows.
// --------------------------------------------------------------------------

describe('visitor_visibility_ids — Tier 2 empty-scope leak regression', () => {
  test('Tier 2 user with empty location_scope sees zero visitors', async () => {
    if (!dbAvailable) return;
    await withTxn(async () => {
      await client.query(`set local role postgres`);
      await ensureBaseFixtures();

      // Building belonging to tenant A (under the site fixture) — used both
      // for the visitor's building_id and as the scope value in step 2.
      const buildingId = '99000000-0000-0000-0000-000000000a02';
      await client.query(
        `insert into public.spaces (id, tenant_id, type, name, parent_id) values
           ($1, $2, 'building', 'A Building', '99000000-0000-0000-0000-000000000a01')
         on conflict (id) do nothing`,
        [buildingId, TENANT_A],
      );

      // Visitor anchored to that building.
      const v = await client.query(
        `insert into public.visitors (tenant_id, person_id, host_person_id, visit_date, status, primary_host_person_id, building_id)
         values ($1, $2, $2, current_date, 'expected', $2, $3) returning id`,
        [TENANT_A, '99000000-0000-0000-0000-000000000a99', buildingId],
      );
      const visitorId = v.rows[0].id;

      // Operator user (NOT a host on this visitor) with `visitors.reception`
      // permission via a role assignment that has NULL location_scope.
      // Person is distinct from the visitor's host_person_id so Tier 1
      // can't accidentally satisfy the predicate.
      const operatorPersonId = '99000000-0000-0000-0000-000000000a98';
      await client.query(
        `insert into public.persons (id, tenant_id, type, first_name, last_name) values
           ($1, $2, 'employee', 'Olive', 'Operator')
         on conflict (id) do nothing`,
        [operatorPersonId, TENANT_A],
      );
      const userInsert = await client.query(
        `insert into public.users (tenant_id, person_id, email, status)
         values ($1, $2, 'olive.operator+spec@example.com', 'active') returning id`,
        [TENANT_A, operatorPersonId],
      );
      const userId = userInsert.rows[0].id;

      const roleInsert = await client.query(
        `insert into public.roles (tenant_id, name, type, permissions, active)
         values ($1, 'Spec Reception', 'agent', '["visitors.reception"]'::jsonb, true)
         returning id`,
        [TENANT_A],
      );
      const roleId = roleInsert.rows[0].id;

      // Step 1 — empty (NULL) location_scope. Must yield ZERO visible rows.
      await client.query(
        `insert into public.user_role_assignments (tenant_id, user_id, role_id, location_scope, active)
         values ($1, $2, $3, null, true)`,
        [TENANT_A, userId, roleId],
      );
      const beforeScope = await client.query(
        `select count(*)::int as n from public.visitor_visibility_ids($1, $2) where visitor_visibility_ids = $3`,
        [userId, TENANT_A, visitorId],
      );
      expect(beforeScope.rows[0].n).toBe(0);

      // Sanity check: '{}'::uuid[] (empty non-null array) must also yield 0.
      await client.query(
        `update public.user_role_assignments set location_scope='{}'::uuid[] where user_id=$1 and role_id=$2`,
        [userId, roleId],
      );
      const emptyArray = await client.query(
        `select count(*)::int as n from public.visitor_visibility_ids($1, $2) where visitor_visibility_ids = $3`,
        [userId, TENANT_A, visitorId],
      );
      expect(emptyArray.rows[0].n).toBe(0);

      // Step 2 — assign the building to the user's location_scope. Visitor
      // becomes visible via Tier 2.
      await client.query(
        `update public.user_role_assignments set location_scope=array[$1::uuid] where user_id=$2 and role_id=$3`,
        [buildingId, userId, roleId],
      );
      const afterScope = await client.query(
        `select count(*)::int as n from public.visitor_visibility_ids($1, $2) where visitor_visibility_ids = $3`,
        [userId, TENANT_A, visitorId],
      );
      expect(afterScope.rows[0].n).toBe(1);
    });
  });
});
