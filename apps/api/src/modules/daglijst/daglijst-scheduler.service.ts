import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../common/db/db.service';
import { DaglijstService } from './daglijst.service';

/**
 * Cron-driven daglijst scheduler.
 *
 * Spec: docs/superpowers/specs/2026-04-27-vendor-portal-phase-a-daglijst-design.md §4 DaglijstSchedulerService.
 *
 * Algorithm per cron tick:
 *   1. Find every (tenant, vendor in paper_only|hybrid mode, building,
 *      service_type, list_date) bucket that has at least one
 *      not-yet-locked order_line_item with delivery_date in {today, tomorrow}.
 *   2. For each bucket, compute next_send_at:
 *        - clock-time mode: list_date - 1 day @ vendor.daglijst_send_clock_time (NL local)
 *        - offset mode:     min(delivery_time across bucket) - daglijst_cutoff_offset_minutes
 *   3. If now() >= next_send_at AND no v1 emitted yet, trigger generate + send.
 *   4. Per-bucket advisory lock prevents double-fire under concurrent worker
 *      instances.
 *
 * Hard-cap on the per-tick batch (default 200) so a backlog after a long
 * outage doesn't take the scheduler down. Whatever doesn't get processed
 * in this tick rolls forward to the next.
 *
 * Env knobs (production tuning):
 *   DAGLIJST_SCHEDULER_ENABLED       — set 'false' to disable in tests/migrations
 *   DAGLIJST_SCHEDULER_MAX_PER_TICK  — bucket-batch cap per tick (default 200)
 */
@Injectable()
export class DaglijstSchedulerService {
  private readonly log = new Logger(DaglijstSchedulerService.name);

  /** Lock-key namespace for pg_advisory_xact_lock — distinct from retention/audit. */
  private static readonly LOCK_NS = 0x4441_4753;                       // 'DAGS' as 4 ASCII bytes

