import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { hostname } from 'node:os';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';
import type { VisitorStatus } from './dto/transition-status.dto';
import { VisitorPassPoolService } from './pass-pool.service';
import { VisitorService } from './visitor.service';

/**
 * EOD (end-of-day) visitor sweep — flips stuck visits to terminal states
 * at 18:00 building-local.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §12
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.8
 *
 * What it does, per building:
 *   - status='expected' AND expected_until < now() → 'no_show'.
 *   - status in ('arrived', 'in_meeting') AND expected_until < now()
 *     → 'checked_out' with checkout_source='eod_sweep'.
 *     - VisitorService.transitionStatus stamps `auto_checked_out=true`
 *       when checkout_source is 'eod_sweep' (slice 2a).
 *     - If the visitor held a pass, mark it 'lost' with reason
 *       'unreturned via eod sweep' so the next-shift reconciliation
 *       tile surfaces it.
 *   - Visitors with `expected_until > now()` are NOT swept (legitimate
 *     long meetings preserved).
 *
 * Idempotency:
 *   - Lease per `(tenant, building, sweep_date)` via `task_leases`
 *     (migration 00262). Insert with the unique key `lease_key =
 *     'visitor.eod.<building_id>.<YYYY-MM-DD>'`. A second tick on the
 *     same building+date conflicts on the unique index → skip.
 *   - Lease NEVER auto-released for visitor.eod — the row's existence
 *     IS the "we've run today" record. Re-runs of the same key on the
 *     same date are no-ops; new runs happen tomorrow under a new key.
 *
 * Cron windowing — global tick + per-building local-time filter:
 *   - Single cron expression fires every 15 minutes around the clock
 *     (`*\/15 * * * *`). Per-building local-hour filtering happens inside
 *     the SQL: a building is swept when `(now() at time zone
 *     spaces.timezone)::hour = 18`. Worldwide buildings are covered:
 *     a Tokyo (UTC+9) building hits the 18-local window at 09:00 UTC,
 *     an Amsterdam (UTC+1/+2) building hits it at 16-17:00 UTC, a Los
 *     Angeles (UTC-7/-8) building hits it at 01-02:00 UTC. The
 *     idempotency lease (`task_leases.lease_key = 'visitor.eod.<bid>.<date>'`)
 *     ensures a building is swept exactly once per LOCAL date even
 *     though the global cron fires four times per hour.
 *   - Original v1 patterns were UTC 17:30–19:00 only — Benelux-only.
 *     I3 fix: widen to global so cross-timezone tenants are covered
 *     without code change per market.
 *   - Trade-off: 4 ticks/hour × 24 hours = 96 cron firings/day. Each
 *     tick runs one cheap SELECT + a no-op exit when the building set
 *     is empty (the common case for any single timezone slice). At
 *     fewer than ~10ms per empty tick that's a ~1s/day load. The lease
 *     IS the idempotency guarantee; the cron just has to fire often
 *     enough that we don't miss the local 18:00 hour.
 *
 * Timezone handling — Postgres-side:
 *   - We resolve the building's local hour with `extract(hour from (now()
 *     at time zone spaces.timezone))` and filter in the SELECT. Keeps
 *     DST math in Postgres (correct), avoids a Node-side
 *     `Intl.DateTimeFormat` dance per building. Spec §4.8 says
 *     `spaces.timezone` defaults to 'Europe/Amsterdam'.
 *
 * Env knobs:
 *   - `VISITOR_EOD_SWEEP_ENABLED=false` disables the cron entirely
 *     (used in tests + local dev).
 */
@Injectable()
export class EodSweepWorker {
  private readonly log = new Logger(EodSweepWorker.name);
  private readonly enabled =
    process.env.VISITOR_EOD_SWEEP_ENABLED !== 'false';
  private running = false;

  /** Identifies this Node process in `task_leases.acquired_by`. */
  private readonly workerId = `eod-sweep@${hostname()}/${process.pid}`;

  constructor(
    private readonly db: DbService,
    private readonly visitors: VisitorService,
    private readonly passPool: VisitorPassPoolService,
  ) {}

