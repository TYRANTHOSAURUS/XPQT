// Plan A.2 / Commit 3 + 6 regression spec — reservation.editOne FK tenant validation.
//
// Before Commit 3, editOne wrote host_person_id (booking-meta) and
// attendee_person_ids (slot-meta) straight from the patch into UPDATEs
// without proving each uuid belonged to the caller's tenant. The bookings
// FK on host_person_id → persons(id) and the slot FK on
// attendee_person_ids → persons(id)[] only prove existence globally;
// supabase.admin bypasses RLS. Cross-tenant id smuggling was possible.
//
// Commit 6 also adds a TS-layer pre-flight on space_id BEFORE delegating
// to the editSlot RPC. This spec asserts the pre-flight rejects with
// reference.not_in_tenant BEFORE the RPC fires.

import { BadRequestException } from '@nestjs/common';
import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext } from './dto/types';

const TENANT = { id: 't1', slug: 't', tier: 'standard' as const };
const BOOKING_ID = 'B-1';
const VALID_PERSON_A = '00000000-0000-4000-8000-00000000aaaa';
const VALID_PERSON_B = '00000000-0000-4000-8000-00000000bbbb';
const VALID_SPACE = '00000000-0000-4000-8000-00000000ccc1';
const FOREIGN = '00000000-0000-4000-8000-0000000fffff';

function makeActor(): ActorContext {
  return {
    user_id: 'U',
    person_id: 'P',
    is_service_desk: false,
    has_override_rules: false,
  };
}

type Row = Record<string, unknown>;
type RowsByTable = Record<string, Row[]>;

/**
 * Hand-rolled supabase.admin mock. Supports:
 *   - select().eq().eq().maybeSingle() (assertTenantOwned)
 *   - select().eq().in() (assertTenantOwnedAll, terminal await)
 *   - findByIdOrThrow paths that read bookings + booking_slots
 *   - rpc('edit_booking_slot', ...) — captured but not invoked (we test
 *     pre-flights that should reject BEFORE reaching the RPC).
 */
function makeSupabase(rowsByTable: RowsByTable, opts: { booking?: Row | null; primarySlot?: Row | null } = {}) {
  const captures: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];

  function buildSelectChain(table: string) {
    const filters: Record<string, unknown> = {};
    const rows = rowsByTable[table] ?? [];
    const chain: Record<string, unknown> = {
      eq: (col: string, val: unknown) => {
        filters[col] = val;
        return chain;
      },
      in: (col: string, val: string[]) => {
        filters[`__in_${col}`] = val;
        return chain;
      },
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => {
        captures.push({ table, filters: { ...filters } });
        if (table === 'bookings') return { data: opts.booking ?? null, error: null };
        if (table === 'booking_slots') return { data: opts.primarySlot ?? null, error: null };
        const match = rows.find((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          return true;
        });
        return { data: match ?? null, error: null };
      },
      single: async () => {
        captures.push({ table, filters: { ...filters } });
        return { data: rows[0] ?? null, error: null };
      },
      then: (onFulfilled: (v: { data: Array<Row>; error: null }) => unknown) => {
        captures.push({ table, filters: { ...filters } });
        const inIds = filters[`__in_id`] as string[] | undefined;
        const matches = rows.filter((r) => {
          for (const [col, val] of Object.entries(filters)) {
            if (col.startsWith('__in_')) continue;
            if (r[col] !== val) return false;
          }
          if (inIds && !inIds.includes(r.id as string)) return false;
          return true;
        });
        return Promise.resolve({ data: matches.map((r) => ({ id: r.id })), error: null }).then(onFulfilled);
      },
    };
    return chain;
  }

  const supabase = {
    admin: {
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => ({
        select: () => buildSelectChain(table),
        update: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: null, error: null }),
          }),
        }),
        insert: () => Promise.resolve({ data: null, error: null }),
      }),
    },
  };
  return { supabase, captures, rpcCalls };
}

function makeVisibility(canEdit = true) {
  return {
    loadContextByUserId: jest.fn().mockResolvedValue({
      user_id: 'U',
      person_id: 'P',
      tenant_id: TENANT.id,
      has_read_all: false,
      has_write_all: true,
      has_admin: false,
    }),
    assertVisible: jest.fn().mockReturnValue(undefined),
    canEdit: jest.fn().mockReturnValue(canEdit),
  };
}

