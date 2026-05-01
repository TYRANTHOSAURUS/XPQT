/**
 * HostNotificationService — fan-out + acknowledge unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §9
 *
 * The service touches three collaborators:
 *   - SupabaseService — visitor + visitor_hosts lookups, visitor_hosts updates.
 *   - NotificationService — email + in-app inbox writes.
 *   - VisitorEventBus — SSE emission for browser Notification API.
 *
 * Each is mocked at the public interface boundary. We also exercise the
 * tenant-scoping guards (cross-tenant ack rejected, cross-tenant visitor
 * reads return not-found-shaped 404).
 */

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { HostNotificationService } from './host-notification.service';
import { TenantContext } from '../../common/tenant-context';
import { VisitorEventBus, type HostNotificationEvent } from './visitor-event-bus';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const VISITOR_ID = '22222222-2222-4222-8222-222222222222';
const PRIMARY_HOST = '33333333-3333-4333-8333-333333333333';
const COHOST_A = '44444444-4444-4444-8444-444444444444';
const COHOST_B = '55555555-5555-4555-8555-555555555555';

interface VisitorHostsRow {
  id: string;
  visitor_id: string;
  person_id: string;
  tenant_id: string;
  notified_at: string | null;
  acknowledged_at: string | null;
}

interface HarnessOpts {
  visitor?: { tenant_id: string; first_name?: string; company?: string } | null;
  hosts?: VisitorHostsRow[];
}

function makeHarness(opts: HarnessOpts = {}) {
  const visitor = opts.visitor === null
    ? null
    : {
        id: VISITOR_ID,
        tenant_id: TENANT_ID,
        primary_host_person_id: PRIMARY_HOST,
        first_name: 'Marleen',
        last_name: 'Visser',
        company: 'ABC Bank',
        building_id: 'building',
        expected_at: '2026-05-01T09:00:00Z',
        ...opts.visitor,
      };
  const hosts: VisitorHostsRow[] =
    opts.hosts ??
    [
      { id: 'h1', visitor_id: VISITOR_ID, person_id: PRIMARY_HOST, tenant_id: TENANT_ID, notified_at: null, acknowledged_at: null },
      { id: 'h2', visitor_id: VISITOR_ID, person_id: COHOST_A, tenant_id: TENANT_ID, notified_at: null, acknowledged_at: null },
      { id: 'h3', visitor_id: VISITOR_ID, person_id: COHOST_B, tenant_id: TENANT_ID, notified_at: null, acknowledged_at: null },
    ];

  const auditInserts: Array<{ event_type: string; details: Record<string, unknown> }> = [];
  const visitorHostUpdates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const supabase = {
    admin: {
      from: jest.fn((table: string) => {
        if (table === 'visitors') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: visitor, error: null }),
              }),
            }),
          };
        }
        if (table === 'visitor_hosts') {
          return {
            select: () => ({
              eq: (col: string, val: string) => ({
                eq: (col2?: string, val2?: string) => ({
                  // Two-arg .eq twice path → returns rows for visitor+tenant.
                  // Three-arg path: visitor + person + tenant → maybeSingle.
                  eq: (col3?: string, val3?: string) => ({
                    maybeSingle: async () => {
                      const personFilter =
                        col === 'person_id' ? val :
                        col2 === 'person_id' ? val2 :
                        col3 === 'person_id' ? val3 : null;
                      const tenantFilter =
                        col === 'tenant_id' ? val :
                        col2 === 'tenant_id' ? val2 :
                        col3 === 'tenant_id' ? val3 : null;
                      const visitorFilter =
                        col === 'visitor_id' ? val :
                        col2 === 'visitor_id' ? val2 :
                        col3 === 'visitor_id' ? val3 : null;
                      const found = hosts.find(
                        (h) =>
                          (!personFilter || h.person_id === personFilter) &&
                          (!visitorFilter || h.visitor_id === visitorFilter) &&
                          (!tenantFilter || h.tenant_id === tenantFilter),
                      );
                      return { data: found ?? null, error: null };
                    },
                  }),
                  // Two-arg .eq.eq → terminal as a list of rows.
                  then: (resolve: (r: { data: VisitorHostsRow[]; error: null }) => unknown) => {
                    const visitorFilter = col === 'visitor_id' ? val : col2 === 'visitor_id' ? val2 : null;
                    const tenantFilter = col === 'tenant_id' ? val : col2 === 'tenant_id' ? val2 : null;
                    const filtered = hosts.filter(
                      (h) =>
                        (!visitorFilter || h.visitor_id === visitorFilter) &&
                        (!tenantFilter || h.tenant_id === tenantFilter),
                    );
                    return resolve({ data: filtered, error: null });
                  },
                }),
              }),
            }),
            update: (patch: Record<string, unknown>) => ({
              eq: (col1: string, val1: string) => ({
                eq: async (col2: string, val2: string) => {
                  // .update().eq('id', X).eq('tenant_id', Y) → single row patch.
                  const id = col1 === 'id' ? val1 : col2 === 'id' ? val2 : null;
                  if (id) {
                    visitorHostUpdates.push({ id, patch });
                    const idx = hosts.findIndex((h) => h.id === id);
                    if (idx >= 0) {
                      hosts[idx] = { ...hosts[idx], ...(patch as Partial<VisitorHostsRow>) };
                    }
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        if (table === 'audit_events') {
          return {
            insert: async (row: Record<string, unknown>) => {
              auditInserts.push({
                event_type: row.event_type as string,
                details: row.details as Record<string, unknown>,
              });
              return { data: row, error: null };
            },
          };
        }
        // pendingHostsForVisitor uses a fkey-joined select; a separate fake.
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                then: (resolve: (r: { data: unknown[]; error: null }) => unknown) =>
                  resolve({ data: [], error: null }),
              }),
            }),
          }),
        };
      }),
    },
  };

  const sentNotifications: Array<Record<string, unknown>> = [];
  const notifications = {
    send: jest.fn(async (dto: Record<string, unknown>) => {
      sentNotifications.push(dto);
      return [];
    }),
  };

  const eventBus = new VisitorEventBus();
  const captured: HostNotificationEvent[] = [];
  const sub = eventBus.events$.subscribe((e) => captured.push(e));

  jest.spyOn(TenantContext, 'current').mockReturnValue({ id: TENANT_ID } as never);

  const svc = new HostNotificationService(
    supabase as never,
    notifications as never,
    eventBus,
  );

  return {
    svc,
    notifications,
    sentNotifications,
    eventBus,
    capturedEvents: captured,
    auditInserts,
    visitorHostUpdates,
    hosts,
    cleanup: () => sub.unsubscribe(),
  };
}

