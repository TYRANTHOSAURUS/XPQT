import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { DbService } from '../../common/db/db.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import type { ActorContext, PickerInput, RankedRoom, Reservation, RuleOutcome } from './dto/types';
import { RankingService } from './ranking.service';

/** Slim shape returned by the scheduler-data endpoint. Drops ranking_score,
 *  ranking_reasons, and day_blocks — the desk scheduler grid never reads
 *  them, and computing them on every paint is the picker's biggest waste. */
export interface SchedulerRoom {
  space_id: string;
  name: string;
  space_type: string;
  image_url: string | null;
  capacity: number | null;
  min_attendees: number | null;
  amenities: string[];
  keywords: string[];
  parent_chain: { id: string; name: string; type: string }[];
  rule_outcome: RuleOutcome;
}

export interface SchedulerDataInput {
  start_at: string;
  end_at: string;
  attendee_count?: number;
  site_id?: string;
  building_id?: string;
  floor_id?: string;
  must_have_amenities?: string[];
  /** When set, rules are evaluated for this requester (booking-for mode in the toolbar). */
  requester_id?: string;
}

/**
 * The canonical picker query.
 *
 * Steps:
 *   1. Filter spaces by reservable + type='room' + tenant + criteria + capacity
 *   2. Compute availability for each candidate vs the requested window
 *   3. Resolve rules in bulk (RuleResolverService.resolveBulk)
 *   4. Score each candidate (RankingService.score)
 *   5. Return ranked list with mini-timeline blocks for the requested day
 *
 * Cap candidates to ~30 before rule evaluation to keep latency in budget
 * (spec §6.1: < 250 ms server, < 600 ms perceived).
 */
@Injectable()
export class ListBookableRoomsService {
  private readonly log = new Logger(ListBookableRoomsService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly db: DbService,
    private readonly ruleResolver: RuleResolverService,
    private readonly ranking: RankingService,
  ) {}

