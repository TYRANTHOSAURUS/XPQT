import { ForbiddenException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

export interface RoleAssignmentCtx {
  domain_scope: string[];          // empty array = all domains
  location_scope_closure: string[]; // empty array = all locations; otherwise expanded descendants
  read_only_cross_domain: boolean;
}

export interface VisibilityContext {
  user_id: string;
  person_id: string | null;
  tenant_id: string;
  team_ids: string[];
  role_assignments: RoleAssignmentCtx[];
  vendor_id: string | null;  // phase-4 stub; null today
  has_read_all: boolean;
  has_write_all: boolean;
}

interface TicketForVisibility {
  id: string;
  tenant_id: string;
  requester_person_id: string | null;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  assigned_vendor_id: string | null;
  watchers: string[] | null;
  location_id: string | null;
  domain: string | null;
  parent_ticket_id: string | null;
  parent_assigned_team_id: string | null;
}

@Injectable()
export class TicketVisibilityService {
  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Resolves the Supabase auth uid to a full visibility context within the given tenant.
   * Callers pass `req.user.id` as `authUid`.
   */
  async loadContext(authUid: string, tenantId: string): Promise<VisibilityContext> {
    const userLookup = await (this.supabase.admin.from('users')
      .select('id, person_id')
      .eq('tenant_id', tenantId)
      .eq('auth_uid', authUid) as unknown as { maybeSingle: () => Promise<{ data: { id: string; person_id: string | null } | null; error: unknown }> }).maybeSingle();
    const userRow = userLookup.data;
    if (!userRow) {
      // Unknown user in this tenant — return a context that matches nothing.
      return {
        user_id: '', person_id: null, tenant_id: tenantId,
        team_ids: [], role_assignments: [], vendor_id: null,
        has_read_all: false, has_write_all: false,
      };
    }

    const [teamsRes, rolesRes, readAllRes, writeAllRes] = await Promise.all([
      this.supabase.admin.from('team_members')
        .select('team_id')
        .eq('tenant_id', tenantId)
        .eq('user_id', userRow.id),
      this.supabase.admin.from('user_role_assignments')
        .select('domain_scope, location_scope, read_only_cross_domain')
        .eq('tenant_id', tenantId)
        .eq('user_id', userRow.id)
        .eq('active', true),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'tickets.read_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'tickets.write_all',
      }),
    ]);

    const team_ids = ((teamsRes.data ?? []) as Array<{ team_id: string }>).map((r) => r.team_id);

    const rawRoles = (rolesRes.data ?? []) as Array<{
      domain_scope: string[] | null;
      location_scope: string[] | null;
      read_only_cross_domain: boolean;
    }>;

    const role_assignments: RoleAssignmentCtx[] = [];
    for (const r of rawRoles) {
      const closure = await this.expandLocationClosure(r.location_scope ?? []);
      role_assignments.push({
        domain_scope: r.domain_scope ?? [],
        location_scope_closure: closure,
        read_only_cross_domain: !!r.read_only_cross_domain,
      });
    }

    return {
      user_id: userRow.id,
      person_id: userRow.person_id,
      tenant_id: tenantId,
      team_ids,
      role_assignments,
      vendor_id: null, // phase-4 will populate via persons.external_source = 'vendor'
      has_read_all: !!readAllRes.data,
      has_write_all: !!writeAllRes.data,
    };
  }

  /**
   * Call the SQL closure helper for a given set of root space ids.
   */
  private async expandLocationClosure(rootIds: string[]): Promise<string[]> {
    if (rootIds.length === 0) return [];
    const { data } = await this.supabase.admin.rpc('expand_space_closure', { p_roots: rootIds });
    if (!Array.isArray(data)) return rootIds;
    return (data as Array<{ id?: string } | string>).map((row) =>
      typeof row === 'string' ? row : (row.id as string),
    );
  }

  /**
   * Returns a Supabase filter stub telling the caller how to narrow a tickets query
   * to visible rows. Strategy: use the `ticket_visibility_ids` SQL function via `.in()`.
   * Callers chain: baseQuery.in('id', await visibility.getVisibleIds(ctx)).
   */
  async getVisibleIds(ctx: VisibilityContext): Promise<string[] | null> {
    if (ctx.has_read_all) return null; // null = no filter (see all)
    if (!ctx.user_id) return [];
    const { data, error } = await this.supabase.admin
      .rpc('ticket_visibility_ids', { p_user_id: ctx.user_id, p_tenant_id: ctx.tenant_id });
    if (error) throw error;
    return (data as Array<string | { id: string }> | null)?.map((row) =>
      typeof row === 'string' ? row : row.id,
    ) ?? [];
  }

  /**
   * Per-ticket gate. Loads the ticket, evaluates paths in TypeScript against ctx.
   * `mode = 'read'`: any path matches or has_read_all.
   * `mode = 'write'`: participant OR non-readonly operator OR has_write_all.
   * Throws ForbiddenException on denial.
   */
  async assertVisible(ticketId: string, ctx: VisibilityContext, mode: 'read' | 'write'): Promise<void> {
    if (mode === 'read' && ctx.has_read_all) return;
    if (mode === 'write' && ctx.has_write_all) return;

    const row = await this.loadTicketRow(ticketId, ctx.tenant_id);
    if (!row) throw new ForbiddenException('Ticket not accessible');

    // Participant paths (allow read and write).
    const participantMatch =
      (!!ctx.person_id && row.requester_person_id === ctx.person_id) ||
      row.assigned_user_id === ctx.user_id ||
      (!!ctx.person_id && (row.watchers ?? []).includes(ctx.person_id)) ||
      (!!ctx.vendor_id && row.assigned_vendor_id === ctx.vendor_id);

    if (participantMatch) return;

    // Team path (treated as operator, always writable).
    const teamMatch = !!row.assigned_team_id && ctx.team_ids.includes(row.assigned_team_id);
    if (teamMatch && mode === 'write') return;

    // Role operator paths.
    const matchingRoles = ctx.role_assignments.filter((role) => {
      const domainOk =
        role.domain_scope.length === 0 ||
        (row.domain != null && role.domain_scope.includes(row.domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      return domainOk && locationOk;
    });

    const anyRoleMatch = matchingRoles.length > 0;
    const anyWritableRole = matchingRoles.some((r) => !r.read_only_cross_domain);

    if (mode === 'read') {
      if (teamMatch || anyRoleMatch) return;
    } else {
      if (teamMatch || anyWritableRole) return;
    }

    throw new ForbiddenException('Ticket not accessible');
  }

  /**
   * Plandate gate. Narrower than write: only the people actually doing
   * (or owning) the work can declare when it'll happen. Allowed paths:
   *   • WO assignee (assigned_user_id)
   *   • Assigned vendor
   *   • Member of the WO's assigned team
   *   • Member of the parent case's assigned team (case-level "ownership")
   *   • Role operator with non-readonly write scope matching domain+location
   *   • tickets.write_all override
   *
   * Excluded: requester, watcher, readonly cross-domain roles.
   */
  async assertCanPlan(ticketId: string, ctx: VisibilityContext): Promise<void> {
    if (ctx.has_write_all) return;

    const row = await this.loadTicketRow(ticketId, ctx.tenant_id);
    if (!row) throw new ForbiddenException('Ticket not accessible');

    if (row.assigned_user_id === ctx.user_id) return;
    if (ctx.vendor_id && row.assigned_vendor_id === ctx.vendor_id) return;

    const teamCandidates = [row.assigned_team_id, row.parent_assigned_team_id].filter(
      (t): t is string => !!t,
    );
    if (teamCandidates.some((t) => ctx.team_ids.includes(t))) return;

    const writableRoleMatch = ctx.role_assignments.some((role) => {
      if (role.read_only_cross_domain) return false;
      const domainOk =
        role.domain_scope.length === 0 ||
        (row.domain != null && role.domain_scope.includes(row.domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      return domainOk && locationOk;
    });
    if (writableRoleMatch) return;

    throw new ForbiddenException('Not authorized to plan this ticket');
  }

  /**
   * Explains why a user can (or cannot) see a specific ticket.
   * Used by the /visibility-trace endpoint for support debugging.
   */
  async trace(ticketId: string, ctx: VisibilityContext): Promise<{
    user_id: string;
    ticket_id: string;
    visible: boolean;
    matched_paths: string[];
    readonly_role: boolean;
    has_read_all: boolean;
    has_write_all: boolean;
  }> {
    const paths: string[] = [];
    if (ctx.has_read_all) paths.push('read_all');

    const row = await this.loadTicketRow(ticketId, ctx.tenant_id);
    if (!row) {
      return {
        user_id: ctx.user_id, ticket_id: ticketId,
        visible: ctx.has_read_all, matched_paths: paths, readonly_role: false,
        has_read_all: ctx.has_read_all, has_write_all: ctx.has_write_all,
      };
    }

    if (ctx.person_id && row.requester_person_id === ctx.person_id) paths.push('requester');
    if (row.assigned_user_id === ctx.user_id) paths.push('assignee');
    if (ctx.person_id && (row.watchers ?? []).includes(ctx.person_id)) paths.push('watcher');
    if (ctx.vendor_id && row.assigned_vendor_id === ctx.vendor_id) paths.push('vendor');
    if (row.assigned_team_id && ctx.team_ids.includes(row.assigned_team_id)) paths.push('team');

    let readonlyRole = false;
    ctx.role_assignments.forEach((role, idx) => {
      const domainOk =
        role.domain_scope.length === 0 ||
        (row.domain != null && role.domain_scope.includes(row.domain));
      const locationOk =
        role.location_scope_closure.length === 0 ||
        row.location_id == null ||
        role.location_scope_closure.includes(row.location_id);
      if (domainOk && locationOk) {
        paths.push(`role[${idx}]${role.read_only_cross_domain ? ':readonly' : ''}`);
        if (role.read_only_cross_domain) readonlyRole = true;
      }
    });

    const visible = paths.length > 0 || ctx.has_read_all;
    return {
      user_id: ctx.user_id,
      ticket_id: ticketId,
      visible,
      matched_paths: paths,
      readonly_role: readonlyRole,
      has_read_all: ctx.has_read_all,
      has_write_all: ctx.has_write_all,
    };
  }

  private async loadTicketRow(ticketId: string, tenantId: string): Promise<TicketForVisibility | null> {
    // Step 1c.10c: id may be in tickets (case) or work_orders. Try both.
    // Visibility checks must work for both kinds — without this, getById's
    // visibility precheck on a work_order id always fails before the
    // fallback in getById can run (codex round 3 finding).
    const tryLoad = async (table: 'tickets' | 'work_orders') => {
      const { data } = await (this.supabase.admin
        .from(table)
        .select(`
          id, tenant_id, requester_person_id, assigned_user_id, assigned_team_id,
          assigned_vendor_id, watchers, location_id, parent_ticket_id,
          ticket_type:request_types!${table}_ticket_type_id_fkey(domain)
        `)
        .eq('id', ticketId)
        .eq('tenant_id', tenantId) as unknown as { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> })
        .maybeSingle();
      return data;
    };
    let data = await tryLoad('tickets');
    if (!data) {
      // FK alias for work_orders may not exist (created via migrations 00213+).
      // Fall back to a manual select without the request_types join.
      const { data: woData } = await (this.supabase.admin
        .from('work_orders')
        .select(`
          id, tenant_id, requester_person_id, assigned_user_id, assigned_team_id,
          assigned_vendor_id, watchers, location_id, parent_ticket_id, ticket_type_id
        `)
        .eq('id', ticketId)
        .eq('tenant_id', tenantId) as unknown as { maybeSingle: () => Promise<{ data: Record<string, unknown> | null }> })
        .maybeSingle();
      if (woData) {
        // Fetch domain separately for work_orders.
        if (woData.ticket_type_id) {
          const { data: typeRow } = await this.supabase.admin
            .from('request_types')
            .select('domain')
            .eq('id', woData.ticket_type_id as string)
            .maybeSingle();
          (woData as Record<string, unknown>).ticket_type = typeRow ? { domain: (typeRow as { domain: string | null }).domain } : null;
        }
      }
      data = woData;
    }
    if (!data) return null;
    const raw = data as Record<string, unknown>;
    const type = Array.isArray(raw.ticket_type) ? (raw.ticket_type as unknown[])[0] : raw.ticket_type;

    let parentAssignedTeamId: string | null = null;
    const parentId = (raw.parent_ticket_id as string | null) ?? null;
    if (parentId) {
      const { data: parent } = await (this.supabase.admin
        .from('tickets')
        .select('assigned_team_id')
        .eq('id', parentId)
        .eq('tenant_id', tenantId) as unknown as {
          maybeSingle: () => Promise<{ data: { assigned_team_id: string | null } | null }>;
        }).maybeSingle();
      parentAssignedTeamId = parent?.assigned_team_id ?? null;
    }

    return {
      id: raw.id as string,
      tenant_id: raw.tenant_id as string,
      requester_person_id: (raw.requester_person_id as string | null) ?? null,
      assigned_user_id: (raw.assigned_user_id as string | null) ?? null,
      assigned_team_id: (raw.assigned_team_id as string | null) ?? null,
      assigned_vendor_id: (raw.assigned_vendor_id as string | null) ?? null,
      watchers: (raw.watchers as string[] | null) ?? [],
      location_id: (raw.location_id as string | null) ?? null,
      domain: (type as { domain?: string | null } | null)?.domain ?? (raw.domain as string | null) ?? null,
      parent_ticket_id: parentId,
      parent_assigned_team_id: parentAssignedTeamId,
    };
  }
}
