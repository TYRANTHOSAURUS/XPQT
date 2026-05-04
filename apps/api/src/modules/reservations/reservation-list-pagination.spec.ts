import { ReservationService } from './reservation.service';
import { TenantContext } from '../../common/tenant-context';

// Phase 1.2 — Bug #4: pagination cursor identity.
//
// `listMine` orders by `(start_at, booking_slots.id)` and filters with
// `id.gt.<cursor>` against the SQL `id` column (= booking_slots.id) on the
// `booking_slots` table. The pre-fix cursor encoded `start_at__booking.id`
// (the projected row's `id`, which under canonicalisation equals
// `booking.id`). When two slots in a multi-room booking share an exact
// `start_at`, the cursor's booking-id was being compared against
// booking_slots.id values — type/domain mismatch — and the next page
// either skipped or duplicated rows.
//
// The fix encodes `start_at__slot.id` (= projected `slot_id`) and decodes
// the slot id, matching the ORDER BY column. This spec exercises that
// fix with a multi-room booking whose three slots all share an identical
// `start_at` (the worst case for the tie-break path).
//
// Test shape: paginate over 3 sibling slots with `limit: 2`. Page 1
// returns 2; page 2 returns the 3rd. The 3 slot_ids across both pages
// must form a deduplicated set of size 3 — no skips, no duplicates.