  async list(input: PickerInput, actor: ActorContext): Promise<{ rooms: RankedRoom[] }> {
    const tenantId = TenantContext.current().id;
    const requesterId = input.requester_id ?? actor.person_id;
    if (!requesterId) {
      return { rooms: [] };
    }
    // Phase K observability — emit a structured timing log per call so
    // Prometheus / log aggregators can scrape `room_booking_picker_latency_seconds`
    // without us pulling a metrics SDK in just for this. Logger output stays
    // line-oriented so Loki / DataDog / CloudWatch can parse it directly.
    const t0 = process.hrtime.bigint();

    // 1. Load candidate rooms — filter by capacity + criteria
    const candidates = await this.loadCandidateSpaces(tenantId, input);

    if (candidates.length === 0) return { rooms: [] };
    const candidateIds = candidates.map((s) => s.id);

    // 2/3/4. Run all three IO-bound phases in parallel. They each query
    // different tables and don't depend on one another's output, so the
    // pipeline goes from "candidates → conflicts → rules → parents" (4
    // sequential round-trips) to "candidates → (conflicts | rules | parents)"
    // (2 sequential, with the second wave parallel). Cuts ~150-300ms off a
    // typical desk scheduler load.
    const [conflicts, ruleOutcomes, parentChains] = await Promise.all([
      this.loadConflicts(tenantId, candidateIds, input.start_at, input.end_at),
      this.ruleResolver.resolveBulk(
        requesterId,
        candidateIds,
        { start_at: input.start_at, end_at: input.end_at },
        this.criteriaToContext(input),
      ),
      // Parent chains disambiguate same-named rooms ("Meeting Room 2.12"
      // on three different floors). Recursive CTE — one round-trip
      // regardless of tree depth (was three sequential `IN` queries).
      this.loadParentChainsBulk(tenantId, candidateIds),
    ]);

    const conflictBySpace = new Map<string, Array<{ start_at: string; end_at: string; effective_start_at: string; effective_end_at: string; status: string }>>();
    for (const c of conflicts) {
      const arr = conflictBySpace.get(c.space_id) ?? [];
      arr.push({
        start_at: c.start_at,
        end_at: c.end_at,
        effective_start_at: c.effective_start_at,
        effective_end_at: c.effective_end_at,
        status: c.status,
      });
      conflictBySpace.set(c.space_id, arr);
    }

    // 5. Score + assemble
    const requestedStartMs = new Date(input.start_at).getTime();
    const requestedEndMs = new Date(input.end_at).getTime();
    const ranked: RankedRoom[] = [];
    for (const space of candidates) {
      // Per-space conflict filter using THIS room's setup/teardown buffer.
      // The wider conflict query above pulled potential conflicts within
      // ±60 min; here we apply the actual room's buffer to determine which
      // are real conflicts vs. neighbours that merely fall in the buffer
      // window (no overlap once we apply the room's actual buffer).
      const setupMs = (space.setup_buffer_minutes ?? 0) * 60_000;
      const teardownMs = (space.teardown_buffer_minutes ?? 0) * 60_000;
      const effectiveStartMs = requestedStartMs - setupMs;
      const effectiveEndMs = requestedEndMs + teardownMs;
      const candidateConflicts = (conflictBySpace.get(space.id) ?? []).filter((c) => {
        const cStart = new Date(c.effective_start_at).getTime();
        const cEnd = new Date(c.effective_end_at).getTime();
        return cStart < effectiveEndMs && cEnd > effectiveStartMs;
      });
      const overlap = candidateConflicts.map(({ start_at, end_at, status }) => ({
        start_at,
        end_at,
        status,
      }));
      const isAvailable = overlap.length === 0;
      const ruleOutcome = ruleOutcomes.get(space.id);
      const outcome: RuleOutcome = ruleOutcome
        ? {
            effect:
              ruleOutcome.final === 'deny' ? 'deny' :
              ruleOutcome.final === 'require_approval' ? 'require_approval' :
              ruleOutcome.warnings.length ? 'warn' : 'allow',
            matched_rule_ids: ruleOutcome.matchedRules.map((r) => r.id),
            denial_message: ruleOutcome.denialMessages[0],
            warning_messages: ruleOutcome.warnings,
          }
        : { effect: 'allow', matched_rule_ids: [] };

      // Hide denied rooms from non-service-desk users
      if (outcome.effect === 'deny' && !actor.is_service_desk) continue;
      // Hide unavailable rooms — unless the caller (typically the desk
      // scheduler) has explicitly asked to keep them, in which case the
      // grid will paint the conflicting blocks itself.
      if (!isAvailable && !input.include_unavailable) continue;

      const ranking = this.ranking.score(space as never, requesterId, input);

      const s = space as {
        name: string; type: string; capacity: number | null;
        min_attendees: number | null; amenities: string[] | null;
        default_search_keywords: string[] | null;
        attributes: Record<string, unknown> | null;
      };
      const imageUrl =
        s.attributes && typeof s.attributes === 'object'
          ? (typeof s.attributes['image_url'] === 'string' ? s.attributes['image_url'] : null)
          : null;
      ranked.push({
        space_id: space.id,
        name: s.name,
        space_type: s.type,
        image_url: imageUrl,
        capacity: s.capacity,
        min_attendees: s.min_attendees,
        amenities: s.amenities ?? [],
        keywords: s.default_search_keywords ?? [],
        parent_chain: parentChains.get(space.id) ?? [],
        rule_outcome: outcome,
        ranking_score: ranking.score,
        ranking_reasons: ranking.reasons,
        day_blocks: this.buildDayBlocks(input, conflictBySpace.get(space.id) ?? []),
      });
    }

    ranked.sort((a, b) => {
      const sortMode = input.sort ?? 'best_match';
      if (sortMode === 'closest') return 0; // TODO: compute walk distance from requester default location
      if (sortMode === 'smallest_fit') {
        return (a.capacity ?? 999) - (b.capacity ?? 999);
      }
      return b.ranking_score - a.ranking_score;
    });

    // Default cap: 12 rooms. The picker is meant to surface the BEST
    // candidates, not enumerate the whole inventory; we only widen if the
    // caller asks via input.limit.
    const result = { rooms: ranked.slice(0, input.limit ?? 12) };
    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    // Spec §6.1 budget: p95 < 250 ms server. We log every call with the
    // elapsed time so a Loki/Prom job can compute the percentile, and warn
    // loudly when a single call goes >2× budget so operators see slow
    // outliers in real time.
    const tag = `picker tenant=${tenantId} candidates=${candidates.length} returned=${result.rooms.length} elapsed_ms=${elapsedMs.toFixed(1)}`;
    if (elapsedMs > 500) this.log.warn(tag);
    else this.log.log(tag);
    return result;
  }

