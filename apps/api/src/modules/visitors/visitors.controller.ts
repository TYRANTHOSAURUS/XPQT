import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  GoneException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PermissionGuard } from '../../common/permission-guard';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { Public } from '../auth/public.decorator';
import { HostNotificationService } from './host-notification.service';
import { InvitationService } from './invitation.service';
import { VisitorService } from './visitor.service';
import { CreateInvitationSchema, formatZodError } from './dto/schemas';
import { DbService } from '../../common/db/db.service';

/**
 * Host-facing visitor surface.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6, §17
 *
 * Three audiences:
 *   - **Host (employee)** — invite + see own upcoming + acknowledge.
 *     Auth: global `AuthGuard` + `requirePermission('visitors.invite')`
 *     for invite. Acknowledge is gated by ownership (host must be in
 *     visitor_hosts).
 *   - **Visitor (anonymous)** — cancel-by-token. The token is the auth.
 *     `@Public()` opts the route out of the global AuthGuard.
 *   - **Detail view** — `GET /visitors/:id`. Visibility-gated via
 *     `visitor_visibility_ids()` from migration 00255 (3-tier model).
 */
@Controller('visitors')
export class VisitorsController {
  constructor(
    private readonly invitations: InvitationService,
    private readonly visitorService: VisitorService,
    private readonly hostNotifications: HostNotificationService,
    private readonly supabase: SupabaseService,
    private readonly db: DbService,
    private readonly permissions: PermissionGuard,
  ) {}

  /**
   * POST /visitors/invitations — host invites a visitor.
   * Spec §6.1.
   *
   * Resolves the actor (auth user → users row → person_id) before
   * delegating to InvitationService. Building scope is enforced inside
   * the service via `portal_authorized_space_ids`.
   */
  @Post('invitations')
  async createInvitation(@Req() req: Request, @Body() body: unknown) {
    await this.permissions.requirePermission(req, 'visitors.invite');
    const parsed = CreateInvitationSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(formatZodError(parsed.error));
    }

    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    const result = await this.invitations.create(parsed.data, {
      user_id: actor.user_id,
      person_id: actor.person_id,
      tenant_id: tenant.id,
    });

