import {
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  forwardRef,
} from '@nestjs/common';
import type { Subscription } from 'rxjs';
import {
  BundleEventBus,
  type BundleCancelledEvent,
  type BundleEvent,
  type BundleLineCancelledEvent,
  type BundleLineMovedEvent,
  type BundleLineRoomChangedEvent,
} from '../booking-bundles/bundle-event-bus';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';
import type { VisitorStatus } from './dto/transition-status.dto';
import { VisitorService } from './visitor.service';

/**
 * Subscriber that translates bundle-cascade events into visitor-side
 * actions per spec §10.2.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §10
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.9
 *
 * Status-aware cascade matrix (§10.2):
 *
 *   | Bundle change   | status='expected'                        | 'arrived' / 'in_meeting'                 | terminal (cancelled/no_show/checked_out) |
 *   |-----------------|------------------------------------------|------------------------------------------|------------------------------------------|
 *   | line.moved      | update expected_at + email visitor       | alert host (no email — visitor on site)  | no-op                                    |
 *   | line.room       | update meeting_room_id + email visitor   | alert host                               | no-op                                    |
 *   | line.cancelled  | transitionStatus → 'cancelled'           | alert host; visitor stays                | no-op                                    |
 *   | bundle.cancelled| same as line.cancelled per visitor       | same                                     | no-op                                    |
 *
 * Emit-side wiring lives in slice 4 (BundleCascadeService.editLine /
 * cancelLine / cancelBundle will inject the bus and emit). Slice 2c only
 * registers the subscriber and verifies the handlers fire correctly when
 * events ARE emitted.
 *
 * Email "alerts to host" / "send moved email" are intent-only in 2c —
 * we emit a `domain_event` describing the intent so slice 5's email
 * worker can pick it up. We do NOT enqueue a NotificationService.send()
 * here because (a) cascade fan-out can be high-fanout (10s of visitors
 * on a cancelled big-bundle event); (b) the email worker has the full
 * template/render pipeline; (c) decoupling lets us re-render without
 * re-walking visitors. Per-visitor `domain_events` is the durable
 * "what we should email" log.
 *
 * Cross-tenant: every read filters on `event.tenant_id`. The visitors
 * table is also tenant-scoped via composite FKs. A misrouted event for
 * tenant A would, at worst, find no matching visitors in tenant B — no
 * leakage.
 */
@Injectable()
export class BundleCascadeAdapter implements OnModuleInit {
  private readonly log = new Logger(BundleCascadeAdapter.name);

  private subscription: Subscription | null = null;

  constructor(
    private readonly db: DbService,
    @Inject(forwardRef(() => VisitorService))
    private readonly visitors: VisitorService,
    @Inject(forwardRef(() => BundleEventBus))
    private readonly bus: BundleEventBus,
  ) {}

  onModuleInit(): void {
    this.subscription = this.bus.events$.subscribe((event) => {
      this.handle(event).catch((err) => {
        // Subscriber failures must NEVER bubble back into the emitter
        // (which is mid-transaction in BundleCascadeService). Log and
        // move on; reception's loose-ends + per-visitor audit log are
        // the visibility surface for "we missed a cascade".
        this.log.warn(
          `bundle event handler failed for ${event.kind}: ${(err as Error).message}`,
        );
      });
    });
  }

  /** Test-only — re-subscribe (NestJS lifecycle handles production). */
  resubscribe(): void {
    this.subscription?.unsubscribe();
    this.subscription = this.bus.events$.subscribe((event) => {
      this.handle(event).catch((err) => {
        this.log.warn(
          `bundle event handler failed for ${event.kind}: ${(err as Error).message}`,
        );
      });
    });
  }

  /** Test-only — drain the subscriber when a test harness is torn down. */
  unsubscribe(): void {
    this.subscription?.unsubscribe();
    this.subscription = null;
  }

  /**
   * Direct dispatch — also exposed so tests can bypass the bus and pass
   * an event in synchronously. Production goes through the bus
   * subscription set up in `onModuleInit`.
   */
  async handle(event: BundleEvent): Promise<void> {
    switch (event.kind) {
      case 'bundle.line.moved':
        await this.handleLineMoved(event);
        return;
      case 'bundle.line.room_changed':
        await this.handleLineRoomChanged(event);
        return;
      case 'bundle.line.cancelled':
        await this.handleLineCancelled(event);
        return;
      case 'bundle.cancelled':
        await this.handleBundleCancelled(event);
        return;
    }
  }

  // ─── line.moved ─────────────────────────────────────────────────────────

