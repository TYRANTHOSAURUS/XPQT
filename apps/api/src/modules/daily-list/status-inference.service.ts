import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import { DailyListEventType } from './event-types';

/**
 * Sprint 4 — paper-vendor status inference worker.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §8.
 *
 * Algorithm per cron tick (every 5 minutes):
 *   1. Find order_line_items where:
 *        - vendor.fulfillment_mode = 'paper_only'
 *        - manual_status_set_at IS NULL  (desk hasn't overridden)
 *        - fulfillment_status IN ('ordered','preparing')
 *        - service_window_start_at IS NOT NULL
 *   2. For each line, decide the inferred transition:
 *        - 'ordered' → 'preparing'  when now() >= service_window_start_at - 1h
 *        - 'preparing' → 'delivered' when now() >= service_window_start_at + grace
 *      where `grace` defaults to 30 min (vendor-configurable via
 *      vendors.daglijst_inferred_status_grace_minutes).
 *   3. UPDATE the line + emit DailyListEventType.OrderLineStatusInferred
 *      audit so scorecards can distinguish inferred vs self-reported.
 *
 * Hard-cap (default 500 lines/tick) so a backlog doesn't take down the
 * worker. Whatever doesn't get processed rolls forward.
 *
 * Env knobs:
 *   DAILY_LIST_STATUS_INFERENCE_ENABLED       — set 'false' to disable
 *   DAILY_LIST_STATUS_INFERENCE_MAX_PER_TICK  — batch cap (default 500)
 */
@Injectable()
export class DailyListStatusInferenceService {
  private readonly log = new Logger(DailyListStatusInferenceService.name);

  private readonly enabled = process.env.DAILY_LIST_STATUS_INFERENCE_ENABLED !== 'false';
  private readonly maxPerTick = Number(
    process.env.DAILY_LIST_STATUS_INFERENCE_MAX_PER_TICK ?? 500,
  );
  private static readonly DEFAULT_GRACE_MINUTES = 30;
  private static readonly PREPARING_LEAD_MINUTES = 60;

  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly auditOutbox: AuditOutboxService,
  ) {}

  /**
   * Every 5 minutes — same cadence as the daily-list scheduler so the
   * inference loop and the cutoff loop stay in lockstep.
   */
  @Cron('30 */5 * * * *')                 // offset 30s from the daily-list scheduler at :00
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;

    const startedAt = Date.now();
    let inferred = 0;

    try {
      inferred = await this.runOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`status inference tick failed: ${msg}`);
    } finally {
      this.running = false;
      if (inferred > 0) {
        this.log.log(`status inference: ${inferred} line(s) transitioned (${Date.now() - startedAt}ms)`);
      }
    }
  }

  /**
   * Pure implementation — call directly from a manual reconciliation
   * job or a unit test.
   */
  async runOnce(): Promise<number> {
    /* All-tenants UPDATE in two passes (one per transition) so the
       audit emit can attribute the right from→to pair. The hot-path
       index (00181) keeps the WHERE filter cheap. */

    /* Pass 1: ordered → preparing for lines whose delivery is within
       the next PREPARING_LEAD_MINUTES window. */
    const promoted = await this.db.queryMany<InferredRow>(
      `update public.order_line_items oli
          set fulfillment_status   = 'preparing',
              status_event_source  = 'inferred',
              status_inferred_at   = now(),
              updated_at           = now()
         from public.vendors v
        where oli.vendor_id = v.id
          and oli.tenant_id = v.tenant_id
          and v.fulfillment_mode = 'paper_only'
          and oli.manual_status_set_at is null
          and oli.fulfillment_status = 'ordered'
          and oli.service_window_start_at is not null
          and oli.service_window_start_at <= now() + ($1::int || ' minutes')::interval
          and oli.id in (
            /* Hard-cap the per-tick batch so we don't lock the table
               under a backlog. The next tick picks up the rest. */
            select id
              from public.order_line_items
             where manual_status_set_at is null
               and fulfillment_status = 'ordered'
               and service_window_start_at is not null
             order by service_window_start_at asc
             limit $2
          )
        returning oli.id, oli.tenant_id, oli.vendor_id, oli.order_id,
                  oli.service_window_start_at, oli.fulfillment_status as new_status,
                  'ordered' as prev_status`,
      [DailyListStatusInferenceService.PREPARING_LEAD_MINUTES, this.maxPerTick],
    );

    /* Pass 2: preparing → delivered for lines past the grace window.
       Uses the per-vendor grace_minutes (default 30) — joined here so
       a vendor with longer prep / delivery windows isn't false-positived
       to delivered too early. */
    const delivered = await this.db.queryMany<InferredRow>(
      `update public.order_line_items oli
          set fulfillment_status   = 'delivered',
              status_event_source  = 'inferred',
              status_inferred_at   = now(),
              updated_at           = now()
         from public.vendors v
        where oli.vendor_id = v.id
          and oli.tenant_id = v.tenant_id
          and v.fulfillment_mode = 'paper_only'
          and oli.manual_status_set_at is null
          and oli.fulfillment_status = 'preparing'
          and oli.service_window_start_at is not null
          and oli.service_window_start_at + (
                coalesce(v.daglijst_inferred_status_grace_minutes, $1)::int || ' minutes'
              )::interval <= now()
          and oli.id in (
            select id
              from public.order_line_items
             where manual_status_set_at is null
               and fulfillment_status = 'preparing'
               and service_window_start_at is not null
             order by service_window_start_at asc
             limit $2
          )
        returning oli.id, oli.tenant_id, oli.vendor_id, oli.order_id,
                  oli.service_window_start_at, oli.fulfillment_status as new_status,
                  'preparing' as prev_status`,
      [DailyListStatusInferenceService.DEFAULT_GRACE_MINUTES, this.maxPerTick],
    );

    /* One audit per row. Emit OUTSIDE the UPDATEs (no tx wrap) since
       audit_outbox.emit() is idempotent and the worker is the only
       writer for inferred transitions on these rows. */
    for (const r of [...promoted, ...delivered]) {
      await this.auditOutbox.emit({
        tenantId: r.tenant_id,
        eventType: DailyListEventType.OrderLineStatusInferred,
        entityType: 'order_line_items',
        entityId: r.id,
        details: {
          vendor_id: r.vendor_id,
          order_id: r.order_id,
          prev_status: r.prev_status,
          new_status: r.new_status,
          service_window_start_at: r.service_window_start_at,
          event_source: 'inferred',
        },
      });
    }

    return promoted.length + delivered.length;
  }
}

interface InferredRow {
  id: string;
  tenant_id: string;
  vendor_id: string;
  order_id: string;
  service_window_start_at: string;
  prev_status: 'ordered' | 'preparing';
  new_status: 'preparing' | 'delivered';
}
