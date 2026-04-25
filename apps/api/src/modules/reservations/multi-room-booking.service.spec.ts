import { ConflictException } from '@nestjs/common';
import { MultiRoomBookingService } from './multi-room-booking.service';
import { TenantContext } from '../../common/tenant-context';
import type { ActorContext, Reservation } from './dto/types';

describe('MultiRoomBookingService.createGroup', () => {
  const TENANT = { id: 'T', slug: 't', tier: 'standard' as const };

  function makeReservation(id: string, spaceId: string): Reservation {
    return {
      id,
      tenant_id: TENANT.id,
      space_id: spaceId,
      reservation_type: 'room',
      requester_person_id: 'P',
      host_person_id: null,
      start_at: '2026-05-01T09:00:00Z',
      end_at: '2026-05-01T10:00:00Z',
      attendee_count: 4,
      attendee_person_ids: [],
      status: 'confirmed',
      recurrence_rule: null,
      recurrence_series_id: null,
      recurrence_master_id: null,
      recurrence_index: null,
      recurrence_overridden: false,
      recurrence_skipped: false,
      linked_order_id: null,
      approval_id: null,
      setup_buffer_minutes: 0,
      teardown_buffer_minutes: 0,
      effective_start_at: '2026-05-01T09:00:00Z',
      effective_end_at: '2026-05-01T10:00:00Z',
      check_in_required: false,
      check_in_grace_minutes: 15,
      checked_in_at: null,
      released_at: null,
      cancellation_grace_until: null,
      policy_snapshot: {},
      applied_rule_ids: [],
      source: 'portal',
      booked_by_user_id: 'U',
      cost_amount_snapshot: null,
      multi_room_group_id: null,
      calendar_event_id: null,
      calendar_provider: null,
      calendar_etag: null,
      calendar_last_synced_at: null,
      booking_bundle_id: null,
      created_at: '2026-05-01T09:00:00Z',
      updated_at: '2026-05-01T09:00:00Z',
    };
  }

  function makeSupabase(): {
    inserted: unknown[]; updated: unknown[]; deleted: unknown[];
    admin: any;
  } {
    const inserted: unknown[] = [];
    const updated: unknown[] = [];
    const deleted: unknown[] = [];

    const admin = {
      from: (table: string) => {
        if (table === 'multi_room_groups') {
          return {
            insert: (row: unknown) => {
              inserted.push({ table, row });
              return {
                select: () => ({
                  single: () => Promise.resolve({ data: { id: 'GROUP-1' }, error: null }),
                }),
              };
            },
            update: (_row: unknown) => ({
              eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            }),
            delete: () => ({
              eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }),
            }),
          };
        }
        if (table === 'reservations') {
          return {
            update: (_row: unknown) => ({
              eq: () => ({
                eq: () => ({
                  eq: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          };
        }
        return {};
      },
    };
    return { inserted, updated, deleted, admin };
  }

  function makeActor(): ActorContext {
    return {
      user_id: 'U',
      person_id: 'P',
      is_service_desk: false,
      has_override_rules: false,
    };
  }

  it('creates one reservation per space and points the group at the first', async () => {
    const supabase = makeSupabase();
    const bookingFlow = {
      create: jest.fn(async (input: any) =>
        makeReservation(`R-${input.space_id}`, input.space_id),
      ),
    };
    const svc = new MultiRoomBookingService(supabase as never, bookingFlow as never);

    const result = await TenantContext.run(TENANT, () =>
      svc.createGroup(
        {
          space_ids: ['S1', 'S2', 'S3'],
          requester_person_id: 'P',
          start_at: '2026-05-01T09:00:00Z',
          end_at: '2026-05-01T10:00:00Z',
          attendee_count: 4,
        },
        makeActor(),
      ),
    );

    expect(result.group_id).toBe('GROUP-1');
    expect(result.reservations).toHaveLength(3);
    expect(bookingFlow.create).toHaveBeenCalledTimes(3);
  });

  it('rejects single-room input', async () => {
    const supabase = makeSupabase();
    const svc = new MultiRoomBookingService(supabase as never, {} as never);
    await expect(
      TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
          },
          makeActor(),
        ),
      ),
    ).rejects.toThrow(/multi_room_requires_two|at least two/);
  });

  it('rolls back created rows on per-room failure (atomicity)', async () => {
    const supabase = makeSupabase();
    let calls = 0;
    const bookingFlow = {
      create: jest.fn(async (input: any) => {
        calls += 1;
        if (calls === 2) {
          throw new ConflictException({
            code: 'reservation_slot_conflict',
            message: 'Just booked',
          });
        }
        return makeReservation(`R-${input.space_id}`, input.space_id);
      }),
    };
    const svc = new MultiRoomBookingService(supabase as never, bookingFlow as never);

    await expect(
      TenantContext.run(TENANT, () =>
        svc.createGroup(
          {
            space_ids: ['S1', 'S2', 'S3'],
            requester_person_id: 'P',
            start_at: '2026-05-01T09:00:00Z',
            end_at: '2026-05-01T10:00:00Z',
          },
          makeActor(),
        ),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'multi_room_booking_failed',
        rolled_back_count: 1,
      },
    });
  });
});
