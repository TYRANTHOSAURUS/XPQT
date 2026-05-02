import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  forwardRef,
} from '@nestjs/common';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';
import { HostNotificationService } from './host-notification.service';
import { InvitationService } from './invitation.service';
import { VisitorPassPoolService, type VisitorPassPool } from './pass-pool.service';
import { VisitorMailDeliveryAdapter, type BouncedInviteRow } from './visitor-mail-delivery.adapter';
import { VisitorService } from './visitor.service';
import type {
  DailyListEntry,
  QuickAddWalkupDto,
  ReceptionActor,
  ReceptionVisitorRow,
  TodayView,
  YesterdayLooseEnds,
} from './dto/reception.dto';
import type { VisitorStatus } from './dto/transition-status.dto';

/**
 * Reception workspace backend — the surface behind `/reception/*`.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §7
 *
 * Composition (this service does NOT own state machine writes — every
 * status change routes through VisitorService.transitionStatus):
 *   - VisitorService — status transitions (markArrived, markCheckedOut,
 *     markNoShow).
 *   - InvitationService — quickAddWalkup creates the visitor row, then
 *     this service immediately transitions to 'arrived'.
 *   - VisitorPassPoolService — pass return / mark-missing on checkout.
 *   - HostNotificationService — fan-out on arrival (slice 2d controller
 *     can call notifyArrival; for the walkup path the immediate transition
 *     to 'arrived' would normally fire it, but transitionStatus only emits
 *     a domain_event today; reception calls it directly to keep the 9am
 *     UX synchronous).
 *
 * Visibility: every list endpoint goes through `visitor_visibility_ids()`
 * (the SQL function from migration 00255). The 3-tier model gates:
 *   1. Hosts see own visits.
 *   2. Operators with `visitors.reception` see visits in their location scope.
 *   3. Override `visitors.read_all` sees everything in the tenant.
 *
 * Search: `pg_trgm`-based fuzzy match. Existing extension confirmed
 * (migration 00136). Fallback: ILIKE substring if the trigram path
 * returns 0 results — covers very short queries where similarity()
 * thresholds bite.
 */

interface VisitorRowDb {
  visitor_id: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  primary_host_first_name: string | null;
  primary_host_last_name: string | null;
  expected_at: string | null;
  arrived_at: string | null;
  status: VisitorStatus;
  visitor_pass_id: string | null;
  pass_number: string | null;
  visitor_type_id: string | null;
}

const SELECT_VISITOR_COLUMNS = `
  v.id              as visitor_id,
  v.first_name      as first_name,
  v.last_name       as last_name,
  v.company         as company,
  hp.first_name     as primary_host_first_name,
  hp.last_name      as primary_host_last_name,
  v.expected_at     as expected_at,
  v.arrived_at      as arrived_at,
  v.status          as status,
  v.visitor_pass_id as visitor_pass_id,
  pp.pass_number    as pass_number,
  v.visitor_type_id as visitor_type_id
`;

const VISITOR_FROM_JOIN = `
  from public.visitors v
  left join public.persons hp
    on hp.id = v.primary_host_person_id
   and hp.tenant_id = v.tenant_id
  left join public.visitor_pass_pool pp
    on pp.id = v.visitor_pass_id
   and pp.tenant_id = v.tenant_id
`;

const ARRIVAL_RECENT_WINDOW_MINUTES = 30;

@Injectable()
export class ReceptionService {
  private readonly log = new Logger(ReceptionService.name);

  constructor(
    private readonly db: DbService,
    private readonly visitors: VisitorService,
    @Inject(forwardRef(() => InvitationService))
    private readonly invitations: InvitationService,
    private readonly passPool: VisitorPassPoolService,
    private readonly hostNotifications: HostNotificationService,
    private readonly mailDelivery: VisitorMailDeliveryAdapter,
  ) {}

