import { ForbiddenException, Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';

/**
 * Three-tier visibility for reservations (mirrors the ticket pattern but
 * lighter — no ownership chains across teams):
 *
 *   1. Participant: requester_person_id, attendee_person_ids[], booked_by_user_id.
 *   2. Operator: rooms.read_all permission OR per-site grant (future).
 *   3. Admin: rooms.admin permission (full read + write + rule mgmt).
 *
 * loadContext caches per-request via `Map` keyed on (authUid, tenantId).
 * filterIds returns a Postgres OR-clause string the caller can attach to
 * a query to restrict results to the visibility scope.
 */

export interface ReservationVisibilityContext {
  user_id: string;
  person_id: string | null;
  tenant_id: string;
  has_read_all: boolean;
  has_write_all: boolean;
  has_admin: boolean;
}

@Injectable()
export class ReservationVisibilityService {
  constructor(private readonly supabase: SupabaseService) {}

  async loadContext(authUid: string, tenantId: string): Promise<ReservationVisibilityContext> {
    type UserRow = { id: string; person_id: string | null };
    const userLookup = await (
      this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('tenant_id', tenantId)
        .eq('auth_uid', authUid) as unknown as { maybeSingle: () => Promise<{ data: UserRow | null; error: unknown }> }
    ).maybeSingle();

    return this.contextFromUserRow(userLookup.data, tenantId);
  }

  /**
   * Same as loadContext but resolves by `users.id` (the app-side user id)
   * instead of `auth_uid`. Used by mutation paths (editOne / cancelOne /
   * restore) that already have an `ActorContext` in hand — passing
   * `actor.user_id` to `loadContext` would be a category mismatch (it
   * looks up by `auth_uid`, returns an empty context, and breaks every
   * subsequent visibility check). That mismatch is the root cause of the
   * "reservation not visible" failure when an operator drags a row on
   * the desk scheduler.
   */
  async loadContextByUserId(userId: string, tenantId: string): Promise<ReservationVisibilityContext> {
    type UserRow = { id: string; person_id: string | null };
    const userLookup = await (
      this.supabase.admin
        .from('users')
        .select('id, person_id')
        .eq('tenant_id', tenantId)
        .eq('id', userId) as unknown as { maybeSingle: () => Promise<{ data: UserRow | null; error: unknown }> }
    ).maybeSingle();

    return this.contextFromUserRow(userLookup.data, tenantId);
  }

  private async contextFromUserRow(
    userRow: { id: string; person_id: string | null } | null,
    tenantId: string,
  ): Promise<ReservationVisibilityContext> {
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
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'rooms.read_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'rooms.write_all',
      }),
      this.supabase.admin.rpc('user_has_permission', {
        p_user_id: userRow.id, p_tenant_id: tenantId, p_permission: 'rooms.admin',
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
   * Throws ForbiddenException if the user can't see this reservation.
   */
  assertVisible(reservation: {
    requester_person_id: string;
    attendee_person_ids: string[] | null;
    booked_by_user_id: string | null;
  }, ctx: ReservationVisibilityContext): void {
    if (this.canSee(reservation, ctx)) return;
    throw new ForbiddenException('reservation_not_visible');
  }

  canSee(reservation: {
    requester_person_id: string;
    attendee_person_ids: string[] | null;
    booked_by_user_id: string | null;
  }, ctx: ReservationVisibilityContext): boolean {
    // write_all implies read access — someone authorised to edit any
    // reservation must also be able to read what they're about to mutate.
    if (ctx.has_admin || ctx.has_read_all || ctx.has_write_all) return true;
    if (ctx.person_id && reservation.requester_person_id === ctx.person_id) return true;
    if (ctx.person_id && (reservation.attendee_person_ids ?? []).includes(ctx.person_id)) return true;
    if (ctx.user_id && reservation.booked_by_user_id === ctx.user_id) return true;
    return false;
  }

  canEdit(reservation: {
    requester_person_id: string;
    booked_by_user_id: string | null;
  }, ctx: ReservationVisibilityContext): boolean {
    if (ctx.has_admin || ctx.has_write_all) return true;
    if (ctx.person_id && reservation.requester_person_id === ctx.person_id) return true;
    if (ctx.user_id && reservation.booked_by_user_id === ctx.user_id) return true;
    return false;
  }

  /**
   * Throws ForbiddenException unless the actor has rooms.admin or
   * rooms.read_all. Used by operator-only endpoints (desk scheduler window
   * fetch, admin-only listings, etc).
   */
  assertOperatorOrAdmin(ctx: ReservationVisibilityContext): void {
    if (ctx.has_admin || ctx.has_read_all) return;
    throw new ForbiddenException('reservation_operator_required');
  }

  /**
   * Apply a visibility filter to a Supabase query for reservations list.
   * For non-operators, restricts to participant-level rows.
   */
  applyFilterToQuery(
    query: any,
    ctx: ReservationVisibilityContext,
  ): any {
    if (ctx.has_admin || ctx.has_read_all) return query;
    if (!ctx.person_id && !ctx.user_id) {
      // No identity in this tenant — return nothing
      return query.eq('id', '00000000-0000-0000-0000-000000000000');
    }
    const orClauses: string[] = [];
    if (ctx.person_id) {
      orClauses.push(`requester_person_id.eq.${ctx.person_id}`);
      orClauses.push(`attendee_person_ids.cs.{${ctx.person_id}}`);
    }
    if (ctx.user_id) {
      orClauses.push(`booked_by_user_id.eq.${ctx.user_id}`);
    }
    return query.or(orClauses.join(','));
  }
}