describe('ReservationService.listMine — cursor identity (Phase 1.2)', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };
  const BOOKING_ID = 'B-multi';
  const SLOT_A = '11111111-1111-1111-1111-111111111111';
  const SLOT_B = '22222222-2222-2222-2222-222222222222';
  const SLOT_C = '33333333-3333-3333-3333-333333333333';
  // Identical start_at across all 3 slots so the tie-break branch of the
  // cursor runs (`and(start_at.eq.<cursor>, id.gt.<cursor>)`).
  const SHARED_START = '2026-06-01T09:00:00Z';
  const SHARED_END = '2026-06-01T10:00:00Z';

  function makeSlotRow(slotId: string) {
    return {
      id: slotId,
      tenant_id: TENANT.id,
      booking_id: BOOKING_ID,
      slot_type: 'room' as const,
      space_id: `space-${slotId}`,
      start_at: SHARED_START,
      end_at: SHARED_END,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: SHARED_START,
      effective_end_at: SHARED_END,
      attendee_count: 0,
      attendee_person_ids: [],
      status: 'confirmed',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      display_order: 0,
      created_at: '2026-05-01T08:00:00Z',
      updated_at: '2026-05-01T08:00:00Z',
      bookings: {
        id: BOOKING_ID,
        tenant_id: TENANT.id,
        title: null,
        description: null,
        requester_person_id: 'P',
        host_person_id: null,
        booked_by_user_id: 'U',
        location_id: `space-${slotId}`,
        start_at: SHARED_START,
        end_at: SHARED_END,
        timezone: 'UTC',
        status: 'confirmed',
        source: 'portal',
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
      },
      space: { id: `space-${slotId}`, name: `Room ${slotId.slice(0, 1).toUpperCase()}`, type: 'room' },
    };
  }

  // All 3 slots in the canonical (start_at, id) order. ID strings sort
  // lexically; because we use UUID-shaped ids whose first hex digit
  // increments (1.., 2.., 3..), the order is A < B < C.
  const ALL_SLOTS = [makeSlotRow(SLOT_A), makeSlotRow(SLOT_B), makeSlotRow(SLOT_C)];

  /**
   * Mock SupabaseService.admin. listMine builds:
   *   from('booking_slots')
   *     .select(...)
   *     .eq('tenant_id', T)
   *     .order('start_at', {...})
   *     .order('id', {...})
   *     .limit(limit+1)
   *     .eq('bookings.requester_person_id', P)        ← (when ctx.person_id)
   *     .gte/.lt/.not('status', 'in', '(...)')        ← (scope)
   *     .or('start_at.gt.X,and(start_at.eq.X,id.gt.Y)')  ← (cursor)
   *
   * The chain is awaited as `{ data, error }`. We simulate it as a
   * thenable that runs the cursor filter against ALL_SLOTS at await time.
   *
   * The .or() call on real PostgREST returns the chain (not a thenable
   * itself) — the chain is awaited at the END of the listMine method
   * (`const { data, error } = await q`). Our mock matches that: every
   * builder method returns the chain, and the chain is the thenable.
   */
  function makeSupabase() {
    let cursorFilter: { startEq: string; idGt: string } | null = null;
    let appliedLimit = ALL_SLOTS.length + 1;
    const calls = {
      orFilters: [] as string[],
    };

    const chain: any = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: (n: number) => {
        appliedLimit = n;
        return chain;
      },
      gte: () => chain,
      lt: () => chain,
      not: () => chain,
      in: () => chain,
      or: (clause: string) => {
        calls.orFilters.push(clause);
        // Parse the canonical cursor clause:
        //   start_at.gt.<X>,and(start_at.eq.<X>,id.gt.<Y>)
        // We only support that exact shape — anything else fails the test.
        const m = clause.match(
          /^start_at\.gt\.([^,]+),and\(start_at\.eq\.([^,]+),id\.gt\.([^)]+)\)$/,
        );
        if (!m) {
          throw new Error(`unexpected cursor or-clause shape: ${clause}`);
        }
        const [, startGt, startEq, idGt] = m;
        if (startGt !== startEq) {
          throw new Error(
            `cursor halves disagree on start_at: ${startGt} vs ${startEq}`,
          );
        }
        cursorFilter = { startEq, idGt };
        return chain;
      },
      then: (resolve: (v: unknown) => unknown) => {
        // Apply cursor filter against ALL_SLOTS. The real query orders
        // ascending on (start_at, id); when a cursor is set, it should
        // include only rows whose id sorts strictly above the cursor at
        // the same start_at (or strictly above the cursor's start_at).
        const filtered = cursorFilter
          ? ALL_SLOTS.filter((r) => {
              if (r.start_at > cursorFilter!.startEq) return true;
              if (r.start_at === cursorFilter!.startEq && r.id > cursorFilter!.idGt) return true;
              return false;
            })
          : ALL_SLOTS;
        const sliced = filtered.slice(0, appliedLimit);
        return Promise.resolve({ data: sliced, error: null }).then(resolve);
      },
    };

    const admin = {
      from: (_table: string) => chain,
      // Not used by listMine, but the visibility lookup pass needs it.
      // ReservationVisibilityService.loadContext does
      // `.from('users').select(...).eq().eq().maybeSingle()`. We mock
      // the visibility service directly below so this `from` is the
      // only entry point listMine touches.
    };

    return { admin, calls };
  }

  function makeVisibility() {
    return {
      loadContext: jest.fn(async () => ({
        user_id: 'U',
        person_id: 'P',
        tenant_id: TENANT.id,
        has_read_all: false,
        has_write_all: false,
        has_admin: false,
      })),
      // Not called by listMine.
      assertVisible: jest.fn(),
      canEdit: jest.fn(() => false),
      assertOperatorOrAdmin: jest.fn(),
    };
  }

  function makeConflictGuard() {
    return { isExclusionViolation: jest.fn(() => false) };
  }

  function buildService() {
    const supabase = makeSupabase();
    const visibility = makeVisibility();
    const conflict = makeConflictGuard();
    const svc = new ReservationService(
      supabase as never,
      conflict as never,
      visibility as never,
    );
    return { svc, supabase };
  }

  it('paginates 3 same-start_at sibling slots with limit=2 — no skips, no duplicates', async () => {
    const { svc } = buildService();

    const page1 = await TenantContext.run(TENANT, () =>
      svc.listMine('auth-uid', { scope: 'upcoming', limit: 2 }),
    );

    expect(page1.items).toHaveLength(2);
    expect(page1.next_cursor).toBeDefined();

    const page2 = await TenantContext.run(TENANT, () =>
      svc.listMine('auth-uid', {
        scope: 'upcoming',
        limit: 2,
        cursor: page1.next_cursor,
      }),
    );

    expect(page2.items).toHaveLength(1);
    expect(page2.next_cursor).toBeUndefined();

    // The deduplicated set of slot_ids across both pages must be exactly
    // the 3 sibling slots. This is the integrity invariant the bug
    // violated: with cursor=booking.id (constant across all 3 rows),
    // page 2 either re-emitted page-1 rows (duplicate) or skipped them.
    const seenSlotIds = new Set<string>([
      ...page1.items.map((r) => r.slot_id),
      ...page2.items.map((r) => r.slot_id),
    ]);
    expect(seenSlotIds.size).toBe(3);
    expect(seenSlotIds.has(SLOT_A)).toBe(true);
    expect(seenSlotIds.has(SLOT_B)).toBe(true);
    expect(seenSlotIds.has(SLOT_C)).toBe(true);

    // Booking-id is shared across all three rows — confirms the
    // multi-room-booking shape the bug arose from.
    expect(page1.items[0].booking_id).toBe(BOOKING_ID);
    expect(page1.items[1].booking_id).toBe(BOOKING_ID);
    expect(page2.items[0].booking_id).toBe(BOOKING_ID);
  });

  it('encodes the cursor as start_at__slot.id (the SQL ORDER BY column)', async () => {
    const { svc } = buildService();

    const page1 = await TenantContext.run(TENANT, () =>
      svc.listMine('auth-uid', { scope: 'upcoming', limit: 2 }),
    );

    // The boundary row of page 1 is SLOT_B (sorted (A, B, C) ascending).
    // The cursor's id half MUST be SLOT_B (slot id), not BOOKING_ID
    // (booking id), because the SQL ORDER BY column is booking_slots.id.
    const cursor = page1.next_cursor!;
    const sep = cursor.lastIndexOf('__');
    const cursorStart = cursor.slice(0, sep);
    const cursorId = cursor.slice(sep + 2);
    expect(cursorStart).toBe(SHARED_START);
    expect(cursorId).toBe(SLOT_B);
    expect(cursorId).not.toBe(BOOKING_ID);
  });
});
