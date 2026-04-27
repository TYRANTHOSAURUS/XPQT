import { ForbiddenException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Three-tier bundle visibility per spec §3.5.
 *
 *   1. Participant — requester_person_id, host_person_id, anyone listed in
 *      `scope_breakdown.approver_person_id`s on a related approval row, or
 *      any `assignee_user_id` of a linked work-order ticket.
 *   2. Operator — `rooms.read_all` permission whose location-grant covers
 *      `bundle.location_id` (closure-expanded).
 *   3. Admin — `rooms.admin` permission. Tenant-wide.
 *
 * Sub-project 4 (reception) consumes this same service.
 *
 * Implementation note: this TS service mirrors the SQL helper
 * `bundle_is_visible_to_user` (migration 00148). Both must agree. The TS
 * version returns richer context for policy decisions; the SQL helper is
 * used by views and triggers where we can't call back into Nest.
 */

export interface BundleVisibilityContext {
  user_id: string;
  person_id: string | null;
  tenant_id: string;
  has_read_all: boolean;
  has_write_all: boolean;
  has_admin: boolean;
}

@Injectable()
export class BundleVisibilityService {
  constructor(private readonly supabase: SupabaseService) {}

  async loadContext(authUid: string, tenantId: string): Promise<BundleVisibilityContext> {
    type UserRow = { id: string; person_id: string | null };
    const userLookup = await (
      this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('tenant_id', tenantId)
        .eq('auth_uid', authUid) as unknown as { maybeSingle: () => Promise<{ data: UserRow | null; error: unknown }> }
    ).maybeSingle();

    const userRow = userLookup.data;
    if (!userRow) {
      return {
        user_id: '',
        person_id: null,
        tenant_id: tenantId,
        has_read_all: false,
        has_write_all: false,
        has_admin: false,
      };
    }

    const [readAllRes, writeAllRes, adminRes] = await Promise.all([
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id,
        p_tenant_id: tenantId,
        p_permission: 'rooms.read_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id,
        p_tenant_id: tenantId,
        p_permission: 'rooms.write_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id,
        p_tenant_id: tenantId,
        p_permission: 'rooms.admin',
      }),
    ]);

    return {
      user_id: userRow.id,
      person_id: userRow.person_id,
      tenant_id: tenantId,
      has_read_all: !!readAllRes.data,
      has_write_all: !!writeAllRes.data,
      has_admin: !!adminRes.data,
    };
  }

  /**
   * Throws ForbiddenException if the user can't see this bundle.
   */
  async assertVisible(bundle: {
    id: string;
    requester_person_id: string;
    host_person_id: string | null;
    location_id: string;
  }, ctx: BundleVisibilityContext): Promise<void> {
    if (ctx.has_admin) return;

    // Unknown user (no row in tenant.users) — fail fast. Without a user
    // there's no person, no role, no permission to check; everything else
    // below would be wasted DB round-trips.
    if (!ctx.user_id) {
      throw new ForbiddenException({ code: 'bundle_forbidden', message: 'You do not have access to this booking.' });
    }

    // Participant: requester / host
    if (ctx.person_id && (bundle.requester_person_id === ctx.person_id || bundle.host_person_id === ctx.person_id)) {
      return;
    }

    // Operator: rooms.read_all is sufficient at v1 (location-scoped grants
    // are sub-project 4 work). The SQL helper bundle_is_visible_to_user
    // matches this posture.
    if (ctx.has_read_all) return;

    // Approval participant: any scope_breakdown.approver_person_id mention.
    if (ctx.person_id) {
      const { data, error } = await this.supabase.admin
        .from('approvals')
        .select('id')
        .eq('tenant_id', ctx.tenant_id)
        .eq('target_entity_id', bundle.id)
        .eq('approver_person_id', ctx.person_id)
        .limit(1);
      if (error) throw error;
      if ((data ?? []).length > 0) return;
    }

    // Work-order assignee: any ticket with this bundle_id assigned to me.
    {
      const { data, error } = await this.supabase.admin
        .from('tickets')
        .select('id')
        .eq('tenant_id', ctx.tenant_id)
        .eq('booking_bundle_id', bundle.id)
        .eq('assigned_user_id', ctx.user_id)
        .limit(1);
      if (error) throw error;
      if ((data ?? []).length > 0) return;
    }

    throw new ForbiddenException({ code: 'bundle_forbidden', message: 'You do not have access to this booking.' });
  }
}