  private readonly enabled = process.env.DAGLIJST_SCHEDULER_ENABLED !== 'false';
  private readonly maxPerTick = Number(process.env.DAGLIJST_SCHEDULER_MAX_PER_TICK ?? 200);

  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly daglijst: DaglijstService,
  ) {}

  /**
   * Every 5 minutes, walk pending buckets. Spec calls for 15-min default;
   * 5-min keeps the bucket-spans-cutoff race window small and is cheap
   * because most ticks find nothing to do. Lower bound on burst latency.
   */
  @Cron('0 */5 * * * *')
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;          // self-serialize; concurrent ticks would duplicate work
    this.running = true;

    const startedAt = Date.now();
    let buckets = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const due = await this.findDueBuckets();
      buckets = due.length;
      for (const bucket of due) {
        const result = await this.processBucket(bucket);
        if (result === 'sent') sent += 1;
        else if (result === 'skipped') skipped += 1;
        else failed += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`scheduler tick failed: ${msg}`);
    } finally {
      this.running = false;
      if (buckets > 0) {
        this.log.log(
          `scheduler tick: buckets=${buckets} sent=${sent} skipped=${skipped} ` +
          `failed=${failed} elapsed_ms=${Date.now() - startedAt}`,
        );
      }
    }
  }

  /**
   * Find pending buckets where we'd send NOW. Composes
   * (tenant, vendor, building, service_type, list_date) tuples by
   * grouping unsent line items at the SQL layer; resolves the cutoff
   * timestamp via a CASE on vendor mode + filters tuples whose cutoff
   * has passed and whose v1 isn't yet emitted.
   *
   * Returns at most maxPerTick buckets, oldest-cutoff-first.
   */
  private async findDueBuckets(): Promise<DueBucket[]> {
    return this.db.queryMany<DueBucket>(
      `with bucket as (
         select
           v.tenant_id                                                    as tenant_id,
           v.id                                                           as vendor_id,
           ord.delivery_location_id                                       as building_id,
           coalesce(
             (ord.policy_snapshot->>'service_type')::text,
             'catering'
           )                                                               as service_type,
           ord.delivery_date                                               as list_date,
           min(ord.delivery_time)                                          as earliest_delivery_time,
           v.daglijst_cutoff_offset_minutes                                as offset_minutes,
           v.daglijst_send_clock_time                                      as clock_time
           from vendors v
           join order_line_items oli
             on oli.vendor_id = v.id
            and oli.tenant_id = v.tenant_id
           join orders ord
             on ord.id = oli.order_id
            and ord.tenant_id = v.tenant_id
          where v.fulfillment_mode in ('paper_only','hybrid')
            and v.active = true
            and v.daglijst_email is not null
            and oli.daglijst_locked_at is null
            and oli.recurrence_skipped is not true
            and ord.status not in ('cancelled')
            and ord.delivery_date between current_date and current_date + interval '1 day'
          group by v.tenant_id, v.id, ord.delivery_location_id, service_type,
                   ord.delivery_date,
                   v.daglijst_cutoff_offset_minutes, v.daglijst_send_clock_time
       )
       select
         tenant_id, vendor_id, building_id, service_type, list_date,
         /* Compute next_send_at for each bucket. clock_time wins when set. */
         case
           when clock_time is not null then
             ((list_date - interval '1 day')::date + clock_time)::timestamptz
           else
             (list_date::timestamptz + earliest_delivery_time::time
               - (offset_minutes::text || ' minutes')::interval)
         end as next_send_at
       from bucket b
       where
         /* due: cutoff passed */
         case
           when clock_time is not null then
             ((list_date - interval '1 day')::date + clock_time)::timestamptz <= now()
           else
             (list_date::timestamptz + earliest_delivery_time::time
               - (offset_minutes::text || ' minutes')::interval) <= now()
         end
         /* and no v1 already emitted for this bucket */
         and not exists (
           select 1 from vendor_daily_lists vdl
            where vdl.tenant_id = b.tenant_id
              and vdl.vendor_id = b.vendor_id
              and (vdl.building_id is not distinct from b.building_id)
              and vdl.service_type = b.service_type
              and vdl.list_date    = b.list_date
              and vdl.sent_at is not null
         )
       order by next_send_at asc
       limit $1`,
      [this.maxPerTick],
    );
  }

  /**
   * Generate (assemble + record + render + upload) + send a single bucket
   * inside an advisory lock so two scheduler instances can't double-fire
   * the same tuple.
   */
  private async processBucket(bucket: DueBucket): Promise<'sent' | 'skipped' | 'failed'> {
    const lockKey = bucketLockKey(bucket);
    const tenantId = bucket.tenant_id;

    return this.db.tx(async (client) => {
      const got = await client.query<{ locked: boolean }>(
        `select pg_try_advisory_xact_lock($1, $2) as locked`,
        [DaglijstSchedulerService.LOCK_NS, lockKey],
      );
      if (!got.rows[0]?.locked) {
        return 'skipped';                              // another worker has it
      }

      // Re-check inside the lock — another worker may have just sent it.
      const stillPending = await client.query(
        `select 1 from vendor_daily_lists
          where tenant_id = $1
            and vendor_id = $2
            and (building_id is not distinct from $3)
            and service_type = $4
            and list_date    = $5
            and sent_at is not null
          limit 1`,
        [
          tenantId,
          bucket.vendor_id,
          bucket.building_id,
          bucket.service_type,
          bucket.list_date,
        ],
      );
      if (stillPending.rowCount && stillPending.rowCount > 0) {
        return 'skipped';
      }

      try {
        const generated = await this.daglijst.generate({
          tenantId,
          vendorId: bucket.vendor_id,
          buildingId: bucket.building_id,
          serviceType: bucket.service_type,
          listDate: bucket.list_date,
          triggeredBy: 'auto',
        });
        // generate() doesn't itself send. Render + upload + email here.
        await this.daglijst.send({ tenantId, daglijstId: generated.id });
        return 'sent';
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(
          `scheduler bucket failed tenant=${tenantId} vendor=${bucket.vendor_id} ` +
          `date=${bucket.list_date} svc=${bucket.service_type}: ${msg}`,
        );
        return 'failed';
      }
    });
  }
}

// =====================================================================
// helpers + types
// =====================================================================

interface DueBucket {
  tenant_id: string;
  vendor_id: string;
  building_id: string | null;
  service_type: string;
  list_date: string;
  next_send_at: string;
}

function bucketLockKey(b: DueBucket): number {
  const composite = `${b.tenant_id}:${b.vendor_id}:${b.building_id ?? '_tenant'}:${b.service_type}:${b.list_date}`;
  let h = 0;
  for (let i = 0; i < composite.length; i += 1) {
    h = (h * 31 + composite.charCodeAt(i)) | 0;
  }
  return h;
}