  /**
   * Desk-scheduler "what to paint" fetch — ONE database round-trip via
   * `scheduler_data` plpgsql RPC (migration 00153). The function
   * resolves scope, filters candidates, walks parent chains via a
   * recursive CTE, and joins reservation rows with requester / host
   * names — all server-side, returning a single JSONB blob.
   *
   * The TS layer only does:
   *   - rule evaluation (when `requester_id` is set, otherwise every
   *     room defaults to `effect: allow` and the rule-resolver path
   *     is skipped entirely),
   *   - `deny` filtering for non-operator callers.
   *
   * Drops ranking_score / ranking_reasons / day_blocks since the grid
   * doesn't read them; running rule eval and a separate conflicts
   * query for those was pure latency. Typical end-to-end on remote
   * Supabase: ~10 ms server, ~50–80 ms perceived (network dominated).
   */
  async loadSchedulerData(
    input: SchedulerDataInput,
    actor: ActorContext,
  ): Promise<{ rooms: SchedulerRoom[]; reservations: Reservation[] }> {
    const tenantId = TenantContext.current().id;
    const t0 = process.hrtime.bigint();

    type RpcRoom = {
      space_id: string;
      name: string;
      space_type: string;
      image_url: string | null;
      capacity: number | null;
      min_attendees: number | null;
      amenities: string[] | null;
      keywords: string[] | null;
      parent_chain: { id: string; name: string; type: string }[];
    };
    type RpcResult = { rooms: RpcRoom[]; reservations: Reservation[] };

    const wantsRules = Boolean(input.requester_id);

    // Run the SQL function and (optionally) the rule resolver in parallel.
    // The RPC goes through `DbService` (direct Postgres via persistent
    // pool) — bypasses Supabase REST entirely, so the round-trip is
    // ~5–15 ms instead of ~80–110 ms. Rule resolver still talks to
    // Supabase REST for now; migrating it is incremental.
    const [rpcResult, ruleOutcomes] = await Promise.all([
      this.db.rpc<RpcResult>('scheduler_data', {
        p_tenant_id: tenantId,
        p_start_at: input.start_at,
        p_end_at: input.end_at,
        p_attendee_count: input.attendee_count ?? 1,
        p_site_id: input.site_id ?? null,
        p_building_id: input.building_id ?? null,
        p_floor_id: input.floor_id ?? null,
        p_must_have_amenities:
          input.must_have_amenities && input.must_have_amenities.length > 0
            ? input.must_have_amenities
            : null,
      }),
      wantsRules ? this.deferredRuleResolveBulk(input) : Promise.resolve(null),
    ]);
    const result = rpcResult ?? { rooms: [], reservations: [] };

    const rooms: SchedulerRoom[] = [];
    for (const r of result.rooms) {
      const ruleOutcome = ruleOutcomes?.get(r.space_id);
      const outcome: RuleOutcome = ruleOutcome
        ? {
            effect:
              ruleOutcome.final === 'deny' ? 'deny' :
              ruleOutcome.final === 'require_approval' ? 'require_approval' :
              ruleOutcome.warnings.length ? 'warn' : 'allow',
            matched_rule_ids: ruleOutcome.matchedRules.map((m) => m.id),
            denial_message: ruleOutcome.denialMessages[0],
            warning_messages: ruleOutcome.warnings,
          }
        : { effect: 'allow', matched_rule_ids: [] };

      if (outcome.effect === 'deny' && !actor.is_service_desk) continue;

      rooms.push({
        space_id: r.space_id,
        name: r.name,
        space_type: r.space_type,
        image_url: r.image_url,
        capacity: r.capacity,
        min_attendees: r.min_attendees,
        amenities: r.amenities ?? [],
        keywords: r.keywords ?? [],
        parent_chain: r.parent_chain ?? [],
        rule_outcome: outcome,
      });
    }

    const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
    const tag = `scheduler-data tenant=${tenantId} returned=${rooms.length} reservations=${result.reservations.length} rules=${wantsRules ? 'on' : 'off'} elapsed_ms=${elapsedMs.toFixed(1)}`;
    if (elapsedMs > 250) this.log.warn(tag);
    else this.log.log(tag);

    return { rooms, reservations: result.reservations };
  }

