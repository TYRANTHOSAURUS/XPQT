import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { RuleResolverService, RuleRow } from './rule-resolver.service';
import type { ImpactPreviewDraftDto } from './dto';

/**
 * "If this rule had been live for the last 30 days, here's what it would have
 * changed."
 *
 * Implementation strategy: replay the candidate rule against every reservation
 * in the last 30 days that targets a room within the rule's scope. The
 * resolver knows how to filter by scope; we feed it one synthetic scenario
 * per reservation and accumulate.
 *
 * We bound the work at 1 000 reservations per preview — past that we still
 * return aggregate counts but stop sampling. This keeps the page snappy for
 * busy tenants while still being honest about the impact on a representative
 * window.
 */

const REPLAY_LIMIT = 1000;
const SAMPLE_LIMIT = 20;

export interface ImpactBreakdownRow {
  id: string;
  name: string;
  count: number;
}

export interface ImpactPreviewResult {
  affected_count: number;
  denied_count: number;
  approval_required_count: number;
  warned_count: number;
  sample_affected_bookings: Array<{
    reservation_id: string;
    space_id: string;
    requester_person_id: string;
    start_at: string;
    end_at: string;
    effect: 'deny' | 'require_approval' | 'warn';
  }>;
  breakdown_by_room: ImpactBreakdownRow[];
  breakdown_by_requester: ImpactBreakdownRow[];
  /** True when the replay hit REPLAY_LIMIT and stopped early. */
  truncated: boolean;
}

interface ReservationRow {
  id: string;
  space_id: string;
  requester_person_id: string;
  start_at: string;
  end_at: string;
  attendee_count: number | null;
  status: string;
}