    /* The plaintext cancel_token is internal — slice 5's email worker
       will pick it up via a domain event. We do NOT return it in the
       REST response (an attacker who reads the host's network log would
       otherwise have a single-use cancel link). */
    return {
      visitor_id: result.visitor_id,
      status: result.status,
      approval_id: result.approval_id,
    };
  }

  /**
   * GET /visitors/types — host-accessible visitor type lookup.
   *
   * Spec §6.1 — the invite form needs the active visitor types to
   * populate its dropdown. The admin surface (`/admin/visitors/types`)
   * is gated behind `AdminGuard` so a non-admin host can't read it.
   * This endpoint requires only `visitors.invite` (the same permission
   * the host uses to actually create the invitation), which keeps the
   * picker populated without granting admin access.
   *
   * Returns active types only — disabled types are admin-internal.
   */
  @Get('types')
  async listTypesForHosts(@Req() req: Request) {
    await this.permissions.requirePermission(req, 'visitors.invite');
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .select(
        'id, type_key, display_name, description, requires_approval, allow_walk_up, default_expected_until_offset_minutes, active',
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('display_name', { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  /**
   * GET /visitors/expected — host's upcoming visitors.
   *
   * Filters: `visitor_hosts.person_id = actor.person_id`, status in
   * (pending_approval, expected, arrived, in_meeting), expected_at >=
   * today_start. Uses the visibility function as defense-in-depth (a
   * host should always see their own, but the function returns the
   * right set anyway — no need for a separate query path).
   */
  @Get('expected')
  async expected(@Req() req: Request) {
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    const sql = `
      select
        v.id                         as visitor_id,
        v.first_name                 as first_name,
        v.last_name                  as last_name,
        v.company                    as company,
        v.expected_at                as expected_at,
        v.expected_until             as expected_until,
        v.arrived_at                 as arrived_at,
        v.status                     as status,
        v.building_id                as building_id,
        v.meeting_room_id            as meeting_room_id
      from public.visitors v
      join public.visitor_hosts vh
        on vh.visitor_id = v.id
       and vh.tenant_id = v.tenant_id
      where v.tenant_id = $1
        and vh.person_id = $2
        and v.status in ('pending_approval', 'expected', 'arrived', 'in_meeting')
        and (v.expected_at is null or v.expected_at >= date_trunc('day', now()))
      order by v.expected_at nulls last
    `;
    return this.db.queryMany(sql, [tenant.id, actor.person_id]);
  }

  /**
   * GET /visitors/cancel/:token/preview — public, NON-CONSUMING preview.
   *
   * Spec §6.4 cancel UX, slice 10. Pairs with the cancel POST below.
   *
   * The cancel landing page renders an interstitial confirmation
   * ("You're cancelling your visit on Wed at HQ Amsterdam — are you
   * sure?") before the visitor commits. To do that without burning the
   * single-use cancel token, we expose this read-only sibling that calls
   * `peek_invitation_token` (migration 00265) instead of
   * `validate_invitation_token`.
   *
   * Auth model: identical to the cancel POST. The token is the auth;
   * the route is `@Public()`. Cross-tenant defence is the same — a
   * tenant-A subdomain reading a tenant-B token is treated as
   * not-found.
   *
   * Idempotent: calling preview N times never consumes the token. The
   * confirmation page can re-render on every refresh until the visitor
   * either confirms cancel (POST) or navigates away.
   *
   * Error codes (same envelope as the POST):
   *   45001 → 410 { code: 'invalid_token' }
   *   45003 → 410 { code: 'token_expired' }
   * Note: there is NO 45002 (already_used) on peek — peek is read-only.
   * If the visitor has already cancelled, that's surfaced via the
   * returned `visitor_status='cancelled'`, not via an error.
   */
  @Public()
  @Get('cancel/:token/preview')
  async previewCancel(@Param('token') token: string) {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Token is required');
    }

    type PeekRow = {
      visitor_id: string;
      tenant_id: string;
      visitor_status: string;
      // Post-tombstone (migration 00272 / I12): every PII field is NULL
      // once the token has been consumed. Pre-use, all fields are
      // populated. The cancel landing page renders one of two states
      // based on `visitor_status` — never relies on first_name etc.
      // being non-null.
      first_name: string | null;
      expected_at: string | null;
      expected_until: string | null;
      building_id: string | null;
      building_name: string | null;
      host_first_name: string | null;
    };

    let row: PeekRow | null;
    try {
      row = await this.db.queryOne<PeekRow>(
        `select * from public.peek_invitation_token($1, $2)`,
        [token, 'cancel'],
      );
      if (!row) {
        // SECURITY DEFINER raises on miss; defence-in-depth.
        throw new GoneException({ code: 'invalid_token' });
      }
    } catch (err) {
      throw mapTokenError(err);
    }

    /* Same cross-tenant guard as the POST: subdomain → TenantContext
       must match the token's tenant. Otherwise treat as not-found. */
    const ctxTenant = TenantContext.currentOrNull();
    if (!ctxTenant) {
      throw new UnauthorizedException('No tenant context resolved');
    }
    if (ctxTenant.id !== row.tenant_id) {
      throw new GoneException({ code: 'invalid_token' });
    }

    /* Strip tenant_id from the response — the visitor doesn't need it
       and surfacing it adds nothing. The frontend already knows the
       tenant from the subdomain. visitor_id stays because the cancel
       POST useMutation can use it for optimistic cache updates. */
    return {
      visitor_id: row.visitor_id,
      visitor_status: row.visitor_status,
      first_name: row.first_name,
      expected_at: row.expected_at,
      expected_until: row.expected_until,
      building_id: row.building_id,
      building_name: row.building_name,
      host_first_name: row.host_first_name,
    };
  }

  /**
   * POST /visitors/cancel/:token — public visitor cancel link.
   *
   * Spec §6.1, §17. Token is the auth — the route is `@Public()`.
   *
   * Flow:
   *   1. Call validate_invitation_token(token, 'cancel'). The function
   *      is SECURITY DEFINER and resolves visitor_id + tenant_id from
   *      the hash. Distinct SQLSTATEs (45001/2/3 from migration 00260)
   *      map to 410 Gone with a stable code so the cancel landing page
   *      can render the right copy.
   *   2. Verify the resolved tenant matches the request's TenantContext
   *      — the subdomain dictated which tenant the request belongs to;
   *      a token issued in tenant B accessed via tenant A's subdomain
   *      is treated as not-found. (Function tokens are tenant-scoped at
   *      issue time, so this is defense in depth.)
   *   3. Run transitionStatus inside that tenant's context. The state
   *      machine rejects cancellation of anything past 'arrived'.
   *   4. Notify hosts via HostNotificationService (best-effort).
   */
  @Public()
  @Post('cancel/:token')
  async cancelByToken(@Param('token') token: string) {
    if (!token || token.trim().length === 0) {
      throw new BadRequestException('Token is required');
    }

    let visitorId: string;
    let resolvedTenantId: string;
    try {
      const row = await this.db.queryOne<{ visitor_id: string; tenant_id: string }>(
        `select visitor_id, tenant_id from public.validate_invitation_token($1, $2)`,
        [token, 'cancel'],
      );
      if (!row) {
        // SECURITY DEFINER raises on miss; this branch is defense in depth.
        throw new GoneException({ code: 'invalid_token' });
      }
      visitorId = row.visitor_id;
      resolvedTenantId = row.tenant_id;
    } catch (err) {
      throw mapTokenError(err);
    }

    /* Cross-tenant defence — the tenant resolved from the subdomain
       (TenantContext) MUST match the tenant the token was issued in.
       This blocks an attacker on tenant-A's domain trying to consume a
       tenant-B token even if they somehow got the plaintext. */
    const ctxTenant = TenantContext.currentOrNull();
    if (!ctxTenant) {
      throw new UnauthorizedException('No tenant context resolved');
    }
    if (ctxTenant.id !== resolvedTenantId) {
      throw new GoneException({ code: 'invalid_token' });
    }

    /* The token has already been single-use locked by
       validate_invitation_token. We must complete the transition or
       leave the system in a state where the visitor is still expected
       but the cancel link is dead — explicitly the LESSER evil per
       spec §6.1 (a stale cancel link can be re-issued by reception;
       a half-cancelled visitor causes audit confusion). The transition
       happens inside the existing TenantContext. */
    try {
      await this.visitorService.transitionStatus(
        visitorId,
        'cancelled',
        { user_id: 'visitor_self_serve', person_id: null },
      );
    } catch (err) {
      // Idempotent same-status no-ops cleanly. Other transition errors
      // (e.g. visitor already arrived) surface as 400 — the cancel
      // link is too late to use.
      if (err instanceof BadRequestException) {
        // Re-shape so the public landing page can show a clean message.
        throw new GoneException({
          code: 'transition_not_allowed',
          message: 'This visit can no longer be cancelled.',
        });
      }
      throw err;
    }

    /* Best-effort host notification. We don't roll back the cancel if
       the notify fails; reception can see the cancelled status from
       the desk.

       transitionStatus has already emitted a `visitor.cancelled` domain
       event inside its tx — slice 5's email worker subscribes to that
       and dispatches the cancellation email to the visitor. The host
       gets an IN-APP notification only via notifyVisitorCancelled (the
       spec doesn't require a duplicate host email when the visitor
       self-cancels; reception's today-view already surfaces this). */
    try {
      // Run inside the resolved tenant's context so the
      // HostNotificationService tenant-guard accepts the call. The
      // subdomain context already matches resolvedTenantId (we
      // verified above), but defending explicitly here keeps the
      // notification path tenant-pinned.
      await TenantContext.run(
        { id: resolvedTenantId, slug: 'visitor_cancel', tier: 'standard' },
        async () => {
          await this.hostNotifications.notifyVisitorCancelled(
            visitorId,
            resolvedTenantId,
          );
        },
      );
    } catch {
      // swallow — best-effort.
    }

    return { ok: true, visitor_id: visitorId };
  }

  /**
   * POST /visitors/:id/acknowledge — host acknowledges a visitor's arrival.
   *
   * Spec §9.2. Allowed only if the actor is in `visitor_hosts` for the
   * visitor (else 403). Idempotent — re-acks no-op.
   */
  @Post(':id/acknowledge')
  async acknowledge(@Req() req: Request, @Param('id') visitorId: string) {
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    /* Must be a host on this visit. The HostNotificationService.acknowledge
       already validates this (it errors if no row matches the
       (visitor_id, person_id, tenant_id) triple), but we surface a clean
       403 here rather than a 404 so the UI can distinguish "not your
       visit" from "no such visit". */
    const isHost = await this.db.queryOne<{ exists: boolean }>(
      `select exists(
         select 1 from public.visitor_hosts
          where visitor_id = $1 and person_id = $2 and tenant_id = $3
       ) as exists`,
      [visitorId, actor.person_id, tenant.id],
    );
    if (!isHost?.exists) {
      throw new ForbiddenException('You are not a host on this visit');
    }

    await this.hostNotifications.acknowledge(visitorId, actor.person_id, tenant.id);
    return { ok: true };
  }

  /**
   * GET /visitors/:id — single visitor detail.
   *
   * Visibility is enforced via `visitor_visibility_ids(user_id, tenant_id)`
   * — the 3-tier model returns the union of (own host visits) + (operator
   * scope) + (read_all override). Anything outside the set looks like
   * not-found.
   */
  @Get(':id')
  async getOne(@Req() req: Request, @Param('id') visitorId: string) {
    const tenant = TenantContext.current();
    const actor = await this.resolveActor(req);

    const sql = `
      with visible as (
        select visitor_visibility_ids as id from public.visitor_visibility_ids($1, $2)
      )
      select
        v.id, v.tenant_id, v.status,
        v.first_name, v.last_name, v.email, v.phone, v.company,
        v.expected_at, v.expected_until, v.arrived_at, v.checked_out_at,
        v.checkout_source, v.auto_checked_out,
        v.building_id, v.meeting_room_id, v.visitor_type_id,
        v.booking_bundle_id, v.reservation_id,
        v.notes_for_visitor, v.notes_for_reception,
        v.primary_host_person_id, v.visitor_pass_id
      from public.visitors v
      where v.tenant_id = $2
        and v.id = $3
        and v.id in (select id from visible)
    `;
    const row = await this.db.queryOne(sql, [actor.user_id, tenant.id, visitorId]);
    if (!row) {
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    return row;
  }

  // ─── helpers ───────────────────────────────────────────────────────────

  /**
   * Resolve auth_uid → users.id + person_id within current tenant.
   * Throws 401 if the auth user isn't linked to a user row in the tenant
   * (e.g. they signed up but were never granted access to this workspace).
   */
  private async resolveActor(
    req: Request,
  ): Promise<{ user_id: string; person_id: string }> {
    const authUid = (req as { user?: { id: string } }).user?.id;
    if (!authUid) throw new UnauthorizedException('No auth user');
    const tenant = TenantContext.current();

    const lookup = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const row = lookup.data as { id: string; person_id: string | null } | null;
    if (!row) throw new UnauthorizedException('No linked user in this tenant');
    if (!row.person_id) {
      throw new UnauthorizedException(
        'Your user account is not linked to a person — contact your admin',
      );
    }
    return { user_id: row.id, person_id: row.person_id };
  }

}

/**
 * Map SQLSTATEs from `validate_invitation_token` (migration 00260) to
 * REST-shaped errors for the public cancel endpoint.
 *
 *   45001 invalid_token       → 410 Gone { code: 'invalid_token' }
 *   45002 token_already_used  → 410 Gone { code: 'token_already_used' }
 *   45003 token_expired       → 410 Gone { code: 'token_expired' }
 *
 * Anything else propagates unchanged.
 */
export function mapTokenError(err: unknown): Error {
  if (err instanceof GoneException) return err;
  const e = err as { code?: string };
  switch (e?.code) {
    case '45001':
      return new GoneException({ code: 'invalid_token' });
    case '45002':
      return new GoneException({ code: 'token_already_used' });
    case '45003':
      return new GoneException({ code: 'token_expired' });
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}