  /**
   * Wraps `RuleResolverService.resolveBulk` for the booking-for path. The
   * resolver needs the candidate space ids, but the SQL function returns
   * them as part of the response — so we resolve scope -> candidate ids
   * here too, just for the rule branch. Cheap (one indexed query) and
   * keeps rule eval able to run in parallel with the main RPC.
   */
  private async deferredRuleResolveBulk(input: SchedulerDataInput) {
    const tenantId = TenantContext.current().id;
    const candidates = await this.loadCandidateSpaces(tenantId, {
      start_at: input.start_at,
      end_at: input.end_at,
      attendee_count: input.attendee_count ?? 1,
      site_id: input.site_id,
      building_id: input.building_id,
      floor_id: input.floor_id,
      criteria: input.must_have_amenities?.length
        ? { must_have_amenities: input.must_have_amenities }
        : undefined,
      sort: 'best_match',
      limit: 200,
      include_unavailable: true,
    });
    if (candidates.length === 0) return null;
    return this.ruleResolver.resolveBulk(
      input.requester_id!,
      candidates.map((s) => s.id),
      { start_at: input.start_at, end_at: input.end_at },
      {
        site_id: input.site_id,
        building_id: input.building_id,
        floor_id: input.floor_id,
        must_have_amenities: input.must_have_amenities,
      },
    );
  }

  /**
   * Single-RPC parent chain lookup for the picker / scheduler. Calls the
   * `space_parent_chains` recursive CTE (migration 00152) which returns one
   * row per (space, ancestor) pair ordered by depth ascending. Falls back to
   * an empty chain on error so the UI still renders rooms — disambiguation
   * is a nice-to-have, not load-critical.
   */
  private async loadParentChainsBulk(
    tenantId: string,
    spaceIds: string[],
  ): Promise<Map<string, Array<{ id: string; name: string; type: string }>>> {
    const out = new Map<string, Array<{ id: string; name: string; type: string }>>();
    if (spaceIds.length === 0) return out;
    for (const id of spaceIds) out.set(id, []);

    const { data, error } = await this.supabase.admin.rpc('space_parent_chains', {
      p_tenant_id: tenantId,
      p_space_ids: spaceIds,
    });
    if (error) {
      this.log.warn(`loadParentChainsBulk rpc failed: ${error.message}`);
      return out;
    }
    type Row = { space_id: string; ancestor_id: string; ancestor_name: string; ancestor_type: string; depth: number };
    for (const row of (data ?? []) as Row[]) {
      const list = out.get(row.space_id);
      if (list) list.push({ id: row.ancestor_id, name: row.ancestor_name, type: row.ancestor_type });
    }
    return out;
  }

  // === helpers ===

