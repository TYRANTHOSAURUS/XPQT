import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ChosenBy } from './resolver.types';

export interface DecisionFilter {
  limit?: number;
  offset?: number;
  chosen_by?: ChosenBy;
  ticket_id?: string;
  since?: string; // ISO timestamp
}

export interface DecisionRow {
  id: string;
  ticket_id: string;
  decided_at: string;
  strategy: string;
  chosen_by: ChosenBy;
  rule_id: string | null;
  rule_name: string | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
  context: Record<string, unknown>;
}

export interface DualRunFilter {
  limit?: number;
  offset?: number;
  hook?: 'case_owner' | 'child_dispatch';
  /** When true, only rows where target_match=false or chosen_by_match=false */
  only_divergent?: boolean;
  since?: string;
}

interface SideDecisionView {
  chosen_by: string | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
}

export interface DualRunLogRow {
  id: string;
  evaluated_at: string;
  hook: 'case_owner' | 'child_dispatch';
  mode: 'dualrun' | 'shadow' | 'v2_only';
  ticket_id: string | null;
  request_type_id: string | null;
  request_type_name: string | null;
  legacy: SideDecisionView;
  v2: SideDecisionView;
  target_match: boolean | null;
  chosen_by_match: boolean | null;
  diff_summary: Record<string, unknown>;
}

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

@Injectable()
export class RoutingAuditService {
  private readonly logger = new Logger(RoutingAuditService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async listDecisions(filter: DecisionFilter): Promise<{ rows: DecisionRow[]; total: number }> {
    const tenant = TenantContext.current();
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);

    let query = this.supabase.admin
      .from('routing_decisions')
      .select(
        `id, ticket_id, decided_at, strategy, chosen_by, rule_id,
         chosen_team_id, chosen_user_id, chosen_vendor_id, context,
         rules:routing_rules!routing_decisions_rule_id_fkey(name)`,
        { count: 'exact' },
      )
      .eq('tenant_id', tenant.id)
      .order('decided_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filter.chosen_by) query = query.eq('chosen_by', filter.chosen_by);
    if (filter.ticket_id) query = query.eq('ticket_id', filter.ticket_id);
    if (filter.since) query = query.gte('decided_at', filter.since);

    const { data, error, count } = await query;
    if (error) throw error;

    const raw = (data ?? []) as Array<Record<string, unknown>>;

    // Batch-resolve target names so we avoid N+1: one query each to teams/users/vendors
    const teamIds = new Set<string>();
    const userIds = new Set<string>();
    const vendorIds = new Set<string>();
    for (const row of raw) {
      if (row.chosen_team_id) teamIds.add(row.chosen_team_id as string);
      if (row.chosen_user_id) userIds.add(row.chosen_user_id as string);
      if (row.chosen_vendor_id) vendorIds.add(row.chosen_vendor_id as string);
    }

    const [teams, users, vendors] = await Promise.all([
      this.fetchNames('teams', teamIds),
      this.fetchNames('users', userIds, 'email'),
      this.fetchNames('vendors', vendorIds),
    ]);

    const rows: DecisionRow[] = raw.map((row) => {
      const teamId = row.chosen_team_id as string | null;
      const userId = row.chosen_user_id as string | null;
      const vendorId = row.chosen_vendor_id as string | null;
      const [target_kind, target_id, target_name]: [
        DecisionRow['target_kind'],
        string | null,
        string | null,
      ] =
        teamId ? ['team', teamId, teams.get(teamId) ?? null]
        : vendorId ? ['vendor', vendorId, vendors.get(vendorId) ?? null]
        : userId ? ['user', userId, users.get(userId) ?? null]
        : [null, null, null];

      const rulesRaw = row.rules;
      const rule = Array.isArray(rulesRaw) ? rulesRaw[0] : rulesRaw;

      return {
        id: row.id as string,
        ticket_id: row.ticket_id as string,
        decided_at: row.decided_at as string,
        strategy: row.strategy as string,
        chosen_by: row.chosen_by as ChosenBy,
        rule_id: (row.rule_id as string | null) ?? null,
        rule_name: (rule as { name?: string } | null)?.name ?? null,
        target_kind,
        target_id,
        target_name,
        context: (row.context as Record<string, unknown>) ?? {},
      };
    });

    return { rows, total: count ?? rows.length };
  }

  private async fetchNames(
    table: 'teams' | 'users' | 'vendors' | 'request_types',
    ids: Set<string>,
    nameColumn: 'name' | 'email' = 'name',
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    const { data, error } = await this.supabase.admin
      .from(table)
      .select(`id, ${nameColumn}`)
      .in('id', Array.from(ids));
    if (error) {
      this.logger.warn(`fetchNames(${table}) failed: ${error.message}`);
      return out;
    }
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const val = row[nameColumn];
      if (typeof val === 'string') out.set(row.id as string, val);
    }
    return out;
  }