  /**
   * Today-view buckets for `/reception/today` (spec §7.3). Filtered
   * through `visitor_visibility_ids(p_user_id, p_tenant_id)` so a
   * reception user with location-scoped permission only sees their
   * building's visitors.
   */
  async today(
    tenantId: string,
    buildingId: string,
    userId: string,
  ): Promise<TodayView> {
    this.assertTenant(tenantId);
    const now = new Date();
    const arrivedSince = new Date(now.getTime() - ARRIVAL_RECENT_WINDOW_MINUTES * 60_000).toISOString();
    const dayStart = startOfDay(now).toISOString();
    const dayEnd = endOfDay(now).toISOString();

    // 'arrived' rows are returned regardless of arrived_at age — the
    // 30-minute window only controls the `currently_arriving` bucket
    // label. Older arrived rows go into the 'in_meeting' bucket (the
    // frontend's `buildTodayBuckets` then re-routes them to `onSite`
    // based on status + arrived_at, keeping a single source of truth
    // for the receptionist's mental model). Without this, a visitor
    // who arrived 31+ minutes ago and was never transitioned to
    // 'in_meeting' silently disappears from the today view.
    const sql = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      )
      select
        ${SELECT_VISITOR_COLUMNS},
        case
          when v.status = 'arrived' and v.arrived_at >= $4 then 'currently_arriving'
          when v.status = 'arrived' then 'in_meeting'
          when v.status = 'expected' and v.expected_at >= $5 and v.expected_at <= $6 then 'expected'
          when v.status = 'in_meeting' then 'in_meeting'
          when v.status = 'checked_out' and v.checked_out_at >= $5 and v.checked_out_at <= $6 then 'checked_out_today'
          else null
        end as bucket
      ${VISITOR_FROM_JOIN}
      where v.tenant_id = $2
        and v.building_id = $3
        and v.id in (select id from visible)
        and (
          (v.status = 'arrived') or
          (v.status = 'expected'     and v.expected_at     >= $5 and v.expected_at     <= $6) or
          (v.status = 'in_meeting') or
          (v.status = 'checked_out'  and v.checked_out_at  >= $5 and v.checked_out_at  <= $6)
        )
      order by coalesce(v.expected_at, v.arrived_at) asc
    `;

    const rows = await this.db.queryMany<VisitorRowDb & { bucket: string | null }>(
      sql,
      [userId, tenantId, buildingId, arrivedSince, dayStart, dayEnd],
    );

    const view: TodayView = {
      building_id: buildingId,
      generated_at: now.toISOString(),
      currently_arriving: [],
      expected: [],
      in_meeting: [],
      checked_out_today: [],
    };

    for (const row of rows) {
      const mapped = mapRow(row);
      switch (row.bucket) {
        case 'currently_arriving':
          view.currently_arriving.push(mapped);
          break;
        case 'expected':
          view.expected.push(mapped);
          break;
        case 'in_meeting':
          view.in_meeting.push(mapped);
          break;
        case 'checked_out_today':
          view.checked_out_today.push(mapped);
          break;
        default:
          // Bucket null means the row matches the WHERE but doesn't fit
          // a clean bucket (e.g. arrived but past the recent window).
          // We drop it from the view rather than inventing a bucket.
          break;
      }
    }

    return view;
  }

  /**
   * Search today's visitors by name / company / host name. Uses pg_trgm
   * `similarity()` with a 0.2 threshold — low enough to match "marl" →
   * "Marleen", high enough to filter noise. Falls back to ILIKE
   * substring match if the trigram path returns 0 rows so very short
   * queries (1–2 chars) still surface results.
   *
   * Perf (full-review I11):
   *   The previous shape called similarity() 10 times per row (5 in
   *   WHERE + 5 in SELECT/ORDER BY). Postgres doesn't memoize a STABLE
   *   function across the SELECT/WHERE planner boundary, so at 10K+
   *   visitors we paid 10x the trigram cost on every row. Refactor:
   *     1. compute similarity scores once per row in a `scored` CTE.
   *     2. Pre-filter the candidate set with the `%` operator (uses the
   *        pg_trgm GIN index) before scoring — only rows that pass the
   *        trigram-index match need similarity() at all.
   *     3. WHERE / ORDER BY filter+sort against the precomputed columns.
   *     4. Pre-narrow the visible set by joining on the LATERAL function
   *        call, so the final scan is over a small candidate cohort.
   *
   *   Net effect at 10K visitors / building / day: trigram-index seek
   *   prunes the cohort to ~tens of rows, similarity() runs 5× per
   *   row but only on those, and the final ORDER BY sorts the small set.
   */
  async search(
    tenantId: string,
    buildingId: string,
    userId: string,
    query: string,
  ): Promise<ReceptionVisitorRow[]> {
    this.assertTenant(tenantId);
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const dayStart = startOfDay(new Date()).toISOString();
    const dayEnd = endOfDay(new Date()).toISOString();

    // pg_trgm path. similarity() across name/company/host fields, take
    // top 20 by best-match score.
    //
    // The `%` operator below is pg_trgm's index-using "approximate
    // match" — uses the GIN trigram index from migration 00264. The
    // similarity threshold for `%` is set by the per-session
    // `pg_trgm.similarity_threshold` GUC (default 0.3). We keep the
    // explicit `score > 0.2` filter on the computed column so the
    // ranking threshold remains stable across sessions; the `%` is a
    // pure index-prune over the day's visitor set.
    const trigramSql = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      ),
      candidates as (
        select v.id
          from public.visitors v
          left join public.persons hp
            on hp.id = v.primary_host_person_id
           and hp.tenant_id = v.tenant_id
         where v.tenant_id = $2
           and v.building_id = $3
           and v.id in (select id from visible)
           and (
             (v.status = 'expected'    and v.expected_at >= $5 and v.expected_at <= $6) or
             v.status in ('arrived', 'in_meeting')
           )
           and (
             coalesce(v.first_name,'')    % $4
             or coalesce(v.last_name,'')  % $4
             or coalesce(v.company,'')    % $4
             or coalesce(hp.first_name,'') % $4
             or coalesce(hp.last_name,'') % $4
           )
      ),
      scored as (
        select
          ${SELECT_VISITOR_COLUMNS},
          greatest(
            similarity(coalesce(v.first_name,''),  $4),
            similarity(coalesce(v.last_name,''),   $4),
            similarity(coalesce(v.company,''),     $4),
            similarity(coalesce(hp.first_name,''), $4),
            similarity(coalesce(hp.last_name,''),  $4)
          ) as score
        ${VISITOR_FROM_JOIN}
        where v.id in (select id from candidates)
      )
      select * from scored
       where score > 0.2
       order by score desc
       limit 20
    `;