  /**
   * Global 15-minute tick. Per-building local-hour filtering happens
   * inside the SQL — see `findBuildingsInLocalEodWindow` — so this
   * single cron expression covers every timezone. The lease key is
   * scoped to the building's local date, so a building gets swept
   * exactly once even though the global cron fires every 15 min.
   *
   * I3 fix (full review): replaced the narrow UTC-17:30–19:00 pattern
   * with a global tick so non-Benelux tenants (Tokyo, NYC, LA, …) are
   * covered without per-deploy code changes.
   */
  @Cron('0 */15 * * * *')
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) return;
    this.running = true;
    try {
      await this.runForAllBuildingsInWindow();
    } finally {
      this.running = false;
    }
  }

  /**
   * Find every building whose LOCAL time is currently in [18:00, 19:00)
   * and that we haven't yet swept today, then run the sweep.
   */
  private async runForAllBuildingsInWindow(): Promise<void> {
    const buildings = await this.findBuildingsInLocalEodWindow();
    for (const b of buildings) {
      try {
        await this.runSweepForBuilding(b.id, b.tenant_id);
      } catch (err) {
        this.log.warn(
          `EOD sweep failed for building ${b.id} tenant ${b.tenant_id}: ${
            (err as Error).message
          }`,
        );
      }
    }
  }

  /** Find buildings to sweep this tick — Postgres-side timezone math. */
  private async findBuildingsInLocalEodWindow(): Promise<
    Array<{ id: string; tenant_id: string; timezone: string }>
  > {
    // Per-building local hour. `now() at time zone tz` returns a
    // timestamp WITHOUT time zone, treated as local. We pull the hour
    // and filter for [18, 19).
    const sql = `
      select id, tenant_id, timezone
        from public.spaces
       where type = 'building'
         and active = true
         and timezone is not null
         and extract(hour from (now() at time zone timezone)) = 18
    `;
    return this.db.queryMany<{
      id: string;
      tenant_id: string;
      timezone: string;
    }>(sql);
  }

  /**
   * Run the sweep for a single building. Public so tests + admin debug
   * surfaces (slice 2d) can trigger it directly without waiting for cron.
   *
   * Behavior:
   *   1. Acquire lease via `task_leases` insert. Conflict → skip.
   *   2. Find candidate visitors: building_id + status in
   *      ('expected', 'arrived', 'in_meeting') + expected_until < now().
   *   3. transitionStatus per visitor (no_show or checked_out) — under
   *      a synthesized TenantContext so VisitorService can validate.
   *   4. For checked_out + visitor_pass_id: passPool.markPassMissing.
   *   5. Audit `visitor.eod_swept` summary on the building.
   *
   * Returns counts. Used by tests + the eventual admin debug endpoint.
   */
  async runSweepForBuilding(
    buildingId: string,
    tenantId: string,
  ): Promise<EodSweepResult> {
    const sweepDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const leaseKey = `visitor.eod.${buildingId}.${sweepDate}`;

    const acquired = await this.tryAcquireLease(leaseKey, tenantId);
    if (!acquired) {
      this.log.log(`EOD lease ${leaseKey} not acquired — skipping`);
      return {
        building_id: buildingId,
        skipped: true,
        no_show_count: 0,
        auto_checked_out_count: 0,
        passes_flagged_count: 0,
      };
    }

    let noShowCount = 0;
    let autoCheckedOutCount = 0;
    let passesFlaggedCount = 0;

    try {
      const candidates = await this.db.queryMany<{
        id: string;
        status: VisitorStatus;
        visitor_pass_id: string | null;
        expected_until: string | null;
      }>(
        `select id, status, visitor_pass_id, expected_until
           from public.visitors
          where tenant_id = $1
            and building_id = $2
            and status in ('expected', 'arrived', 'in_meeting')
            and expected_until is not null
            and expected_until < now()`,
        [tenantId, buildingId],
      );

      // All transitions run inside a tenant-scoped context for the
      // entire batch.
      await TenantContext.run(
        { id: tenantId, slug: 'eod_sweep', tier: 'standard' },
        async () => {
          for (const visitor of candidates) {
            try {
              if (visitor.status === 'expected') {
                await this.visitors.transitionStatus(
                  visitor.id,
                  'no_show',
                  { user_id: 'eod_sweep', person_id: null },
                );
                noShowCount++;
              } else {
                // arrived | in_meeting → checked_out (auto)
                await this.visitors.transitionStatus(
                  visitor.id,
                  'checked_out',
                  { user_id: 'eod_sweep', person_id: null },
                  { checkout_source: 'eod_sweep' },
                );
                autoCheckedOutCount++;
                if (visitor.visitor_pass_id) {
                  try {
                    await this.passPool.markPassMissing(
                      visitor.visitor_pass_id,
                      tenantId,
                      'unreturned via eod sweep',
                    );
                    passesFlaggedCount++;
                  } catch (err) {
                    // Pass marking is auxiliary — visitor was checked out;
                    // a pass that couldn't be marked is logged but
                    // doesn't block the sweep.
                    this.log.warn(
                      `markPassMissing failed for visitor ${visitor.id}: ${
                        (err as Error).message
                      }`,
                    );
                  }
                }
              }
            } catch (err) {
              // Per-visitor failures don't roll the whole sweep back —
              // the next tick (or a manual run) will retry.
              this.log.warn(
                `transitionStatus failed for visitor ${visitor.id}: ${
                  (err as Error).message
                }`,
              );
            }
          }
        },
      );

      // Audit summary per building.
      try {
        await this.db.query(
          `insert into public.audit_events
              (tenant_id, event_type, entity_type, entity_id, details)
            values ($1, 'visitor.eod_swept', 'space', $2, $3::jsonb)`,
          [
            tenantId,
            buildingId,
            JSON.stringify({
              building_id: buildingId,
              sweep_date: sweepDate,
              no_show_count: noShowCount,
              auto_checked_out_count: autoCheckedOutCount,
              passes_flagged_count: passesFlaggedCount,
            }),
          ],
        );
      } catch (err) {
        this.log.warn(
          `audit insert visitor.eod_swept failed: ${(err as Error).message}`,
        );
      }
    } finally {
      // Mark the lease released — the unique index on lease_key still
      // blocks future acquires, so this is informational only. We DO
      // NOT delete the row: deletion would let the same date be swept
      // twice.
      await this.markLeaseReleased(leaseKey, {
        no_show_count: noShowCount,
        auto_checked_out_count: autoCheckedOutCount,
        passes_flagged_count: passesFlaggedCount,
      });
    }

    return {
      building_id: buildingId,
      skipped: false,
      no_show_count: noShowCount,
      auto_checked_out_count: autoCheckedOutCount,
      passes_flagged_count: passesFlaggedCount,
    };
  }

  // ─── lease helpers ──────────────────────────────────────────────────────

  /**
   * Insert a `task_leases` row. Returns true if we acquired (no prior
   * row for this key), false if conflict. Uses `ON CONFLICT DO NOTHING`
   * so a concurrent worker's row doesn't raise — we just lose the race.
   */
  private async tryAcquireLease(
    leaseKey: string,
    tenantId: string,
  ): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `insert into public.task_leases (tenant_id, lease_key, acquired_by)
       values ($1, $2, $3)
       on conflict (lease_key) do nothing
       returning id`,
      [tenantId, leaseKey, this.workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async markLeaseReleased(
    leaseKey: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.db.query(
        `update public.task_leases
            set released_at = now(),
                result = $2
          where lease_key = $1`,
        [leaseKey, JSON.stringify({ result: 'ok', ...payload })],
      );
    } catch (err) {
      // Lease release is informational; failure here does NOT affect
      // idempotency (the row exists; the unique index still blocks
      // re-runs).
      this.log.warn(
        `markLeaseReleased failed for ${leaseKey}: ${(err as Error).message}`,
      );
    }
  }
}

export interface EodSweepResult {
  building_id: string;
  skipped: boolean;
  no_show_count: number;
  auto_checked_out_count: number;
  passes_flagged_count: number;
}