  async listDualRunLogs(filter: DualRunFilter): Promise<{ rows: DualRunLogRow[]; total: number }> {
    const tenant = TenantContext.current();
    const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(filter.offset ?? 0, 0);

    let query = this.supabase.admin
      .from('routing_dualrun_logs')
      .select(
        `id, evaluated_at, mode, hook, ticket_id, request_type_id,
         legacy_output, v2_output, target_match, chosen_by_match, diff_summary`,
        { count: 'exact' },
      )
      .eq('tenant_id', tenant.id)
      .order('evaluated_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (filter.hook) query = query.eq('hook', filter.hook);
    if (filter.since) query = query.gte('evaluated_at', filter.since);
    if (filter.only_divergent) {
      // Postgres treats `false = false` as true but the OR filter API needs
      // an `.or(...)` string. Keep it to match the partial index we already
      // have on (tenant_id, evaluated_at) where target_match is false OR
      // chosen_by_match is false.
      query = query.or('target_match.is.false,chosen_by_match.is.false');
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const raw = (data ?? []) as Array<Record<string, unknown>>;

    // Batch resolve names: one query each for teams/vendors/users/request_types.
    const teamIds = new Set<string>();
    const userIds = new Set<string>();
    const vendorIds = new Set<string>();
    const requestTypeIds = new Set<string>();
    for (const row of raw) {
      if (row.request_type_id) requestTypeIds.add(row.request_type_id as string);
      for (const side of ['legacy_output', 'v2_output'] as const) {
        const out = row[side] as { target?: { kind?: string; team_id?: string; user_id?: string; vendor_id?: string } } | null;
        const target = out?.target;
        if (target?.kind === 'team' && target.team_id) teamIds.add(target.team_id);
        if (target?.kind === 'user' && target.user_id) userIds.add(target.user_id);
        if (target?.kind === 'vendor' && target.vendor_id) vendorIds.add(target.vendor_id);
      }
    }

    const [teams, users, vendors, requestTypes] = await Promise.all([
      this.fetchNames('teams', teamIds),
      this.fetchNames('users', userIds, 'email'),
      this.fetchNames('vendors', vendorIds),
      this.fetchNames('request_types', requestTypeIds),
    ]);

    const projectSide = (out: unknown): SideDecisionView => {
      const o = out as { chosen_by?: string; target?: { kind?: string; team_id?: string; user_id?: string; vendor_id?: string } } | null;
      const target = o?.target ?? null;
      if (!target) return { chosen_by: o?.chosen_by ?? null, target_kind: null, target_id: null, target_name: null };
      if (target.kind === 'team' && target.team_id) {
        return { chosen_by: o?.chosen_by ?? null, target_kind: 'team', target_id: target.team_id, target_name: teams.get(target.team_id) ?? null };
      }
      if (target.kind === 'vendor' && target.vendor_id) {
        return { chosen_by: o?.chosen_by ?? null, target_kind: 'vendor', target_id: target.vendor_id, target_name: vendors.get(target.vendor_id) ?? null };
      }
      if (target.kind === 'user' && target.user_id) {
        return { chosen_by: o?.chosen_by ?? null, target_kind: 'user', target_id: target.user_id, target_name: users.get(target.user_id) ?? null };
      }
      return { chosen_by: o?.chosen_by ?? null, target_kind: null, target_id: null, target_name: null };
    };

    const rows: DualRunLogRow[] = raw.map((row) => ({
      id: row.id as string,
      evaluated_at: row.evaluated_at as string,
      hook: row.hook as DualRunLogRow['hook'],
      mode: row.mode as DualRunLogRow['mode'],
      ticket_id: (row.ticket_id as string | null) ?? null,
      request_type_id: (row.request_type_id as string | null) ?? null,
      request_type_name: row.request_type_id ? requestTypes.get(row.request_type_id as string) ?? null : null,
      legacy: projectSide(row.legacy_output),
      v2: projectSide(row.v2_output),
      target_match: (row.target_match as boolean | null) ?? null,
      chosen_by_match: (row.chosen_by_match as boolean | null) ?? null,
      diff_summary: (row.diff_summary as Record<string, unknown>) ?? {},
    }));

    return { rows, total: count ?? rows.length };
  }
}
