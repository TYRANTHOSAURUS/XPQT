import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export type CoverageChosenBy =
  | 'direct'
  | 'parent'
  | 'space_group'
  | 'domain_fallback'
  | 'uncovered';

export interface CoverageFilter {
  space_root_id?: string;
  domains?: string[];
  /** Max cells to emit before truncating. Default 2000. Hard cap 5000. */
  max_cells?: number;
}

export interface CoverageSpace {
  id: string;
  name: string;
  parent_id: string | null;
  depth: number;
  path: string[];
}

export interface CoverageCell {
  space_id: string;
  domain: string;
  chosen_by: CoverageChosenBy;
  target_kind: 'team' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
  via_parent_space_id: string | null;
  via_space_group_id: string | null;
  via_space_group_name: string | null;
  via_parent_domain: string | null;
}

export interface CoverageResponse {
  spaces: CoverageSpace[];
  domains: string[];
  cells: CoverageCell[];
  truncated: boolean;
}

const DEFAULT_MAX_CELLS = 2000;
const HARD_CAP = 5000;

/**
 * Routing Studio coverage matrix — one resolver-equivalent row per
 * (space, domain) pair. Powered by the SQL function
 * `public.resolve_coverage` so the whole grid is one RPC call; no N+1.
 */
@Injectable()
export class RoutingCoverageService {
  private readonly logger = new Logger(RoutingCoverageService.name);

  constructor(private readonly supabase: SupabaseService) {}

  async getCoverage(filter: CoverageFilter): Promise<CoverageResponse> {
    const started = Date.now();
    const tenant = TenantContext.current();
    const maxCells = Math.min(filter.max_cells ?? DEFAULT_MAX_CELLS, HARD_CAP);

    // 1. Resolve the domain set (either caller-supplied or all distinct domains in use).
    const domains = filter.domains && filter.domains.length > 0
      ? [...new Set(filter.domains)]
      : await this.listActiveDomains(tenant.id);

    if (domains.length === 0) {
      return { spaces: [], domains: [], cells: [], truncated: false };
    }

    // 2. Build the space list and compute path/depth on the server so the UI
    //    can render hierarchy without walking parent_id itself.
    const spaces = await this.listSpaces(tenant.id, filter.space_root_id);
    if (spaces.length === 0) {
      return { spaces: [], domains, cells: [], truncated: false };
    }

    // Cap the grid to protect against accidentally huge tenants.
    const totalCells = spaces.length * domains.length;
    let truncated = false;
    let effectiveSpaces = spaces;
    if (totalCells > maxCells) {
      truncated = true;
      const allowedSpaceCount = Math.max(1, Math.floor(maxCells / domains.length));
      effectiveSpaces = spaces.slice(0, allowedSpaceCount);
    }

    // 3. One RPC call resolves every cell.
    const { data, error } = await this.supabase.admin.rpc('resolve_coverage', {
      p_tenant_id: tenant.id,
      p_space_ids: effectiveSpaces.map((s) => s.id),
      p_domains: domains,
    });
    if (error) throw error;

    const rawCells = (data ?? []) as Array<{
      space_id: string;
      domain: string;
      chosen_by: CoverageChosenBy;
      target_kind: 'team' | 'vendor' | null;
      target_id: string | null;
      via_parent_space_id: string | null;
      via_space_group_id: string | null;
      via_parent_domain: string | null;
    }>;

    // 4. Batch-resolve target + space-group names.
    const teamIds = new Set<string>();
    const vendorIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const c of rawCells) {
      if (c.target_kind === 'team' && c.target_id) teamIds.add(c.target_id);
      if (c.target_kind === 'vendor' && c.target_id) vendorIds.add(c.target_id);
      if (c.via_space_group_id) groupIds.add(c.via_space_group_id);
    }
    const [teams, vendors, groups] = await Promise.all([
      this.fetchNames('teams', teamIds),
      this.fetchNames('vendors', vendorIds),
      this.fetchNames('space_groups', groupIds),
    ]);

    const cells: CoverageCell[] = rawCells.map((c) => ({
      space_id: c.space_id,
      domain: c.domain,
      chosen_by: c.chosen_by,
      target_kind: c.target_kind,
      target_id: c.target_id,
      target_name:
        c.target_kind === 'team' && c.target_id ? teams.get(c.target_id) ?? null
        : c.target_kind === 'vendor' && c.target_id ? vendors.get(c.target_id) ?? null
        : null,
      via_parent_space_id: c.via_parent_space_id,
      via_space_group_id: c.via_space_group_id,
      via_space_group_name: c.via_space_group_id ? groups.get(c.via_space_group_id) ?? null : null,
      via_parent_domain: c.via_parent_domain,
    }));

