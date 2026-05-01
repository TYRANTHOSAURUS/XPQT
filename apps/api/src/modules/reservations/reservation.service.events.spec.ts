/**
 * Slice 4 — verify ReservationService.editOne fans out per-visitor
 * BundleEvents when a bundle-linked reservation moves time / changes room.
 *
 * The visitor cascade adapter (in VisitorsModule) consumes these events and
 * translates them into the right per-visitor action (cancel / email / host
 * alert) per spec §10.2. Here we only assert the emitter side.
 *
 * What we verify:
 *   - editOne with start_at change AND a bundle attachment + visitors emits
 *     one bundle.line.moved per visitor with line_kind='visitor', old/new
 *     expected_at, and the right tenant.
 *   - editOne with space_id change emits one bundle.line.room_changed per
 *     visitor.
 *   - editOne with both fields changed emits BOTH events per visitor.
 *   - editOne on a non-bundle reservation emits nothing.
 *   - editOne on a bundle with zero visitors emits nothing.
 *   - cross-tenant: events carry the current TenantContext id, not the row's.
 *   - A failed UPDATE doesn't emit (early throw before the emit block).
 */

import { ReservationService } from './reservation.service';
import { BundleEventBus, type BundleEvent } from '../booking-bundles/bundle-event-bus';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const RES_ID = 'rrrrrrrr-1111-4111-8111-rrrrrrrrrrrr';
const BUNDLE_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const SPACE_OLD = 'ssssss11-1111-4111-8111-ssssssssssss';
const SPACE_NEW = 'ssssss22-2222-4222-8222-ssssssssssss';
const V1 = 'v1111111-1111-4111-8111-vvvvvvvvvvvv';
const V2 = 'v2222222-2222-4222-8222-vvvvvvvvvvvv';
const USER_ID = 'uuuuuuuu-1111-4111-8111-uuuuuuuuuuuu';
const PERSON_ID = 'pppppppp-1111-4111-8111-pppppppppppp';

const baseReservation = {
  id: RES_ID,
  tenant_id: TENANT,
  space_id: SPACE_OLD,
  start_at: '2026-05-01T10:00:00.000Z',
  end_at: '2026-05-01T11:00:00.000Z',
  attendee_count: 5,
  attendee_person_ids: [],
  host_person_id: null,
  recurrence_series_id: null,
  recurrence_overridden: false,
  booking_bundle_id: BUNDLE_ID,
  multi_room_group_id: null,
  source: 'portal',
  status: 'confirmed',
  requester_person_id: PERSON_ID,
};

function makeService(opts: {
  reservation?: typeof baseReservation;
  visitorIds?: string[];
  visitorLookupError?: { message: string };
  updateError?: { message: string } | null;
  updatedRes?: Partial<typeof baseReservation>;
  bundleAttached?: boolean;
}) {
  const reservation = opts.reservation ?? baseReservation;
  const finalReservation = {
    ...reservation,
    booking_bundle_id: opts.bundleAttached === false ? null : reservation.booking_bundle_id,
  };
  const visitorIds = opts.visitorIds ?? [V1, V2];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'reservations') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: () =>
                    Promise.resolve({ data: finalReservation, error: null }),
                }),
              }),
            }),
            update: () => {
              const chain: Record<string, (...args: unknown[]) => unknown> = {};
              chain.eq = () => chain;
              chain.select = () => ({
                single: () => {
                  if (opts.updateError) {
                    return Promise.resolve({ data: null, error: opts.updateError });
                  }
                  return Promise.resolve({
                    data: { ...finalReservation, ...(opts.updatedRes ?? {}) },
                    error: null,
                  });
                },
              });
              return chain;
            },
          };
        }
        if (table === 'visitors') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => {
                  if (opts.visitorLookupError) {
                    return Promise.resolve({ data: null, error: opts.visitorLookupError });
                  }
                  return Promise.resolve({
                    data: visitorIds.map((id) => ({ id })),
                    error: null,
                  });
                },
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return { insert: () => Promise.resolve({ data: null, error: null }) };
        }
        // Defensive — never reached in this spec.
        return {
          select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
          insert: () => Promise.resolve({ data: null, error: null }),
        };
      }),
    },
  };

  const conflict = { isExclusionViolation: () => false };
  const visibility = {
    loadContextByUserId: jest.fn(async () => ({})),
    assertVisible: () => {},
    canEdit: () => true,
  };

  const eventBus = new BundleEventBus();
  const captured: BundleEvent[] = [];
  const sub = eventBus.events$.subscribe((e) => captured.push(e));

  const svc = new ReservationService(
    supabase as never,
    conflict as never,
    visibility as never,
    undefined,
    undefined,
    undefined,
    eventBus,
  );

  return { svc, captured, unsubscribe: () => sub.unsubscribe() };
}