function makeService(supabase: ReturnType<typeof makeSupabase>, visibility = makeVisibility()) {
  const conflict = {
    isExclusionViolation: jest.fn(() => false),
  };
  return new ReservationService(
    supabase.supabase as never,
    conflict as never,
    visibility as never,
  );
}

function makeBookingFixture(): Row {
  return {
    id: BOOKING_ID,
    tenant_id: TENANT.id,
    title: null,
    description: null,
    requester_person_id: 'P',
    host_person_id: null,
    booked_by_user_id: 'U',
    location_id: VALID_SPACE,
    start_at: '2026-05-01T09:00:00Z',
    end_at: '2026-05-01T10:00:00Z',
    timezone: 'UTC',
    status: 'confirmed',
    source: 'desk',
    cost_center_id: null,
    cost_amount_snapshot: null,
    policy_snapshot: { matched_rule_ids: [], effects_seen: [] },
    applied_rule_ids: [],
    config_release_id: null,
    calendar_event_id: null,
    calendar_provider: null,
    calendar_etag: null,
    calendar_last_synced_at: null,
    recurrence_series_id: null,
    recurrence_index: null,
    recurrence_overridden: false,
    recurrence_skipped: false,
    template_id: null,
    created_at: '2026-05-01T08:00:00Z',
    updated_at: '2026-05-01T08:00:00Z',
  };
}

describe('ReservationService.editOne — Plan A.2 tenant validation', () => {
  beforeEach(() => {
    // findByIdOrThrow needs a stub that returns a Reservation; we mock by
    // overriding the prototype with a synthesized projection.
    jest
      .spyOn(ReservationService.prototype as unknown as { findByIdOrThrow: (...a: unknown[]) => unknown }, 'findByIdOrThrow')
      .mockResolvedValue({
        id: BOOKING_ID,
        slot_id: null,
        tenant_id: TENANT.id,
        space_id: VALID_SPACE,
        start_at: '2026-05-01T09:00:00Z',
        end_at: '2026-05-01T10:00:00Z',
        host_person_id: null,
        attendee_count: 4,
        attendee_person_ids: [],
        status: 'confirmed',
        recurrence_series_id: null,
      } as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects edit with a cross-tenant host_person_id (Commit 3)', async () => {
    const supabase = makeSupabase({
      persons: [{ id: FOREIGN, tenant_id: 'other-tenant' }],
    });
    const svc = makeService(supabase);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editOne(BOOKING_ID, makeActor(), { host_person_id: FOREIGN }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'persons',
      reference_id: FOREIGN,
    });
    // RPC must NOT have fired — pre-flight rejected first.
    expect(supabase.rpcCalls).toEqual([]);
  });

  it('rejects edit with a cross-tenant attendee_person_ids entry (Commit 3)', async () => {
    const supabase = makeSupabase({
      persons: [
        { id: VALID_PERSON_A, tenant_id: TENANT.id },
        // VALID_PERSON_B intentionally NOT registered for tenant t1.
      ],
    });
    const svc = makeService(supabase);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editOne(BOOKING_ID, makeActor(), {
          attendee_person_ids: [VALID_PERSON_A, VALID_PERSON_B],
        }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'persons',
      missing_ids: [VALID_PERSON_B],
    });
    expect(supabase.rpcCalls).toEqual([]);
  });

  it('rejects edit with a cross-tenant space_id BEFORE the editSlot RPC fires (Commit 6)', async () => {
    // No spaces row for FOREIGN under tenant t1 → assertTenantOwned rejects.
    const supabase = makeSupabase({
      spaces: [{ id: VALID_SPACE, tenant_id: TENANT.id, active: true, reservable: true }],
    });
    const svc = makeService(supabase);

    let caught: unknown = null;
    try {
      await TenantContext.run(TENANT, () =>
        svc.editOne(BOOKING_ID, makeActor(), { space_id: FOREIGN }),
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect((caught as BadRequestException).getResponse()).toMatchObject({
      code: 'reference.not_in_tenant',
      reference_table: 'spaces',
      reference_id: FOREIGN,
    });
    // Defense-in-depth — pre-flight rejected BEFORE the atomic RPC.
    expect(supabase.rpcCalls).toEqual([]);
  });
});