    let rows = await this.db.queryMany<VisitorRowDb & { score: number }>(
      trigramSql,
      [userId, tenantId, buildingId, trimmed, dayStart, dayEnd],
    );

    if (rows.length === 0) {
      // Fallback: ILIKE substring. The 9am-rush UX requires SOMETHING
      // for short queries — pg_trgm's 0.2 threshold is too aggressive
      // for 1–2 character inputs.
      const pattern = `%${trimmed}%`;
      const ilikeSql = `
        with visible as (
          select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
        )
        select ${SELECT_VISITOR_COLUMNS}, 0::float as score
        ${VISITOR_FROM_JOIN}
        where v.tenant_id = $2
          and v.building_id = $3
          and v.id in (select id from visible)
          and (
            (v.status = 'expected'    and v.expected_at >= $5 and v.expected_at <= $6) or
            v.status in ('arrived', 'in_meeting')
          )
          and (
            v.first_name  ilike $4 or
            v.last_name   ilike $4 or
            v.company     ilike $4 or
            hp.first_name ilike $4 or
            hp.last_name  ilike $4
          )
        order by coalesce(v.expected_at, v.arrived_at) asc
        limit 20
      `;
      rows = await this.db.queryMany<VisitorRowDb & { score: number }>(
        ilikeSql,
        [userId, tenantId, buildingId, pattern, dayStart, dayEnd],
      );
    }