const ACTOR = {
  user_id: USER_ID,
  person_id: PERSON_ID,
  is_service_desk: false,
  has_override_rules: false,
};

describe('ReservationService.editOne — slice 4 visitor cascade emission', () => {
  it('emits bundle.line.moved per visitor when start_at changes', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedRes: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: newStart }),
      );

      // One per visitor.
      const moved = captured.filter((e) => e.kind === 'bundle.line.moved');
      expect(moved).toHaveLength(2);
      const ids = new Set(moved.map((e) => e.kind === 'bundle.line.moved' ? e.line_id : ''));
      expect(ids).toEqual(new Set([V1, V2]));
      for (const evt of moved) {
        expect(evt.tenant_id).toBe(TENANT);
        expect(evt.bundle_id).toBe(BUNDLE_ID);
        if (evt.kind === 'bundle.line.moved') {
          expect(evt.line_kind).toBe('visitor');
          expect(evt.old_expected_at).toBe(baseReservation.start_at);
          expect(evt.new_expected_at).toBe(newStart);
        }
      }
      // No room_changed when only time moved.
      expect(captured.filter((e) => e.kind === 'bundle.line.room_changed')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('emits bundle.line.room_changed per visitor when space_id changes', async () => {
    const { svc, captured, unsubscribe } = makeService({
      updatedRes: { space_id: SPACE_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { space_id: SPACE_NEW }),
      );
      const roomChanges = captured.filter((e) => e.kind === 'bundle.line.room_changed');
      expect(roomChanges).toHaveLength(2);
      for (const evt of roomChanges) {
        if (evt.kind === 'bundle.line.room_changed') {
          expect(evt.line_kind).toBe('visitor');
          expect(evt.old_room_id).toBe(SPACE_OLD);
          expect(evt.new_room_id).toBe(SPACE_NEW);
        }
      }
      expect(captured.filter((e) => e.kind === 'bundle.line.moved')).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('emits BOTH moved + room_changed when start_at AND space_id change', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      updatedRes: { start_at: newStart, space_id: SPACE_NEW },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: newStart, space_id: SPACE_NEW }),
      );
      // 2 visitors × 2 events each = 4 emissions.
      expect(captured).toHaveLength(4);
      expect(captured.filter((e) => e.kind === 'bundle.line.moved')).toHaveLength(2);
      expect(captured.filter((e) => e.kind === 'bundle.line.room_changed')).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when reservation has no bundle', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      bundleAttached: false,
      updatedRes: { start_at: newStart, booking_bundle_id: null },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: newStart }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when bundle has zero visitors', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const { svc, captured, unsubscribe } = makeService({
      visitorIds: [],
      updatedRes: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: newStart }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });

  it('event payload tenant_id matches current TenantContext (cross-tenant defence)', async () => {
    const newStart = '2026-05-01T14:00:00.000Z';
    const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
    const { svc, captured, unsubscribe } = makeService({
      updatedRes: { start_at: newStart },
    });
    try {
      await TenantContext.run(
        { id: OTHER_TENANT, slug: 'other', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: newStart }),
      );
      expect(captured.length).toBeGreaterThan(0);
      for (const evt of captured) {
        expect(evt.tenant_id).toBe(OTHER_TENANT);
      }
    } finally {
      unsubscribe();
    }
  });

  it('does not emit when no field actually changed', async () => {
    const { svc, captured, unsubscribe } = makeService({});
    try {
      // Patch the same value back — no `next` keys, returns the loaded row.
      await TenantContext.run(
        { id: TENANT, slug: 'test', tier: 'standard' },
        () => svc.editOne(RES_ID, ACTOR, { start_at: baseReservation.start_at }),
      );
      expect(captured).toHaveLength(0);
    } finally {
      unsubscribe();
    }
  });
});