  private async loadCandidateSpaces(tenantId: string, input: PickerInput): Promise<Array<{
    id: string;
    name: string;
    type: string;
    capacity: number | null;
    min_attendees: number | null;
    amenities: string[] | null;
    parent_id: string | null;
    default_search_keywords: string[] | null;
    attributes: Record<string, unknown> | null;
    setup_buffer_minutes: number | null;
    teardown_buffer_minutes: number | null;
  }>> {
    // Apply the most specific location filter first: floor > building > site.
    // Without this every picker call ignored the toolbar's building / floor
    // selectors and returned every reservable room in the tenant. We expand
    // the picked node via the existing `space_descendants` SQL function so
    // rooms nested arbitrarily deep (e.g. wing → floor → room) all match.
    const scopeRootId = input.floor_id ?? input.building_id ?? input.site_id ?? null;
    let allowedIds: string[] | null = null;
    if (scopeRootId) {
      const { data, error } = await this.supabase.admin.rpc('space_descendants', {
        root_id: scopeRootId,
      });
      if (error) {
        this.log.warn(`loadCandidateSpaces scope expansion failed: ${error.message}`);
        return [];
      }
      allowedIds = ((data ?? []) as Array<{ space_descendants: string } | string>).map((row) =>
        typeof row === 'string' ? row : (row as { space_descendants: string }).space_descendants,
      );
      if (allowedIds.length === 0) return [];
    }

    let q = this.supabase.admin
      .from('spaces')
      .select('id, name, type, capacity, min_attendees, amenities, parent_id, default_search_keywords, attributes, setup_buffer_minutes, teardown_buffer_minutes')
      .eq('tenant_id', tenantId)
      .eq('reservable', true)
      .eq('active', true)
      .in('type', ['room', 'meeting_room'])
      .gte('capacity', input.attendee_count)
      .or(`min_attendees.is.null,min_attendees.lte.${input.attendee_count}`)
      .limit(200);

    if (allowedIds && allowedIds.length > 0) {
      q = q.in('id', allowedIds);
    }
    if (input.criteria?.must_have_amenities?.length) {
      q = q.contains('amenities', input.criteria.must_have_amenities);
    }
    const { data, error } = await q;
    if (error) {
      this.log.warn(`loadCandidateSpaces error: ${error.message}`);
      return [];
    }
    return (data ?? []) as never;
  }

  private async loadConflicts(
    tenantId: string,
    spaceIds: string[],
    startAt: string,
    endAt: string,
  ): Promise<Array<{ space_id: string; start_at: string; end_at: string; effective_start_at: string; effective_end_at: string; status: string }>> {
    // Widen the conflict window by 60 min on each side. Why: the candidate
    // room's setup/teardown buffer expands the EFFECTIVE range we'd be
    // booking. The conflict guard at submit time rejects on the buffered
    // range, so the picker has to use the same logic — otherwise it
    // returns a "best match" room that the conflict guard then rejects
    // (the user-reported 'best match was a booked room' bug). 60 min is
    // a generous cap that covers any sane setup/teardown configuration
    // without bloating the result set; per-room filtering happens below.
    const BUFFER_CAP_MS = 60 * 60_000;
    const widenedStart = new Date(new Date(startAt).getTime() - BUFFER_CAP_MS).toISOString();
    const widenedEnd = new Date(new Date(endAt).getTime() + BUFFER_CAP_MS).toISOString();
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('space_id, start_at, end_at, effective_start_at, effective_end_at, status')
      .eq('tenant_id', tenantId)
      .in('space_id', spaceIds)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', widenedEnd)
      .gt('effective_end_at', widenedStart);
    if (error) {
      this.log.warn(`loadConflicts error: ${error.message}`);
      return [];
    }
    return (data ?? []) as never;
  }

  private criteriaToContext(input: PickerInput): Record<string, unknown> {
    return {
      site_id: input.site_id,
      building_id: input.building_id,
      floor_id: input.floor_id,
      must_have_amenities: input.criteria?.must_have_amenities,
      preferred_amenities: input.criteria?.preferred_amenities,
      smart_keywords: input.criteria?.smart_keywords,
    };
  }

  private buildDayBlocks(_input: PickerInput, conflicts: Array<{ start_at: string; end_at: string; status: string }>): Array<{
    start: string; end: string; status: 'busy' | 'pending' | 'requested'; is_yours?: boolean;
  }> {
    // Only return EXISTING bookings as day-blocks. The user's requested
    // slot is signaled by the strip's ring overlay, not by a block color —
    // otherwise rooms without conflicts look like they have one anyway.
    return conflicts.map((c) => ({
      start: c.start_at,
      end: c.end_at,
      status: c.status === 'pending_approval' ? 'pending' as const : 'busy' as const,
    }));
  }
}