  private async handleLineMoved(event: BundleLineMovedEvent): Promise<void> {
    if (event.line_kind !== 'visitor') return;
    await this.loadVisitorForCascade(event.line_id, event.tenant_id, async (visitor) => {
      if (!visitor) return;

      if (visitor.status === 'expected' || visitor.status === 'pending_approval') {
        // Update expected_at directly (no status change). Held under the
        // FOR SHARE lock, so a concurrent transitionStatus can't sneak
        // a status mutation between our status check and the intent
        // emit; it queues until our tx commits.
        await this.db.query(
          `update public.visitors
              set expected_at = $1
            where id = $2 and tenant_id = $3`,
          [event.new_expected_at, visitor.id, event.tenant_id],
        );
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.moved',
          {
            visitor_id: visitor.id,
            old_expected_at: event.old_expected_at,
            new_expected_at: event.new_expected_at,
            bundle_id: event.bundle_id,
            email_target: 'visitor',
          },
        );
        return;
      }

      if (visitor.status === 'arrived' || visitor.status === 'in_meeting') {
        // Visitor already in the building — alert host instead.
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.host_alert',
          {
            visitor_id: visitor.id,
            reason: 'bundle.line.moved',
            old_expected_at: event.old_expected_at,
            new_expected_at: event.new_expected_at,
            bundle_id: event.bundle_id,
            email_target: 'host',
          },
        );
        return;
      }

      // terminal states (checked_out / cancelled / no_show / denied) → no-op
    });
  }

  // ─── line.room_changed ──────────────────────────────────────────────────

  private async handleLineRoomChanged(
    event: BundleLineRoomChangedEvent,
  ): Promise<void> {
    if (event.line_kind !== 'visitor') return;
    await this.loadVisitorForCascade(event.line_id, event.tenant_id, async (visitor) => {
      if (!visitor) return;

      if (visitor.status === 'expected' || visitor.status === 'pending_approval') {
        await this.db.query(
          `update public.visitors
              set meeting_room_id = $1
            where id = $2 and tenant_id = $3`,
          [event.new_room_id, visitor.id, event.tenant_id],
        );
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.room_changed',
          {
            visitor_id: visitor.id,
            old_room_id: event.old_room_id,
            new_room_id: event.new_room_id,
            bundle_id: event.bundle_id,
            email_target: 'visitor',
          },
        );
        return;
      }

      if (visitor.status === 'arrived' || visitor.status === 'in_meeting') {
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.host_alert',
          {
            visitor_id: visitor.id,
            reason: 'bundle.line.room_changed',
            old_room_id: event.old_room_id,
            new_room_id: event.new_room_id,
            bundle_id: event.bundle_id,
            email_target: 'host',
          },
        );
        return;
      }
    });
  }

  // ─── line.cancelled ─────────────────────────────────────────────────────

  private async handleLineCancelled(
    event: BundleLineCancelledEvent,
  ): Promise<void> {
    if (event.line_kind !== 'visitor') return;

    // Two-step: read with FOR SHARE to learn the branch, then commit and
    // act. We deliberately DO NOT hold the share lock across the
    // transitionStatus call below — transitionStatus acquires its own
    // FOR UPDATE on the same row in a separate tx, and FOR SHARE held
    // by us would deadlock. transitionStatus itself re-checks the
    // status inside its FOR UPDATE; if the visitor's branch shifted
    // between our read and the action, transitionStatus raises
    // 'invalid_transition' and we log + skip the cascade intent rather
    // than emit a stale email order. That's the post-commit safety net
    // the FOR SHARE read alone can't provide for the cancellation
    // path.
    const visitor = await this.loadVisitorForCascade(
      event.line_id,
      event.tenant_id,
      async (v) => v,
    );
    if (!visitor) return;

    if (visitor.status === 'expected' || visitor.status === 'pending_approval') {
      await this.runInTenant(event.tenant_id, async () => {
        try {
          await this.visitors.transitionStatus(
            visitor.id,
            'cancelled',
            { user_id: 'system', person_id: null },
          );
        } catch (err) {
          // Concurrent path beat us to a different terminal state. The
          // cascade for THIS event is moot — log and bail without
          // emitting the email intent. The other path's transition will
          // have already emitted its own cascade-cancelled intent if
          // appropriate (e.g. user clicked the cancel link).
          this.log.warn(
            `cascade cancellation skipped — visitor ${visitor.id} status changed under us: ${
              (err as Error).message
            }`,
          );
          return;
        }
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.cancelled',
          {
            visitor_id: visitor.id,
            bundle_id: event.bundle_id,
            email_target: 'visitor',
          },
        );
      });
      return;
    }

    if (visitor.status === 'arrived' || visitor.status === 'in_meeting') {
      // Per spec §10.2 — visitor stays; alert host.
      await this.runInTenant(event.tenant_id, async () => {
        await this.emitIntent(
          event.tenant_id,
          visitor.id,
          'visitor.cascade.host_alert',
          {
            visitor_id: visitor.id,
            reason: 'bundle.line.cancelled',
            bundle_id: event.bundle_id,
            email_target: 'host',
          },
        );
      });
      return;
    }
  }

  // ─── bundle.cancelled ───────────────────────────────────────────────────

  private async handleBundleCancelled(event: BundleCancelledEvent): Promise<void> {
    // Find every visitor linked to this bundle and cascade per-line semantics.
    const visitorIds = await this.runInTenant(event.tenant_id, async () => {
      const rows = await this.db.queryMany<{ id: string }>(
        `select id
           from public.visitors
          where tenant_id = $1
            and booking_bundle_id = $2`,
        [event.tenant_id, event.bundle_id],
      );
      return rows.map((r) => r.id);
    });

    for (const visitorId of visitorIds) {
      // Synthesize a per-visitor line-cancelled event — keeps the
      // per-visitor logic in one place and avoids duplicating the
      // status branch.
      await this.handleLineCancelled({
        kind: 'bundle.line.cancelled',
        tenant_id: event.tenant_id,
        bundle_id: event.bundle_id,
        line_id: visitorId,
        line_kind: 'visitor',
        occurred_at: event.occurred_at,
      });
    }
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  /**
   * Read the visitor under a `FOR SHARE` row lock inside a transaction.
   *
   * I6 (full review) — race fix:
   *   The cascade emitter writes its DB changes and emits the bus event
   *   POST-COMMIT (BundleCascadeService). Between the bus emit and this
   *   adapter handling the event, the visitor's status can drift —
   *   another path might cancel/check-out the visitor concurrently.
   *   The adapter then sees a stale status and dispatches the wrong
   *   cascade branch (e.g. emails the visitor about a moved meeting
   *   when they've already cancelled and gone home).
   *
   *   FOR SHARE blocks until any in-flight UPDATE on the row (e.g. the
   *   FOR UPDATE lock inside VisitorService.transitionStatus) commits.
   *   Once we have the share lock, the status we read is consistent
   *   with the post-commit state of every concurrent writer. No
   *   ABORT-mode lock is needed because we never WRITE the visitor row
   *   here — we only branch on its status; the actual mutation (when
   *   needed) is delegated to VisitorService.transitionStatus, which
   *   acquires its own FOR UPDATE lock under a separate tx.
   *
   *   We hold the FOR SHARE lock until the caller emits its intent
   *   (domain_event insert + optional non-status UPDATE for
   *   expected_at / meeting_room_id). That keeps the read+act atomic
   *   with respect to status writers.
   *
   *   The lock duration is a single tx and the work inside it is
   *   bounded (one INSERT into domain_events; optionally one UPDATE
   *   that touches non-status columns). A status-writer tx behind us
   *   queues briefly but does not deadlock because it acquires
   *   FOR UPDATE on the same row in a different tx — Postgres orders
   *   FOR SHARE before FOR UPDATE within tx semantics, and we always
   *   exit the tx before the writer's lock is needed.
   */
  private async loadVisitorForCascade<T>(
    visitorId: string,
    tenantId: string,
    fn: (
      visitor: { id: string; tenant_id: string; status: VisitorStatus } | null,
    ) => Promise<T>,
  ): Promise<T> {
    return this.runInTenant(tenantId, async () =>
      this.db.tx(async (client) => {
        const result = await client.query<{
          id: string;
          tenant_id: string;
          status: VisitorStatus;
        }>(
          `select id, tenant_id, status
             from public.visitors
            where id = $1 and tenant_id = $2
            for share`,
          [visitorId, tenantId],
        );
        const row = result.rows[0] ?? null;
        return fn(row);
      }),
    );
  }

  /**
   * Run a callback inside a synthetic TenantContext so downstream
   * VisitorService.transitionStatus / DbService calls have a context to
   * resolve. The bus subscription fires outside any HTTP request scope
   * (the emitter is mid-transaction in BundleCascadeService); the
   * AsyncLocalStorage from that emitter call doesn't propagate through
   * RxJS, so we re-establish.
   */
  private async runInTenant<T>(
    tenantId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const existing = TenantContext.currentOrNull();
    if (existing && existing.id === tenantId) {
      return fn();
    }
    return TenantContext.run(
      // Minimal tenant info — id is what the downstream code reads.
      // slug / tier are unused by the visitor cascade pipeline.
      { id: tenantId, slug: 'cascade', tier: 'standard' },
      fn,
    );
  }

  private async emitIntent(
    tenantId: string,
    visitorId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.query(
        `insert into public.domain_events
            (tenant_id, event_type, entity_type, entity_id, payload)
          values ($1, $2, 'visitor', $3, $4::jsonb)`,
        [tenantId, eventType, visitorId, JSON.stringify(payload)],
      );
    } catch (err) {
      this.log.warn(
        `domain_events insert failed for ${eventType}: ${(err as Error).message}`,
      );
    }
  }
}