    return rows.map(mapRow);
  }

  /**
   * Walk-up at the desk (spec §7.4). Reception types in the visitor
   * details, picks the host, and submits. Service:
   *   1. Loads the visitor type. Rejects when allow_walk_up=false or
   *      requires_approval=true (per Q3 lock D).
   *   2. Calls InvitationService.create() to materialize the visitor +
   *      visitor_hosts row at status='expected'. expected_at is the
   *      input arrival time (or now); expected_until uses the type
   *      default offset.
   *   3. Immediately transitions the visitor to 'arrived' via
   *      VisitorService.transitionStatus — passing through opts.arrived_at
   *      so reception's "actually arrived at 09:15, logging now" UX
   *      records both timestamps distinctly.
   *   4. Fires HostNotificationService.notifyArrival inline so the host
   *      sees the in-app + email + SSE event without waiting for a worker.
   */
  async quickAddWalkup(
    tenantId: string,
    buildingId: string,
    dto: QuickAddWalkupDto,
    actor: ReceptionActor,
  ): Promise<{ visitor_id: string }> {
    this.assertTenant(tenantId);
    if (actor.tenant_id !== tenantId) {
      throw new BadRequestException('actor tenant mismatch');
    }
    const arrivedAt = dto.arrived_at ?? new Date().toISOString();
    this.assertArrivedAtBound(arrivedAt);

    // 1. Load visitor type and gate on the flags.
    const type = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      requires_approval: boolean;
      allow_walk_up: boolean;
      default_expected_until_offset_minutes: number | null;
      active: boolean;
    }>(
      `select id, tenant_id, requires_approval, allow_walk_up,
              default_expected_until_offset_minutes, active
         from public.visitor_types
        where id = $1 and tenant_id = $2 and active = true`,
      [dto.visitor_type_id, tenantId],
    );
    if (!type) {
      throw new NotFoundException(`visitor_type ${dto.visitor_type_id} not found or inactive`);
    }
    if (!type.allow_walk_up) {
      throw new BadRequestException('Walk-ups are disabled for this visitor type');
    }
    if (type.requires_approval) {
      throw new BadRequestException(
        'This visitor type requires approval — walk-ups disabled. Ask the host to pre-invite.',
      );
    }

    // 2. Create the invitation (visitor + visitor_hosts + cancel token).
    // expected_at = arrived_at so the §5 logged_after_arrived CHECK
    // (logged_at >= arrived_at) is trivially satisfied; the
    // InvitationService writes status='expected' (since requires_approval=false
    // here) so the §5 transition expected → arrived is valid.
    const invite = await this.invitations.create(
      {
        first_name: dto.first_name,
        last_name: dto.last_name,
        email: dto.email,
        phone: dto.phone,
        company: dto.company,
        visitor_type_id: dto.visitor_type_id,
        expected_at: arrivedAt,
        building_id: buildingId,
        co_host_person_ids: [dto.primary_host_person_id]
          .filter((id) => id !== actor.person_id),
      },
      { user_id: actor.user_id, person_id: dto.primary_host_person_id, tenant_id: tenantId },
    );

    // 3. Transition to 'arrived' in the receptionist's name. The actor
    // here is the reception user, NOT the host — so the audit captures
    // who logged the arrival (per spec §7.5 backdated logging UX).
    await this.visitors.transitionStatus(
      invite.visitor_id,
      'arrived',
      { user_id: actor.user_id, person_id: actor.person_id },
      { arrived_at: arrivedAt },
    );

    // 4. Fan-out host notifications synchronously.
    try {
      await this.hostNotifications.notifyArrival(invite.visitor_id, tenantId);
    } catch (err) {
      // Non-fatal — visitor is created + arrived; the worst case is
      // host doesn't get pinged immediately, reception can re-page.
      this.log.warn(
        `notifyArrival failed for walkup visitor ${invite.visitor_id}: ${(err as Error).message}`,
      );
    }

    return { visitor_id: invite.visitor_id };
  }

  /**
   * Mark an expected visitor as arrived. Default arrived_at = now.
   * Backdated entry (spec §7.5): reception can specify an earlier
   * timestamp, but never future, and never more than 24h before
   * expected_at (sanity bound to catch typos like "08:55" → "20:55").
   */
  async markArrived(
    tenantId: string,
    visitorId: string,
    actor: { user_id: string; person_id: string | null },
    opts: { arrived_at?: string } = {},
  ): Promise<void> {
    this.assertTenant(tenantId);
    const arrivedAt = opts.arrived_at ?? new Date().toISOString();
    this.assertArrivedAtBound(arrivedAt);

    const expectedAt = await this.loadVisitorExpectedAt(visitorId, tenantId);
    if (expectedAt) {
      const expectedMs = new Date(expectedAt).getTime();
      const arrivedMs = new Date(arrivedAt).getTime();
      // Sanity: arrived no more than 24h before expected.
      if (arrivedMs < expectedMs - 24 * 60 * 60 * 1000) {
        throw new BadRequestException(
          'arrived_at is more than 24h before expected_at — looks like a typo',
        );
      }
    }

    await this.visitors.transitionStatus(visitorId, 'arrived', actor, { arrived_at: arrivedAt });

    // Fire host notifications inline. transitionStatus emits the
    // domain_event; reception still calls notifyArrival here so the
    // 9am-rush UX is synchronous.
    try {
      await this.hostNotifications.notifyArrival(visitorId, tenantId);
    } catch (err) {
      this.log.warn(
        `notifyArrival failed for ${visitorId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Mark checked out (spec §7.6). If the visitor holds a pass, the
   * caller must say whether the pass was returned. We never assume:
   *   - pass_returned=true  → passPool.returnPass()  (back to available)
   *   - pass_returned=false → passPool.markPassMissing(reason='checked out without returning')
   */
  async markCheckedOut(
    tenantId: string,
    visitorId: string,
    actor: { user_id: string; person_id: string | null },
    opts: { checkout_source: 'reception' | 'host'; pass_returned?: boolean },
  ): Promise<void> {
    this.assertTenant(tenantId);
    if (opts.checkout_source !== 'reception' && opts.checkout_source !== 'host') {
      throw new BadRequestException(
        'checkout_source must be "reception" or "host" for this surface',
      );
    }

    const visitor = await this.db.queryOne<{ id: string; tenant_id: string; visitor_pass_id: string | null }>(
      `select id, tenant_id, visitor_pass_id from public.visitors where id = $1`,
      [visitorId],
    );
    if (!visitor) throw new NotFoundException(`visitor ${visitorId} not found`);
    if (visitor.tenant_id !== tenantId) throw new NotFoundException(`visitor ${visitorId} not found`);

    await this.visitors.transitionStatus(visitorId, 'checked_out', actor, {
      checkout_source: opts.checkout_source,
      visitor_pass_id: visitor.visitor_pass_id ?? undefined,
    });

    if (visitor.visitor_pass_id) {
      if (opts.pass_returned === true) {
        await this.passPool.returnPass(visitor.visitor_pass_id, tenantId);
      } else if (opts.pass_returned === false) {
        await this.passPool.markPassMissing(
          visitor.visitor_pass_id,
          tenantId,
          'visitor checked out without returning pass',
        );
      }
      // pass_returned=undefined → leave pass state alone; the desk can
      // reconcile from the reception "loose ends" tile later.
    }
  }

  async markNoShow(
    tenantId: string,
    visitorId: string,
    actor: { user_id: string; person_id: string | null },
  ): Promise<void> {
    this.assertTenant(tenantId);
    await this.visitors.transitionStatus(visitorId, 'no_show', actor);
  }

  /**
   * Reception start-of-shift tile (spec §7.7). Aggregates:
   *   - Yesterday's auto_checked_out visitors (count).
   *   - Pool rows lost in the last 24h (delegated to passPool).
   *   - Visitors with a recent email-bounced event (TODO: depends on
   *     VisitorMailDeliveryAdapter from slice 2c — return [] for now).
   */
  async yesterdayLooseEnds(
    tenantId: string,
    buildingId: string,
    userId: string,
  ): Promise<YesterdayLooseEnds> {
    this.assertTenant(tenantId);
    const now = new Date();
    const yesterdayStart = new Date(startOfDay(now).getTime() - 24 * 60 * 60 * 1000);
    const yesterdayEnd = new Date(yesterdayStart.getTime() + 24 * 60 * 60 * 1000);

    const visibleSql = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      )
      select count(*)::int as auto_checked_out_count
        from public.visitors v
       where v.tenant_id = $2
         and v.building_id = $3
         and v.id in (select id from visible)
         and v.auto_checked_out = true
         and v.checked_out_at >= $4
         and v.checked_out_at <  $5
    `;
    const counts = await this.db.queryOne<{ auto_checked_out_count: number }>(
      visibleSql,
      [userId, tenantId, buildingId, yesterdayStart.toISOString(), yesterdayEnd.toISOString()],
    );

    let unreturnedPasses: VisitorPassPool[] = [];
    try {
      unreturnedPasses = await this.passPool.unreturnedPassesForBuilding(
        buildingId,
        tenantId,
        yesterdayStart,
      );
    } catch (err) {
      // Don't fail the whole tile because the pass query blew up — a
      // building without a configured pool simply has no unreturned
      // passes to surface.
      this.log.warn(
        `unreturnedPassesForBuilding failed: ${(err as Error).message}`,
      );
    }

    let bouncedEmails: BouncedInviteRow[] = [];
    try {
      bouncedEmails = await this.mailDelivery.bouncedInvitesForBuildingSince(
        buildingId,
        tenantId,
        yesterdayStart,
      );
    } catch (err) {
      // Same containment as the pass query — a delivery event lookup
      // failure should not nuke the whole tile.
      this.log.warn(
        `bouncedInvitesForBuildingSince failed: ${(err as Error).message}`,
      );
    }

    return {
      auto_checked_out_count: counts?.auto_checked_out_count ?? 0,
      unreturned_passes: unreturnedPasses,
      bounced_emails: bouncedEmails,
    };
  }

  /**
   * Daily list view (spec §7.8) — today's expected/arrived/in-meeting at
   * this building, ordered by expected_at. Same data as today() but
   * flat so the print page can render one big table without bucket UI.
   */
  async dailyListForBuilding(
    tenantId: string,
    buildingId: string,
    userId: string,
  ): Promise<DailyListEntry[]> {
    this.assertTenant(tenantId);
    const now = new Date();
    const dayStart = startOfDay(now).toISOString();
    const dayEnd = endOfDay(now).toISOString();

    const sql = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      )
      select ${SELECT_VISITOR_COLUMNS}
      ${VISITOR_FROM_JOIN}
      where v.tenant_id = $2
        and v.building_id = $3
        and v.id in (select id from visible)
        and (
          (v.status = 'expected'    and v.expected_at >= $4 and v.expected_at <= $5) or
          v.status in ('arrived', 'in_meeting')
        )
      order by coalesce(v.expected_at, v.arrived_at) asc
    `;

    const rows = await this.db.queryMany<VisitorRowDb>(
      sql,
      [userId, tenantId, buildingId, dayStart, dayEnd],
    );
    return rows.map(mapRow);
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private assertTenant(tenantId: string): void {
    const ctx = TenantContext.current();
    if (ctx.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }
  }

  private assertArrivedAtBound(arrivedAt: string): void {
    const ts = new Date(arrivedAt).getTime();
    if (Number.isNaN(ts)) {
      throw new BadRequestException('arrived_at is not a valid timestamp');
    }
    if (ts > Date.now() + 60_000) {
      // Allow a 60s skew window for clients with slightly fast clocks.
      throw new BadRequestException('arrived_at cannot be in the future');
    }
  }

  private async loadVisitorExpectedAt(
    visitorId: string,
    tenantId: string,
  ): Promise<string | null> {
    const row = await this.db.queryOne<{ expected_at: string | null; tenant_id: string }>(
      `select expected_at, tenant_id from public.visitors where id = $1`,
      [visitorId],
    );
    if (!row) throw new NotFoundException(`visitor ${visitorId} not found`);
    if (row.tenant_id !== tenantId) {
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    return row.expected_at;
  }
}

function mapRow(r: VisitorRowDb): ReceptionVisitorRow {
  return {
    visitor_id: r.visitor_id,
    first_name: r.first_name,
    last_name: r.last_name,
    company: r.company,
    primary_host_first_name: r.primary_host_first_name,
    primary_host_last_name: r.primary_host_last_name,
    expected_at: r.expected_at,
    arrived_at: r.arrived_at,
    status: r.status,
    visitor_pass_id: r.visitor_pass_id,
    pass_number: r.pass_number,
    visitor_type_id: r.visitor_type_id,
  };
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(23, 59, 59, 999);
  return out;
}
