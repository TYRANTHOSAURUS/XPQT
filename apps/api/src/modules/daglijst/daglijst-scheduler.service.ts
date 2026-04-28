import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DbService } from '../../common/db/db.service';
import { AuditOutboxService } from '../privacy-compliance/audit-outbox.service';
import {
  DaglijstService,
  ListCancelledError,
} from './daglijst.service';
import { DaglijstEventType } from './event-types';

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
    private readonly auditOutbox: AuditOutboxService,
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
    let cancelled = 0;
    let reclaimed = 0;

    try {
      // Codex round-2 fix: sweep stuck-in-'sending' rows BEFORE finding
      // due buckets so the retry-existing path can pick them up in this
      // same tick. Bounded crash recovery — the row's CAS-acquire happened
      // in a previous tick, the worker died before commit, and now the
      // 'sending' state is older than the sweep threshold.
      try {
        const reclaimedRows = await this.daglijst.reclaimStuckSendingRows();
        reclaimed = reclaimedRows.length;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`scheduler sweeper failed (continuing): ${msg}`);
      }

      const due = await this.findDueBuckets();
      buckets = due.length;
      for (const bucket of due) {
        const result = await this.processBucket(bucket);
        if (result === 'sent') sent += 1;
        else if (result === 'skipped') skipped += 1;
        else if (result === 'cancelled') cancelled += 1;
        else failed += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`scheduler tick failed: ${msg}`);
    } finally {
      this.running = false;
      if (buckets > 0 || reclaimed > 0) {
        this.log.log(
          `scheduler tick: buckets=${buckets} sent=${sent} skipped=${skipped} ` +
          `cancelled=${cancelled} failed=${failed} reclaimed=${reclaimed} ` +
          `elapsed_ms=${Date.now() - startedAt}`,
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
    // Codex Sprint 2 fix #3: cutoff math runs in Europe/Amsterdam, NOT
    // the DB session timezone. Postgres handles DST transitions correctly
    // when we explicitly cast through `AT TIME ZONE 'Europe/Amsterdam'` —
    // the date `2026-03-29` (DST spring-forward) gets a 23-hour day, the
    // 'send at 19:00' clock-mode resolves correctly without a 1-hour drift.
    //
    // Tenant-configurable timezone is a Sprint 4 follow-up; today every
    // tenant in our market is NL/BE so Amsterdam is correct.
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
            /* Window in Amsterdam local: today + tomorrow. */
            and ord.delivery_date between
                  (now() at time zone 'Europe/Amsterdam')::date
              and (now() at time zone 'Europe/Amsterdam')::date + interval '1 day'
          group by v.tenant_id, v.id, ord.delivery_location_id, service_type,
                   ord.delivery_date,
                   v.daglijst_cutoff_offset_minutes, v.daglijst_send_clock_time
       )
       select
         tenant_id, vendor_id, building_id, service_type, list_date,
         /*
          * Compute next_send_at as a Europe/Amsterdam local time, then
          * cast to timestamptz so we can compare against now().
          *
          * - clock mode: list_date - 1 day @ clock_time, AT TIME ZONE Amsterdam
          * - offset mode: list_date @ earliest_delivery_time - offset_minutes,
          *                AT TIME ZONE Amsterdam
          *
          * The (local_ts AT TIME ZONE 'Europe/Amsterdam') cast tells
          * Postgres "this naive timestamp IS in Amsterdam local"; the
          * resulting timestamptz is in UTC for comparison. DST handled
          * automatically.
          */
         case
           when clock_time is not null then
             (((list_date - interval '1 day')::date + clock_time)
                at time zone 'Europe/Amsterdam')
           else
             ((list_date::timestamp + earliest_delivery_time)
                at time zone 'Europe/Amsterdam'
                - (offset_minutes::text || ' minutes')::interval)
         end as next_send_at
       from bucket b
       where
         case
           when clock_time is not null then
             (((list_date - interval '1 day')::date + clock_time)
                at time zone 'Europe/Amsterdam') <= now()
           else
             ((list_date::timestamp + earliest_delivery_time)
                at time zone 'Europe/Amsterdam'
                - (offset_minutes::text || ' minutes')::interval) <= now()
         end
         /* and no row already SENT for this bucket. Unsent/failed rows
            are retried by processBucket() rather than triggering a new
            version mint (codex Sprint 2 fix #2). */
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
   * Process one bucket — retry an unsent prior version when present, else
   * generate v_n+1, then send. The advisory lock prevents two scheduler
   * instances from double-version-bumping; the row-level CAS inside
   * DaglijstService.send prevents two from double-mailing.
   *
   * Codex Sprint 2 fixes wired here:
   *   - #2 retry-existing: findUnsentRowForBucket before generate. Avoids
   *        the version-bump-forever loop on transient failures.
   *   - #4 empty-list:     generate() throws ListCancelledError when every
   *        line is cancelled at send time; we audit + skip the bucket
   *        instead of recording a zero-line PDF.
   *
   * The advisory lock is now scoped to the version-bump decision only —
   * once we have a daglijst_id, the per-row CAS in send() is the
   * authoritative concurrency primitive. Releasing the advisory lock
   * before the mail call is intentional (the mailer is a network call;
   * blocking other buckets while it runs would serialize the whole
   * tick).
   */
  private async processBucket(bucket: DueBucket): Promise<'sent' | 'skipped' | 'failed' | 'cancelled'> {
    const lockKey = bucketLockKey(bucket);
    const tenantId = bucket.tenant_id;

    // Phase 1: under advisory lock, decide which row to send.
    let daglijstId: string | null = null;
    let phase1Outcome: 'reuse' | 'generated' | 'skipped' | 'cancelled' | 'failed' = 'skipped';

    phase1Outcome = await this.db.tx(async (client) => {
      const got = await client.query<{ locked: boolean }>(
        `select pg_try_advisory_xact_lock($1, $2) as locked`,
        [DaglijstSchedulerService.LOCK_NS, lockKey],
      );
      if (!got.rows[0]?.locked) {
        return 'skipped';
      }

      // Re-check inside the lock — another worker may have just SENT it.
      const sentAlready = await client.query(
        `select 1 from vendor_daily_lists
          where tenant_id = $1 and vendor_id = $2
            and (building_id is not distinct from $3)
            and service_type = $4 and list_date = $5
            and sent_at is not null
          limit 1`,
        [tenantId, bucket.vendor_id, bucket.building_id, bucket.service_type, bucket.list_date],
      );
      if ((sentAlready.rowCount ?? 0) > 0) {
        return 'skipped';
      }

      // Retry path (codex fix #2): is there a prior unsent row?
      const existing = await this.daglijst.findUnsentRowForBucket({
        tenantId, vendorId: bucket.vendor_id,
        buildingId: bucket.building_id,
        serviceType: bucket.service_type,
        listDate: bucket.list_date,
      });
      if (existing) {
        daglijstId = existing.id;
        return 'reuse';
      }

      // Mint a new version.
      try {
        const generated = await this.daglijst.generate({
          tenantId,
          vendorId: bucket.vendor_id,
          buildingId: bucket.building_id,
          serviceType: bucket.service_type,
          listDate: bucket.list_date,
          triggeredBy: 'auto',
        });
        daglijstId = generated.id;
        return 'generated';
      } catch (err) {
        if (err instanceof ListCancelledError) {
          // Empty bucket — every line cancelled between scan + send.
          // Audit + skip. Sprint 4 will dispatch a "list cancelled"
          // notification instead.
          this.log.warn(
            `scheduler skipped cancelled bucket tenant=${tenantId} vendor=${bucket.vendor_id} ` +
            `date=${bucket.list_date} svc=${bucket.service_type}`,
          );
          // Codex round-2 fix: emit the dedicated 'daglijst.cancelled'
          // event (NOT send_failed). Operationally these are different
          // categories — cancelled means "no work to do, all good", failed
          // means "we tried and the mailer broke". Mixing them muddies the
          // failure-rate metric ops watches for paging.
          await this.auditOutbox.emitTx(client, {
            tenantId,
            eventType: DaglijstEventType.Cancelled,
            entityType: 'vendors',
            entityId: bucket.vendor_id,
            details: {
              reason: 'list_cancelled_empty_bucket',
              list_date: bucket.list_date,
              building_id: bucket.building_id,
              service_type: bucket.service_type,
            },
          });
          return 'cancelled';
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(
          `scheduler generate failed tenant=${tenantId} vendor=${bucket.vendor_id} ` +
          `date=${bucket.list_date} svc=${bucket.service_type}: ${msg}`,
        );
        return 'failed';
      }
    });

    if (phase1Outcome !== 'reuse' && phase1Outcome !== 'generated') {
      return phase1Outcome;
    }

    // Phase 2: send (DaglijstService.send has its own row-level CAS that
    // serializes concurrent send attempts on the same row, so it's safe
    // to run outside the advisory lock).
    //
    // Codex round-2 fix: send() now returns a discriminated SendOutcome
    // — we MUST branch on outcome.status instead of treating any
    // non-throwing return as "sent". A 'skipped_in_flight' result means
    // another worker holds the CAS (this tick lost the race); we count
    // it as 'skipped' rather than 'sent' so tick metrics don't lie.
    try {
      const outcome = await this.daglijst.send({ tenantId, daglijstId: daglijstId! });
      if (outcome.status === 'sent') return 'sent';
      // already_sent or skipped_in_flight — we didn't actually send mail
      // this tick. Don't double-count as success.
      return 'skipped';
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(
        `scheduler send failed tenant=${tenantId} vendor=${bucket.vendor_id} ` +
        `daglijst=${daglijstId} ${phase1Outcome}: ${msg}`,
      );
      return 'failed';
    }
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