    const duration = Date.now() - started;
    this.logger.log(
      `coverage tenant=${tenant.id} spaces=${effectiveSpaces.length} domains=${domains.length} ` +
      `cells=${cells.length} truncated=${truncated} duration=${duration}ms`,
    );

    return {
      spaces: effectiveSpaces,
      domains,
      cells,
      truncated,
    };
  }

  private async listActiveDomains(tenantId: string): Promise<string[]> {
    // Use domains that actually have location_teams OR request_types — gives a
    // useful default column set without needing admin pre-config.
    const [lt, rt] = await Promise.all([
      this.supabase.admin.from('location_teams').select('domain').eq('tenant_id', tenantId),
      this.supabase.admin.from('request_types').select('domain').eq('tenant_id', tenantId),
    ]);
    if (lt.error) throw lt.error;
    if (rt.error) throw rt.error;
    const set = new Set<string>();
    for (const row of lt.data ?? []) if (row.domain) set.add(row.domain as string);
    for (const row of rt.data ?? []) if (row.domain) set.add(row.domain as string);
    return Array.from(set).sort();
  }

  private async listSpaces(tenantId: string, rootId?: string): Promise<CoverageSpace[]> {
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('id, name, parent_id')
      .eq('tenant_id', tenantId)
      .order('name');
    if (error) throw error;
    const rows = (data ?? []) as Array<{ id: string; name: string; parent_id: string | null }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    // Filter to descendants of rootId (if provided) by walking parent_id.
    const inScope = (id: string): boolean => {
      if (!rootId) return true;
      let cur: string | null | undefined = id;
      for (let i = 0; cur && i < 20; i++) {
        if (cur === rootId) return true;
        cur = byId.get(cur)?.parent_id ?? null;
      }
      return false;
    };

    const withDepth = rows
      .filter((r) => inScope(r.id))
      .map((r) => {
        const path: string[] = [];
        let depth = 0;
        let cur: string | null | undefined = r.id;
        const safety = 20;
        for (let i = 0; cur && i < safety; i++) {
          const node = byId.get(cur);
          if (!node) break;
          path.unshift(node.name);
          depth = i;
          cur = node.parent_id;
        }
        return {
          id: r.id,
          name: r.name,
          parent_id: r.parent_id,
          depth,
          path,
        };
      });
    // Sort by path so hierarchy renders naturally.
    withDepth.sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
    return withDepth;
  }

  /**
   * Upsert or clear the location_teams row for a (space, domain) cell.
   * Wraps existing CRUD so the matrix can do one-click edits.
   */
  async setCell(input: {
    space_id: string;
    domain: string;
    assignee: { kind: 'team' | 'vendor'; id: string } | null;
  }): Promise<{ deleted: boolean; row?: unknown }> {
    const tenant = TenantContext.current();
    if (!input.space_id) throw new BadRequestException('space_id required');
    if (!input.domain?.trim()) throw new BadRequestException('domain required');

    const domain = input.domain.trim();

    const { data: existing, error: findErr } = await this.supabase.admin
      .from('location_teams')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('space_id', input.space_id)
      .eq('domain', domain)
      .maybeSingle();
    if (findErr) throw new BadRequestException(findErr.message);

    // Clear case
    if (!input.assignee) {
      if (!existing) return { deleted: true };
      const { error } = await this.supabase.admin
        .from('location_teams')
        .delete()
        .eq('id', (existing as { id: string }).id)
        .eq('tenant_id', tenant.id);
      if (error) throw new BadRequestException(error.message);
      return { deleted: true };
    }

    const patch: Record<string, unknown> = {
      tenant_id: tenant.id,
      space_id: input.space_id,
      space_group_id: null,
      domain,
      team_id: input.assignee.kind === 'team' ? input.assignee.id : null,
      vendor_id: input.assignee.kind === 'vendor' ? input.assignee.id : null,
    };

    if (existing) {
      const { data, error } = await this.supabase.admin
        .from('location_teams')
        .update({
          team_id: patch.team_id,
          vendor_id: patch.vendor_id,
        })
        .eq('id', (existing as { id: string }).id)
        .eq('tenant_id', tenant.id)
        .select()
        .single();
      if (error) throw new BadRequestException(error.message);
      return { deleted: false, row: data };
    }
    const { data, error } = await this.supabase.admin
      .from('location_teams')
      .insert(patch)
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    return { deleted: false, row: data };
  }

  private async fetchNames(
    table: 'teams' | 'vendors' | 'space_groups',
    ids: Set<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (ids.size === 0) return out;
    const { data, error } = await this.supabase.admin
      .from(table)
      .select('id, name')
      .in('id', Array.from(ids));
    if (error) {
      this.logger.warn(`fetchNames(${table}) failed: ${error.message}`);
      return out;
    }
    for (const row of (data ?? []) as Array<{ id: string; name: string }>) {
      out.set(row.id, row.name);
    }
    return out;
  }
}