describe('HostNotificationService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('notifyArrival', () => {
    it('fans out to all hosts (primary + co-hosts)', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID);

        // 3 hosts → 3 NotificationService.send() calls
        expect(ctx.notifications.send).toHaveBeenCalledTimes(3);
        // ... each one targeting a distinct host
        const recipients = ctx.sentNotifications.map((n) => n.recipient_person_id);
        expect(recipients).toEqual(expect.arrayContaining([PRIMARY_HOST, COHOST_A, COHOST_B]));
      } finally {
        ctx.cleanup();
      }
    });

    it('records notified_at on each visitor_hosts row', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID);
        expect(ctx.visitorHostUpdates).toHaveLength(3);
        for (const u of ctx.visitorHostUpdates) {
          expect(u.patch.notified_at).toBeTruthy();
        }
      } finally {
        ctx.cleanup();
      }
    });

    it('emits SSE events on the bus per host', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID);
        const arrivalEvents = ctx.capturedEvents.filter((e) => e.kind === 'visitor.arrived');
        expect(arrivalEvents).toHaveLength(3);
        const targets = arrivalEvents.map((e) => e.host_person_id);
        expect(targets).toEqual(expect.arrayContaining([PRIMARY_HOST, COHOST_A, COHOST_B]));
      } finally {
        ctx.cleanup();
      }
    });

    it('queues email + in_app channels via NotificationService', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID);
        for (const send of ctx.sentNotifications) {
          expect(send.channels).toEqual(['email', 'in_app']);
          expect(send.notification_type).toBe('visitor.host_notify');
          expect(send.related_entity_type).toBe('visitor');
          expect(send.related_entity_id).toBe(VISITOR_ID);
        }
      } finally {
        ctx.cleanup();
      }
    });

    it('emits per-host audit event', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID);
        const audited = ctx.auditInserts.filter((a) => a.event_type === 'visitor.host_notified');
        expect(audited).toHaveLength(3);
      } finally {
        ctx.cleanup();
      }
    });

    it('rejects mismatched tenant context', async () => {
      const ctx = makeHarness();
      try {
        await expect(
          ctx.svc.notifyArrival(VISITOR_ID, OTHER_TENANT_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        ctx.cleanup();
      }
    });

    it('throws NotFoundException when visitor is in a different tenant', async () => {
      const ctx = makeHarness({
        visitor: { tenant_id: OTHER_TENANT_ID } as never,
      });
      try {
        await expect(ctx.svc.notifyArrival(VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
          NotFoundException,
        );
      } finally {
        ctx.cleanup();
      }
    });
  });

  describe('acknowledge', () => {
    it('records acknowledged_at on the host row', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID);
        const update = ctx.visitorHostUpdates.find((u) => u.id === 'h2');
        expect(update?.patch.acknowledged_at).toBeTruthy();
      } finally {
        ctx.cleanup();
      }
    });

    it('subsequent ack from another host is also recorded', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID);
        await ctx.svc.acknowledge(VISITOR_ID, PRIMARY_HOST, TENANT_ID);

        const ackUpdates = ctx.visitorHostUpdates.filter(
          (u) => u.patch.acknowledged_at !== undefined,
        );
        expect(ackUpdates).toHaveLength(2);
      } finally {
        ctx.cleanup();
      }
    });

    it('does not change the first acknowledger when re-called by the same host (idempotent)', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID);
        // mutate hosts so the row now has a populated ack
        const before = ctx.visitorHostUpdates.length;
        await ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID);
        // No new update issued (idempotent).
        expect(ctx.visitorHostUpdates.length).toBe(before);
      } finally {
        ctx.cleanup();
      }
    });

    it('emits SSE event to peer hosts about the acknowledgment', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID);
        const events = ctx.capturedEvents.filter(
          (e) => e.kind === 'visitor.acknowledged_by_other_host',
        );
        // 2 peers (primary + cohost_b), not the acknowledger themselves.
        expect(events).toHaveLength(2);
        const targets = events.map((e) => e.host_person_id);
        expect(targets).toEqual(expect.arrayContaining([PRIMARY_HOST, COHOST_B]));
        expect(targets).not.toContain(COHOST_A);
      } finally {
        ctx.cleanup();
      }
    });

    it('throws NotFoundException when host is not attached to the visitor', async () => {
      const ctx = makeHarness();
      try {
        await expect(
          ctx.svc.acknowledge(VISITOR_ID, '00000000-0000-0000-0000-000000000000', TENANT_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        ctx.cleanup();
      }
    });

    it('cross-tenant: host in tenant A cannot acknowledge a visitor in tenant B', async () => {
      const ctx = makeHarness({
        visitor: { tenant_id: OTHER_TENANT_ID } as never,
      });
      try {
        await expect(
          ctx.svc.acknowledge(VISITOR_ID, COHOST_A, TENANT_ID),
        ).rejects.toBeInstanceOf(NotFoundException);
      } finally {
        ctx.cleanup();
      }
    });
  });

  describe('notifyInvitationDenied (slice 3 — approval deny path)', () => {
    it('fans out a denial notification to every host', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyInvitationDenied(VISITOR_ID, TENANT_ID);

        expect(ctx.notifications.send).toHaveBeenCalledTimes(3);
        for (const send of ctx.sentNotifications) {
          expect(send.notification_type).toBe('visitor.invitation_denied');
          expect(send.related_entity_type).toBe('visitor');
          expect(send.related_entity_id).toBe(VISITOR_ID);
          expect(send.channels).toEqual(['email', 'in_app']);
        }
        const recipients = ctx.sentNotifications.map((n) => n.recipient_person_id);
        expect(recipients).toEqual(expect.arrayContaining([PRIMARY_HOST, COHOST_A, COHOST_B]));
      } finally {
        ctx.cleanup();
      }
    });

    it('does NOT update notified_at on visitor_hosts (denial is not arrival)', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyInvitationDenied(VISITOR_ID, TENANT_ID);
        // notifyArrival writes notified_at; denial must not.
        expect(ctx.visitorHostUpdates).toHaveLength(0);
      } finally {
        ctx.cleanup();
      }
    });

    it('emits per-host audit events with visitor.invitation_denied_notified', async () => {
      const ctx = makeHarness();
      try {
        await ctx.svc.notifyInvitationDenied(VISITOR_ID, TENANT_ID);
        const audited = ctx.auditInserts.filter(
          (a) => a.event_type === 'visitor.invitation_denied_notified',
        );
        expect(audited).toHaveLength(3);
      } finally {
        ctx.cleanup();
      }
    });

    it('rejects mismatched tenant context', async () => {
      const ctx = makeHarness();
      try {
        await expect(
          ctx.svc.notifyInvitationDenied(VISITOR_ID, OTHER_TENANT_ID),
        ).rejects.toBeInstanceOf(BadRequestException);
      } finally {
        ctx.cleanup();
      }
    });
  });
});