@Injectable()
export class ImpactPreviewService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly resolver: RuleResolverService,
  ) {}

  /** Preview a saved rule by id. Loads it from the table and forwards. */
  async previewById(ruleId: string): Promise<ImpactPreviewResult> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('room_booking_rules')
      .select('*')
      .eq('id', ruleId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error(`Rule ${ruleId} not found`);
    return this.previewRule(data as RuleRow);
  }

  /** Preview a draft (unsaved) rule shape. */
  async previewDraft(dto: ImpactPreviewDraftDto): Promise<ImpactPreviewResult> {
    const tenant = TenantContext.current();
    const draft: RuleRow = {
      id: 'draft',
      tenant_id: tenant.id,
      name: 'Draft rule',
      target_scope: dto.target_scope,
      target_id: dto.target_id ?? null,
      applies_when: dto.applies_when,
      effect: dto.effect,
      approval_config: null,
      denial_message: null,
      priority: dto.priority ?? 100,
      active: true,
      template_id: null,
    };
    return this.previewRule(draft);
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private async previewRule(rule: RuleRow): Promise<ImpactPreviewResult> {
    const tenant = TenantContext.current();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Pre-filter reservations by scope when feasible. For room scope we can
    // index directly. For subtree, we expand via space_descendants RPC. For
    // tenant + room_type, we can't cheaply pre-filter, so we replay all
    // reservations in the window (capped at REPLAY_LIMIT).
    const reservations = await this.loadCandidateReservations(rule, since);

    const truncated = reservations.length >= REPLAY_LIMIT;

    let denied = 0;
    let approval = 0;
    let warned = 0;
    const sample: ImpactPreviewResult['sample_affected_bookings'] = [];
    const byRoom = new Map<string, number>();
    const byRequester = new Map<string, number>();

    for (const r of reservations) {
      // Evaluate THIS rule alone against the reservation. We use the
      // resolver's evaluateAdHoc but pass only this rule so we attribute
      // effects cleanly to it.
      const outcome = await this.resolver.evaluateAdHoc([rule], {
        requester_person_id: r.requester_person_id,
        space_id: r.space_id,
        start_at: r.start_at,
        end_at: r.end_at,
        attendee_count: r.attendee_count,
      });

      if (outcome.matchedRules.length === 0) continue;

      const matched = outcome.matchedRules[0];
      if (matched.effect === 'deny') denied += 1;
      else if (matched.effect === 'require_approval') approval += 1;
      else if (matched.effect === 'warn') warned += 1;
      else continue; // allow_override doesn't change state on its own

      byRoom.set(r.space_id, (byRoom.get(r.space_id) ?? 0) + 1);
      byRequester.set(r.requester_person_id, (byRequester.get(r.requester_person_id) ?? 0) + 1);

      if (sample.length < SAMPLE_LIMIT) {
        sample.push({
          reservation_id: r.id,
          space_id: r.space_id,
          requester_person_id: r.requester_person_id,
          start_at: r.start_at,
          end_at: r.end_at,
          effect: matched.effect as 'deny' | 'require_approval' | 'warn',
        });
      }
    }

    // Hydrate breakdown labels (room name, person name) so the admin UI
    // doesn't need a follow-up batch.
    const [roomNames, requesterNames] = await Promise.all([
      this.fetchSpaceNames(tenant.id, [...byRoom.keys()]),
      this.fetchPersonNames(tenant.id, [...byRequester.keys()]),
    ]);

    const affected = denied + approval + warned;
    return {
      affected_count: affected,
      denied_count: denied,
      approval_required_count: approval,
      warned_count: warned,
      sample_affected_bookings: sample,
      breakdown_by_room: [...byRoom.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ id, name: roomNames.get(id) ?? id, count })),
      breakdown_by_requester: [...byRequester.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id, count]) => ({ id, name: requesterNames.get(id) ?? id, count })),
      truncated,
    };
  }

  private async loadCandidateReservations(
    rule: RuleRow,
    since: string,
  ): Promise<ReservationRow[]> {
    const tenant = TenantContext.current();
    // Post-canonicalisation (2026-05-02): per-room holdings live on
    // `booking_slots` (00277:116). The legacy ReservationRow shape
    // (id/space_id/requester_person_id/start_at/end_at/attendee_count/status)
    // splits across slot + parent booking now — join via embedded select
    // and flatten back to the legacy shape so the caller's eval loop is
    // unchanged.
    const base = this.supabase.admin
      .from('booking_slots')
      .select(
        'id, space_id, start_at, end_at, attendee_count, status, ' +
          'booking:bookings!booking_id(requester_person_id)',
      )
      .eq('tenant_id', tenant.id)
      .gte('start_at', since)
      .order('start_at', { ascending: false })
      .limit(REPLAY_LIMIT);

    type SlotJoinRow = {
      id: string;
      space_id: string;
      start_at: string;
      end_at: string;
      attendee_count: number | null;
      status: string;
      booking:
        | { requester_person_id: string }
        | { requester_person_id: string }[]
        | null;
    };

    const flatten = (rows: SlotJoinRow[]): ReservationRow[] =>
      rows
        .map((r) => {
          const b = Array.isArray(r.booking) ? r.booking[0] ?? null : r.booking;
          if (!b?.requester_person_id) return null;
          return {
            id: r.id,
            space_id: r.space_id,
            requester_person_id: b.requester_person_id,
            start_at: r.start_at,
            end_at: r.end_at,
            attendee_count: r.attendee_count,
            status: r.status,
          } satisfies ReservationRow;
        })
        .filter((r): r is ReservationRow => r !== null);

    if (rule.target_scope === 'room' && rule.target_id) {
      const { data, error } = await base.eq('space_id', rule.target_id);
      if (error) throw error;
      return flatten((data ?? []) as unknown as SlotJoinRow[]);
    }

    if (rule.target_scope === 'space_subtree' && rule.target_id) {
      // Pull every descendant space id (including the root), then filter
      // slots in TS — Supabase JS doesn't compose .in() with a sub-select
      // neatly.
      const { data: descIds, error: dErr } = await this.supabase.admin.rpc(
        'space_descendants',
        { root_id: rule.target_id },
      );
      if (dErr) throw dErr;
      const ids = ((descIds ?? []) as Array<string | { id?: string }>).map((row) =>
        typeof row === 'string' ? row : row?.id ?? '',
      );
      if (ids.length === 0) return [];
      const { data, error } = await base.in('space_id', ids);
      if (error) throw error;
      return flatten((data ?? []) as unknown as SlotJoinRow[]);
    }

    // tenant + room_type: replay everything in the window. The per-rule
    // evaluation will filter by type/predicate.
    const { data, error } = await base;
    if (error) throw error;
    return flatten((data ?? []) as unknown as SlotJoinRow[]);
  }

  private async fetchSpaceNames(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
      map.set(r.id, r.name);
    }
    return map;
  }

  private async fetchPersonNames(
    tenantId: string,
    ids: string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select('id, first_name, last_name')
      .eq('tenant_id', tenantId)
      .in('id', ids);
    if (error) throw error;
    const map = new Map<string, string>();
    for (const r of (data ?? []) as Array<{
      id: string;
      first_name: string | null;
      last_name: string | null;
    }>) {
      map.set(r.id, [r.first_name, r.last_name].filter(Boolean).join(' ') || r.id);
    }
    return map;
  }
}
