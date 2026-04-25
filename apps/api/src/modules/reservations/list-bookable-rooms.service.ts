import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService } from '../room-booking-rules/rule-resolver.service';
import type { ActorContext, PickerInput, RankedRoom, RuleOutcome } from './dto/types';
import { RankingService } from './ranking.service';

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
    private readonly ruleResolver: RuleResolverService,
    private readonly ranking: RankingService,
  ) {}

  async list(input: PickerInput, actor: ActorContext): Promise<{ rooms: RankedRoom[] }> {
    const tenantId = TenantContext.current().id;
    const requesterId = input.requester_id ?? actor.person_id;
    if (!requesterId) {
      return { rooms: [] };
    }

    // 1. Load candidate rooms — filter by capacity + criteria
    const candidates = await this.loadCandidateSpaces(tenantId, input);

    if (candidates.length === 0) return { rooms: [] };
    const candidateIds = candidates.map((s) => s.id);

    // 2. Load existing reservations on these spaces overlapping the request
    const conflicts = await this.loadConflicts(tenantId, candidateIds, input.start_at, input.end_at);
    const conflictBySpace = new Map<string, Array<{ start_at: string; end_at: string; status: string }>>();
    for (const c of conflicts) {
      const arr = conflictBySpace.get(c.space_id) ?? [];
      arr.push({ start_at: c.start_at, end_at: c.end_at, status: c.status });
      conflictBySpace.set(c.space_id, arr);
    }

    // 3. Resolve rules in bulk
    const ruleOutcomes = await this.ruleResolver.resolveBulk(
      requesterId,
      candidateIds,
      { start_at: input.start_at, end_at: input.end_at },
      this.criteriaToContext(input),
    );

    // 4. Hydrate parent chains (floor → building → site) for all candidates
    //    in one pass. Without this, rooms with the same name like "Meeting
    //    Room 2.12" are visually indistinguishable.
    const parentChains = await this.loadParentChains(tenantId, candidates);

    // 5. Score + assemble
    const ranked: RankedRoom[] = [];
    for (const space of candidates) {
      const overlap = conflictBySpace.get(space.id) ?? [];
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
      // Hide unavailable rooms
      if (!isAvailable) continue;

      const ranking = this.ranking.score(space as never, requesterId, input);

      ranked.push({
        space_id: space.id,
        name: (space as { name: string }).name,
        capacity: (space as { capacity: number | null }).capacity,
        min_attendees: (space as { min_attendees: number | null }).min_attendees,
        amenities: (space as { amenities: string[] | null }).amenities ?? [],
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
    return { rooms: ranked.slice(0, input.limit ?? 12) };
  }

  /**
   * Walk each candidate up the spaces tree (parent_id) up to 3 levels and
   * return the chain (floor / building / site) for disambiguation in the UI.
   * One round-trip: fetch all unique ancestor ids in a single IN query.
   */
  private async loadParentChains(
    tenantId: string,
    candidates: Array<{ id: string; parent_id: string | null }>,
  ): Promise<Map<string, Array<{ id: string; name: string; type: string }>>> {
    const out = new Map<string, Array<{ id: string; name: string; type: string }>>();
    const parentIds = new Set<string>();
    for (const c of candidates) {
      if (c.parent_id) parentIds.add(c.parent_id);
    }
    if (parentIds.size === 0) {
      for (const c of candidates) out.set(c.id, []);
      return out;
    }

    // Fetch up to 3 levels of ancestors. Two iterations cover floor →
    // building → site for the typical 3-level hierarchy.
    const fetched = new Map<string, { id: string; name: string; type: string; parent_id: string | null }>();
    let frontier = Array.from(parentIds);
    for (let i = 0; i < 3 && frontier.length > 0; i++) {
      const { data, error } = await this.supabase.admin
        .from('spaces')
        .select('id, name, type, parent_id')
        .eq('tenant_id', tenantId)
        .in('id', frontier);
      if (error) {
        this.log.warn(`loadParentChains error: ${error.message}`);
        break;
      }
      const next: string[] = [];
      for (const row of (data ?? []) as Array<{
        id: string; name: string; type: string; parent_id: string | null;
      }>) {
        fetched.set(row.id, row);
        if (row.parent_id && !fetched.has(row.parent_id)) next.push(row.parent_id);
      }
      frontier = next;
    }

    for (const c of candidates) {
      const chain: Array<{ id: string; name: string; type: string }> = [];
      let cursor = c.parent_id;
      let safety = 4;
      while (cursor && safety-- > 0) {
        const row = fetched.get(cursor);
        if (!row) break;
        chain.push({ id: row.id, name: row.name, type: row.type });
        cursor = row.parent_id;
      }
      out.set(c.id, chain);
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
  }>> {
    let q = this.supabase.admin
      .from('spaces')
      .select('id, name, type, capacity, min_attendees, amenities, parent_id, default_search_keywords')
      .eq('tenant_id', tenantId)
      .eq('reservable', true)
      .eq('active', true)
      .in('type', ['room', 'meeting_room'])
      .gte('capacity', input.attendee_count)
      .or(`min_attendees.is.null,min_attendees.lte.${input.attendee_count}`)
      .limit(60);

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
  ): Promise<Array<{ space_id: string; start_at: string; end_at: string; status: string }>> {
    const { data, error } = await this.supabase.admin
      .from('reservations')
      .select('space_id, start_at, end_at, status')
      .eq('tenant_id', tenantId)
      .in('space_id', spaceIds)
      .in('status', ['confirmed', 'checked_in', 'pending_approval'])
      .lt('effective_start_at', endAt)
      .gt('effective_end_at', startAt);
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

  private buildDayBlocks(input: PickerInput, conflicts: Array<{ start_at: string; end_at: string; status: string }>): Array<{
    start: string; end: string; status: 'busy' | 'pending' | 'requested'; is_yours?: boolean;
  }> {
    const blocks: Array<{ start: string; end: string; status: 'busy' | 'pending' | 'requested' }> =
      conflicts.map((c) => ({
        start: c.start_at,
        end: c.end_at,
        status: c.status === 'pending_approval' ? 'pending' : 'busy',
      }));
    blocks.push({
      start: input.start_at,
      end: input.end_at,
      status: 'requested',
    });
    return blocks;
  }
}
