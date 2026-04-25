import { BadRequestException } from '@nestjs/common';
import {
  EvaluationContext,
  PredicateEngineService,
} from './predicate-engine.service';

function makeCtx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    requester: {
      id: 'p1',
      role_ids: ['r-employee'],
      org_node_id: 'node-eng',
      type: 'employee',
      cost_center: 'CC-100',
      user_id: 'u1',
    },
    space: {
      id: 's1',
      type: 'meeting_room',
      parent_id: null,
      capacity: 10,
      min_attendees: null,
      default_calendar_id: 'cal-1',
      ancestor_ids: ['s1'],
    },
    booking: {
      start_at: '2026-05-01T14:00:00Z',
      end_at: '2026-05-01T15:00:00Z',
      duration_minutes: 60,
      lead_time_minutes: 60 * 24, // a day in advance
      attendee_count: 4,
    },
    permissions: {
      'rooms.override_rules': false,
      'rooms.book_on_behalf': false,
    },
    resolved: {
      org_descendants: {},
      in_business_hours: {},
    },
    ...overrides,
  };
}

describe('PredicateEngineService', () => {
  // We don't need the SupabaseService here since evaluate() is pure given a
  // hydrated context. Construct with a stub.
  const engine = new PredicateEngineService({} as never);

  describe('op evaluation', () => {
    it('eq + ne with literals and refs', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ op: 'eq', left: '$.requester.type', right: 'employee' }, ctx)).toBe(true);
      expect(engine.evaluate({ op: 'ne', left: '$.requester.type', right: 'vendor' }, ctx)).toBe(true);
      expect(engine.evaluate({ op: 'eq', left: '$.requester.type', right: 'vendor' }, ctx)).toBe(false);
    });

    it('in checks scalar membership in literal array', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ op: 'in', left: '$.requester.cost_center', right: ['CC-100', 'CC-200'] }, ctx)).toBe(true);
      expect(engine.evaluate({ op: 'in', left: '$.requester.cost_center', right: ['CC-300'] }, ctx)).toBe(false);
    });

    it('numeric and timestamp comparisons', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ op: 'gt', left: '$.booking.duration_minutes', right: 30 }, ctx)).toBe(true);
      expect(engine.evaluate({ op: 'lt', left: '$.booking.duration_minutes', right: 30 }, ctx)).toBe(false);
      expect(engine.evaluate({ op: 'gte', left: '$.booking.start_at', right: '2026-04-01T00:00:00Z' }, ctx)).toBe(true);
    });

    it('contains works on arrays and strings', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ op: 'contains', left: '$.requester.role_ids', right: 'r-employee' }, ctx)).toBe(true);
      expect(engine.evaluate({ op: 'contains', left: '$.requester.cost_center', right: 'CC' }, ctx)).toBe(true);
    });
  });

  describe('and / or / not', () => {
    it('and aggregates true for every child', () => {
      const ctx = makeCtx();
      expect(
        engine.evaluate(
          {
            and: [
              { op: 'eq', left: '$.requester.type', right: 'employee' },
              { op: 'gt', left: '$.booking.duration_minutes', right: 30 },
            ],
          },
          ctx,
        ),
      ).toBe(true);
    });

    it('or returns true if any child matches', () => {
      const ctx = makeCtx();
      expect(
        engine.evaluate(
          {
            or: [
              { op: 'eq', left: '$.requester.type', right: 'vendor' },
              { op: 'eq', left: '$.requester.type', right: 'employee' },
            ],
          },
          ctx,
        ),
      ).toBe(true);
    });

    it('not flips its child', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ not: { op: 'eq', left: '$.requester.type', right: 'employee' } }, ctx)).toBe(false);
    });
  });

  describe('fn evaluation', () => {
    it('duration_minutes_gt / lt', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ fn: 'duration_minutes_gt', args: ['$.booking.start_at', '$.booking.end_at', 30] }, ctx)).toBe(true);
      expect(engine.evaluate({ fn: 'duration_minutes_lt', args: ['$.booking.start_at', '$.booking.end_at', 30] }, ctx)).toBe(false);
    });

    it('lead_minutes_lt fires when start is closer than threshold', () => {
      const ctx = makeCtx({
        booking: {
          start_at: new Date(Date.now() + 5 * 60_000).toISOString(),
          end_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          duration_minutes: 25,
          lead_time_minutes: 5,
          attendee_count: 4,
        },
      });
      expect(engine.evaluate({ fn: 'lead_minutes_lt', args: ['$.booking.start_at', 30] }, ctx)).toBe(true);
      expect(engine.evaluate({ fn: 'lead_minutes_lt', args: ['$.booking.start_at', 1] }, ctx)).toBe(false);
    });

    it('has_permission reads the context permission map', () => {
      const ctx = makeCtx({
        permissions: { 'rooms.override_rules': true, 'rooms.book_on_behalf': false },
      });
      expect(engine.evaluate({ fn: 'has_permission', args: ['rooms.override_rules'] }, ctx)).toBe(true);
      expect(engine.evaluate({ fn: 'has_permission', args: ['rooms.book_on_behalf'] }, ctx)).toBe(false);
    });

    it('array_intersects detects shared element', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ fn: 'array_intersects', args: ['$.requester.role_ids', ['r-vp', 'r-employee']] }, ctx)).toBe(true);
      expect(engine.evaluate({ fn: 'array_intersects', args: ['$.requester.role_ids', ['r-vp']] }, ctx)).toBe(false);
    });

    it('attendees_over_capacity_factor', () => {
      const ctx = makeCtx({
        space: {
          id: 's1', type: 'meeting_room', parent_id: null, capacity: 10,
          min_attendees: null, default_calendar_id: null, ancestor_ids: ['s1'],
        },
        booking: {
          start_at: '2026-05-01T14:00:00Z',
          end_at: '2026-05-01T15:00:00Z',
          duration_minutes: 60,
          lead_time_minutes: 60,
          attendee_count: 13,
        },
      });
      // 13 > 10 * 1.2 (12) → true
      expect(engine.evaluate({ fn: 'attendees_over_capacity_factor', args: ['$.booking.attendee_count', '$.space.capacity', 1.2] }, ctx)).toBe(true);
      // 13 > 10 * 1.5 (15) → false
      expect(engine.evaluate({ fn: 'attendees_over_capacity_factor', args: ['$.booking.attendee_count', '$.space.capacity', 1.5] }, ctx)).toBe(false);
    });

    it('attendees_below_min skips when min is null', () => {
      const ctx = makeCtx();
      expect(engine.evaluate({ fn: 'attendees_below_min', args: ['$.booking.attendee_count', '$.space.min_attendees'] }, ctx)).toBe(false);
    });

    it('attendees_below_min fires when below threshold', () => {
      const ctx = makeCtx({
        space: {
          id: 's1', type: 'meeting_room', parent_id: null, capacity: 10,
          min_attendees: 6, default_calendar_id: null, ancestor_ids: ['s1'],
        },
        booking: {
          start_at: '2026-05-01T14:00:00Z',
          end_at: '2026-05-01T15:00:00Z',
          duration_minutes: 60,
          lead_time_minutes: 60,
          attendee_count: 4,
        },
      });
      expect(engine.evaluate({ fn: 'attendees_below_min', args: ['$.booking.attendee_count', '$.space.min_attendees'] }, ctx)).toBe(true);
    });
  });

  describe('validate', () => {
    it('rejects unknown op', () => {
      expect(() => engine.validate({ op: 'wat', left: 1, right: 2 })).toThrow(BadRequestException);
    });
    it('rejects unknown fn', () => {
      expect(() => engine.validate({ fn: 'made_up', args: [] })).toThrow(BadRequestException);
    });
    it('accepts a complex valid predicate', () => {
      expect(() =>
        engine.validate({
          and: [
            { op: 'eq', left: '$.requester.type', right: 'employee' },
            { fn: 'has_permission', args: ['rooms.override_rules'] },
          ],
        }),
      ).not.toThrow();
    });
    it('rejects too-deep nesting', () => {
      let nest: unknown = { op: 'eq', left: 1, right: 1 };
      for (let i = 0; i < 12; i += 1) nest = { not: nest };
      expect(() => engine.validate(nest)).toThrow(BadRequestException);
    });
  });
});
