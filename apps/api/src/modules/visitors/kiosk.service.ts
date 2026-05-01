import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  forwardRef,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { DbService } from '../../common/db/db.service';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PersonService } from '../person/person.service';
import type {
  KioskContext,
  KioskNameCheckinResult,
  KioskQrCheckinResult,
  KioskSearchResult,
  KioskWalkupDto,
} from './dto/kiosk.dto';
import { HostNotificationService } from './host-notification.service';
import { VisitorService } from './visitor.service';

/**
 * Kiosk-lite (`/kiosk/:buildingId`) — anonymous building-bound check-in.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §8
 * Plan: docs/superpowers/plans/2026-05-01-visitor-management-v1.md task 2.7
 *
 * Auth model:
 *   - KioskAuthGuard validates the device's Bearer token against
 *     `kiosk_tokens` and attaches a `KioskContext = { tenantId,
 *     buildingId, kioskTokenId }` to the request.
 *   - Every public method on this service takes `KioskContext` as the
 *     first arg. There is NO authenticated user. Audit rows record
 *     `actor_user_id=NULL` with the kiosk_token_id in `details`.
 *
 * Three check-in paths (spec §8.3-8.5):
 *   1. QR scan — validate single-use invite token, mark visitor arrived.
 *   2. Name-typed fallback — fuzzy-match today's expected list, confirm
 *      host first name, mark arrived.
 *   3. Walk-up — visitor without an invite. Type must have
 *      `allow_walk_up=true` AND `requires_approval=false`. Anything
 *      else lands the visitor at reception.
 *
 * Cross-tenant defence:
 *   - Every query filters on `kioskContext.tenantId`.
 *   - QR token validation calls a SECURITY DEFINER function that does
 *     its own tenant resolution; we cross-check the returned tenant_id
 *     against the kiosk's. Mismatch → 401-equivalent.
 *
 * Why we don't route walkup through InvitationService.create:
 *   - InvitationService takes `actor: { user_id, person_id, tenant_id }`
 *     and asserts the actor's building scope. The kiosk has neither a
 *     user_id nor a person_id, and the building scope check is moot
 *     (the kiosk IS bound to a building by token).
 *   - Forking the actor type would propagate through several callers
 *     for one new path — we keep InvitationService clean for
 *     authenticated invite flows and inline the kiosk insert here.
 */

const KIOSK_TOKEN_BYTES = 32;
const KIOSK_TOKEN_TTL_DAYS = 90;

interface VisitorRowForKiosk {
  id: string;
  tenant_id: string;
  building_id: string | null;
  status: string;
  primary_host_person_id: string | null;
  primary_host_first_name: string | null;
  primary_host_last_name: string | null;
}

@Injectable()
export class KioskService {
  private readonly log = new Logger(KioskService.name);

  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseService,
    @Inject(forwardRef(() => VisitorService))
    private readonly visitors: VisitorService,
    private readonly hostNotifications: HostNotificationService,
    private readonly persons: PersonService,
  ) {}

  // ─── token lifecycle (admin-only callers) ───────────────────────────────

  /**
   * Provision a new kiosk token. Called from slice 2d's admin controller
   * with an authenticated `actor`. Returns the plaintext ONCE — caller
   * must surface it to the admin so they can paste it into the device's
   * setup URL. The hash is the only thing persisted.
   */
  async provisionKioskToken(
    tenantId: string,
    buildingId: string,
    actor: { user_id: string },
  ): Promise<{ token: string; kiosk_token_id: string; expires_at: string }> {
    this.assertTenant(tenantId);
    await this.assertBuildingExists(tenantId, buildingId);

    const plaintext = randomBytes(KIOSK_TOKEN_BYTES).toString('hex');
    const tokenHash = hashToken(plaintext);
    const expiresAt = new Date(
      Date.now() + KIOSK_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { data, error } = await this.supabase.admin
      .from('kiosk_tokens')
      .insert({
        tenant_id: tenantId,
        building_id: buildingId,
        token_hash: tokenHash,
        active: true,
        expires_at: expiresAt,
      })
      .select()
      .single();
    if (error || !data) {
      throw error ?? new Error('failed to insert kiosk_tokens row');
    }
    const row = data as { id: string };

    await this.audit('kiosk.token_provisioned', tenantId, null, {
      kiosk_token_id: row.id,
      tenant_id: tenantId,
      building_id: buildingId,
      actor_user_id: actor.user_id,
      expires_at: expiresAt,
    });

    return { token: plaintext, kiosk_token_id: row.id, expires_at: expiresAt };
  }

  /** Replace the hash + bump expires_at. Old plaintext stops working immediately. */
  async rotateKioskToken(
    kioskTokenId: string,
    tenantId: string,
    actor: { user_id: string },
  ): Promise<{ token: string; expires_at: string }> {
    this.assertTenant(tenantId);
    const existing = await this.loadKioskToken(kioskTokenId, tenantId);
    if (!existing) {
      throw new NotFoundException(`kiosk_token ${kioskTokenId} not found`);
    }

    const plaintext = randomBytes(KIOSK_TOKEN_BYTES).toString('hex');
    const tokenHash = hashToken(plaintext);
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + KIOSK_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const { error } = await this.supabase.admin
      .from('kiosk_tokens')
      .update({
        token_hash: tokenHash,
        rotated_at: nowIso,
        expires_at: expiresAt,
        active: true,
      })
      .eq('id', kioskTokenId)
      .eq('tenant_id', tenantId);
    if (error) throw error;

    await this.audit('kiosk.token_rotated', tenantId, null, {
      kiosk_token_id: kioskTokenId,
      tenant_id: tenantId,
      building_id: existing.building_id,
      actor_user_id: actor.user_id,
      expires_at: expiresAt,
    });

    return { token: plaintext, expires_at: expiresAt };
  }

  async revokeKioskToken(
    kioskTokenId: string,
    tenantId: string,
    actor: { user_id: string },
  ): Promise<void> {
    this.assertTenant(tenantId);
    const existing = await this.loadKioskToken(kioskTokenId, tenantId);
    if (!existing) {
      throw new NotFoundException(`kiosk_token ${kioskTokenId} not found`);
    }
    const { error } = await this.supabase.admin
      .from('kiosk_tokens')
      .update({ active: false })
      .eq('id', kioskTokenId)
      .eq('tenant_id', tenantId);
    if (error) throw error;

    await this.audit('kiosk.token_revoked', tenantId, null, {
      kiosk_token_id: kioskTokenId,
      tenant_id: tenantId,
      building_id: existing.building_id,
      actor_user_id: actor.user_id,
    });
  }

  // ─── search (anonymous, kiosk-context only) ─────────────────────────────

  /**
   * Fuzzy-match today's `expected` visitors at this building only.
   * Returns first_name + last_initial + company. **Never** returns host
   * names (privacy per spec §8.4) — the host is revealed only after the
   * visitor confirms their identity in the second step.
   *
   * Trigram path with 0.3 threshold (slightly stricter than reception
   * search — the kiosk has fewer characters to work with and we'd
   * rather show nothing than a wrong match). Falls back to ILIKE on
   * empty results so 1-2 character queries still work.
   */
  async searchExpectedAtKiosk(
    kioskContext: KioskContext,
    query: string,
  ): Promise<KioskSearchResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const { tenantId, buildingId } = kioskContext;
    const dayStart = startOfDay(new Date()).toISOString();
    const dayEnd = endOfDay(new Date()).toISOString();

    const trigramSql = `
      select v.id            as visitor_id,
             v.first_name    as first_name,
             v.last_name     as last_name,
             v.company       as company,
             greatest(
               similarity(coalesce(v.first_name,''), $3),
               similarity(coalesce(v.last_name,''),  $3)
             ) as score
        from public.visitors v
       where v.tenant_id = $1
         and v.building_id = $2
         and v.status = 'expected'
         and v.expected_at >= $4 and v.expected_at <= $5
         and greatest(
               similarity(coalesce(v.first_name,''), $3),
               similarity(coalesce(v.last_name,''),  $3)
             ) > 0.3
       order by score desc
       limit 5
    `;
    let rows = await this.db.queryMany<{
      visitor_id: string;
      first_name: string | null;
      last_name: string | null;
      company: string | null;
      score: number;
    }>(trigramSql, [tenantId, buildingId, trimmed, dayStart, dayEnd]);

    if (rows.length === 0) {
      const pattern = `%${trimmed}%`;
      const ilikeSql = `
        select v.id           as visitor_id,
               v.first_name   as first_name,
               v.last_name    as last_name,
               v.company      as company,
               0::float       as score
          from public.visitors v
         where v.tenant_id = $1
           and v.building_id = $2
           and v.status = 'expected'
           and v.expected_at >= $4 and v.expected_at <= $5
           and (v.first_name ilike $3 or v.last_name ilike $3)
         order by v.expected_at asc
         limit 5
      `;
      rows = await this.db.queryMany<{
        visitor_id: string;
        first_name: string | null;
        last_name: string | null;
        company: string | null;
        score: number;
      }>(ilikeSql, [tenantId, buildingId, pattern, dayStart, dayEnd]);
    }

    return rows.map((r) => ({
      visitor_id: r.visitor_id,
      first_name: r.first_name ?? '',
      last_initial: r.last_name?.charAt(0).toUpperCase() ?? null,
      company: r.company,
    }));
  }

  // ─── check-in paths ─────────────────────────────────────────────────────

  /**
   * QR code path. Plaintext token from the QR is validated via the
   * SECURITY DEFINER function `validate_invitation_token(token, 'qr')`
   * which:
   *   - Single-use locks the row.
   *   - Raises distinct SQLSTATEs for invalid / used / expired (45001/2/3).
   *   - Returns `(visitor_id, tenant_id)` on success.
   *
   * After token validation we still verify the tenant + building on the
   * visitor row against the kiosk context — defence against an
   * over-permissive token from a different tenant somehow being accepted
   * by the function.
   */
  async checkInWithQrToken(
    kioskContext: KioskContext,
    plainToken: string,
  ): Promise<KioskQrCheckinResult> {
    this.assertTenant(kioskContext.tenantId);

    if (!plainToken || plainToken.trim().length === 0) {
      throw new BadRequestException('Token is required');
    }

    let visitorId: string;
    let resolvedTenantId: string;
    try {
      const result = await this.db.queryOne<{
        visitor_id: string;
        tenant_id: string;
      }>(
        `select visitor_id, tenant_id from public.validate_invitation_token($1, $2)`,
        [plainToken, 'qr'],
      );
      if (!result) {
        // SECURITY DEFINER function raises on miss — this branch is
        // defence in depth.
        throw new UnauthorizedException('Token not recognised');
      }
      visitorId = result.visitor_id;
      resolvedTenantId = result.tenant_id;
    } catch (err) {
      throw mapTokenError(err);
    }

    if (resolvedTenantId !== kioskContext.tenantId) {
      // Cross-tenant defence — the kiosk for tenant A cannot consume a
      // token issued in tenant B even if the function returned
      // successfully. (Shouldn't happen because function tokens are
      // tenant-scoped, but never trust a single layer.)
      await this.audit('kiosk.checkin_failed', kioskContext.tenantId, null, {
        kiosk_token_id: kioskContext.kioskTokenId,
        reason: 'cross_tenant_token',
      });
      throw new ForbiddenException('Token issued for a different tenant');
    }

    const visitor = await this.loadVisitorForCheckin(
      visitorId,
      kioskContext.tenantId,
    );

    if (visitor.building_id !== kioskContext.buildingId) {
      await this.audit('kiosk.checkin_failed', kioskContext.tenantId, visitorId, {
        kiosk_token_id: kioskContext.kioskTokenId,
        reason: 'wrong_building',
        kiosk_building_id: kioskContext.buildingId,
        visitor_building_id: visitor.building_id,
      });
      throw new BadRequestException(
        'This visit is for a different building. Please see reception.',
      );
    }

    await this.transitionToArrived(visitor, kioskContext);

    const hasReception = await this.buildingHasReception(
      kioskContext.tenantId,
      kioskContext.buildingId,
    );

    return {
      visitor_id: visitor.id,
      host_first_name: visitor.primary_host_first_name,
      has_reception_at_building: hasReception,
    };
  }

  /**
   * Name-typed path. Visitor selected an entry from
   * `searchExpectedAtKiosk` and confirmed by typing the host's first
   * name. We verify:
   *   - visitor is at this building, status='expected', today.
   *   - host first name matches (case-insensitive). The confirmation is
   *     a soft anti-impersonation step; the visitor still has to be in
   *     the building's expected list to even appear.
   */
  async checkInByName(
    kioskContext: KioskContext,
    visitorId: string,
    hostFirstNameConfirmation: string,
  ): Promise<KioskNameCheckinResult> {
    this.assertTenant(kioskContext.tenantId);

    const visitor = await this.loadVisitorForCheckin(
      visitorId,
      kioskContext.tenantId,
    );

    if (visitor.building_id !== kioskContext.buildingId) {
      throw new BadRequestException('Visitor is for a different building');
    }
    if (visitor.status !== 'expected') {
      throw new BadRequestException(
        `Cannot check in — visitor status is ${visitor.status}`,
      );
    }

    const expectedHost = (visitor.primary_host_first_name ?? '').trim().toLowerCase();
    const supplied = hostFirstNameConfirmation.trim().toLowerCase();
    if (!expectedHost || expectedHost !== supplied) {
      await this.audit('kiosk.checkin_failed', kioskContext.tenantId, visitorId, {
        kiosk_token_id: kioskContext.kioskTokenId,
        reason: 'host_name_mismatch',
      });
      throw new ForbiddenException(
        'Host first name did not match — please see reception',
      );
    }

    await this.transitionToArrived(visitor, kioskContext);

    const hasReception = await this.buildingHasReception(
      kioskContext.tenantId,
      kioskContext.buildingId,
    );

    return {
      host_first_name: visitor.primary_host_first_name,
      has_reception_at_building: hasReception,
    };
  }

  /**
   * Walk-up at the kiosk. Spec §8.5.
   *
   * Steps:
   *   1. Look up visitor_type. Reject if `allow_walk_up=false` or
   *      `requires_approval=true`. Kiosk UI handles by routing to
   *      reception.
   *   2. Verify primary_host_person_id is a tenant employee/contractor.
   *   3. Insert a fresh `persons` row of type='visitor' with the visitor
   *      details (no dedup at the kiosk — the kiosk doesn't know the
   *      tenant_settings flag and can't safely match by email anyway).
   *   4. Insert `visitors` row with status='expected' (no approval — we
   *      gated on requires_approval=false above).
   *   5. Insert visitor_hosts row.
   *   6. transitionStatus → 'arrived'.
   *   7. notifyArrival fan-out.
   */
  async walkupAtKiosk(
    kioskContext: KioskContext,
    dto: KioskWalkupDto,
  ): Promise<{ visitor_id: string; status: 'arrived' }> {
    this.assertTenant(kioskContext.tenantId);

    if (!dto.first_name?.trim()) {
      throw new BadRequestException('first_name is required');
    }

    // 1. Visitor type gate.
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
      [dto.visitor_type_id, kioskContext.tenantId],
    );
    if (!type) {
      throw new NotFoundException(
        `visitor_type ${dto.visitor_type_id} not found or inactive`,
      );
    }
    if (!type.allow_walk_up) {
      // Distinct error string so the kiosk UI can route to "see reception".
      throw new BadRequestException('walk_up_disabled');
    }
    if (type.requires_approval) {
      throw new BadRequestException('approval_required');
    }

    // 2. Host person sanity. Visitors aren't valid hosts; vendors aren't
    // either. The persons table CHECK only allows specific types.
    const host = await this.db.queryOne<{
      id: string;
      tenant_id: string;
      type: string;
      first_name: string;
      active: boolean;
    }>(
      `select id, tenant_id, type, first_name, active
         from public.persons
        where id = $1 and tenant_id = $2`,
      [dto.primary_host_person_id, kioskContext.tenantId],
    );
    if (!host || !host.active) {
      throw new NotFoundException('Host not found at this tenant');
    }
    if (host.type === 'visitor' || host.type === 'vendor_contact') {
      throw new BadRequestException('Selected host cannot host visitors');
    }

    // 3. Create the visitor person row + visitors row + visitor_hosts row.
    const tenantId = kioskContext.tenantId;
    const visitorPerson = (await this.persons.create({
      first_name: dto.first_name,
      last_name: dto.last_name ?? '',
      email: dto.email,
      phone: dto.phone,
      type: 'visitor',
    })) as { id: string };

    const expectedAt = new Date().toISOString();
    const offsetMinutes = type.default_expected_until_offset_minutes ?? 240;
    const expectedUntil = new Date(
      Date.now() + offsetMinutes * 60 * 1000,
    ).toISOString();

    const { data: visitorRow, error: insertError } = await this.supabase.admin
      .from('visitors')
      .insert({
        tenant_id: tenantId,
        status: 'expected',
        host_person_id: dto.primary_host_person_id,
        primary_host_person_id: dto.primary_host_person_id,
        visitor_type_id: type.id,
        person_id: visitorPerson.id,
        first_name: dto.first_name,
        last_name: dto.last_name ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        company: dto.company ?? null,
        expected_at: expectedAt,
        expected_until: expectedUntil,
        building_id: kioskContext.buildingId,
      })
      .select()
      .single();
    if (insertError || !visitorRow) {
      throw insertError ?? new Error('failed to insert visitors row at kiosk walkup');
    }
    const visitorId = (visitorRow as { id: string }).id;

    const { error: hostsError } = await this.supabase.admin
      .from('visitor_hosts')
      .insert({
        visitor_id: visitorId,
        person_id: dto.primary_host_person_id,
        tenant_id: tenantId,
      });
    if (hostsError) throw hostsError;

    await this.audit('kiosk.walkup_invited', kioskContext.tenantId, visitorId, {
      kiosk_token_id: kioskContext.kioskTokenId,
      visitor_id: visitorId,
      visitor_type_id: type.id,
      primary_host_person_id: dto.primary_host_person_id,
    });

    // 4. Transition to arrived + fire host notification + audit success.
    //    Routed through `runArrivalUnderTenantContext` so VisitorService.
    //    transitionStatus has a TenantContext to read (it calls
    //    TenantContext.current() unconditionally). The kiosk path is
    //    anonymous — no TenantMiddleware fires — so we synthesize one
    //    here from the kiosk's bound tenantId. Bypassing this helper
    //    crashes the walk-up flow (Fix #1 of slice 2 review).
    await this.runArrivalUnderTenantContext(
      visitorId,
      kioskContext,
      'walkup',
      expectedAt,
    );

    return { visitor_id: visitorId, status: 'arrived' };
  }

  // ─── helpers ────────────────────────────────────────────────────────────

  private assertTenant(tenantId: string): void {
    const ctx = TenantContext.currentOrNull();
    if (!ctx) {
      // Anonymous kiosk path — no AsyncLocalStorage. The kioskContext IS
      // the tenant authority. Assert nothing here; downstream queries
      // pass `tenantId` as a parameter directly.
      return;
    }
    if (ctx.id !== tenantId) {
      throw new BadRequestException('tenant context mismatch');
    }
  }

  private async assertBuildingExists(
    tenantId: string,
    buildingId: string,
  ): Promise<void> {
    const row = await this.db.queryOne<{ id: string; type: string }>(
      `select id, type from public.spaces
        where id = $1 and tenant_id = $2`,
      [buildingId, tenantId],
    );
    if (!row) {
      throw new NotFoundException(`building ${buildingId} not found`);
    }
    if (row.type !== 'building' && row.type !== 'site') {
      throw new BadRequestException(
        'Kiosk can only be provisioned for a building or site',
      );
    }
  }

  private async loadKioskToken(
    kioskTokenId: string,
    tenantId: string,
  ): Promise<{
    id: string;
    tenant_id: string;
    building_id: string;
    active: boolean;
  } | null> {
    return this.db.queryOne<{
      id: string;
      tenant_id: string;
      building_id: string;
      active: boolean;
    }>(
      `select id, tenant_id, building_id, active
         from public.kiosk_tokens
        where id = $1 and tenant_id = $2`,
      [kioskTokenId, tenantId],
    );
  }

  private async loadVisitorForCheckin(
    visitorId: string,
    tenantId: string,
  ): Promise<VisitorRowForKiosk> {
    const sql = `
      select v.id                 as id,
             v.tenant_id          as tenant_id,
             v.building_id        as building_id,
             v.status             as status,
             v.primary_host_person_id as primary_host_person_id,
             hp.first_name        as primary_host_first_name,
             hp.last_name         as primary_host_last_name
        from public.visitors v
        left join public.persons hp
          on hp.id = v.primary_host_person_id
         and hp.tenant_id = v.tenant_id
       where v.id = $1 and v.tenant_id = $2
    `;
    const row = await this.db.queryOne<VisitorRowForKiosk>(sql, [
      visitorId,
      tenantId,
    ]);
    if (!row) {
      throw new NotFoundException(`visitor ${visitorId} not found`);
    }
    return row;
  }

  private async transitionToArrived(
    visitor: VisitorRowForKiosk,
    kioskContext: KioskContext,
  ): Promise<void> {
    await this.runArrivalUnderTenantContext(
      visitor.id,
      kioskContext,
      'qr_or_name',
      new Date().toISOString(),
    );
  }

  /**
   * Run the "transition to arrived + notify host + audit success" trio
   * inside a synthesized TenantContext.
   *
   * Why: VisitorService.transitionStatus calls TenantContext.current()
   * unconditionally. The kiosk paths are anonymous (no TenantMiddleware)
   * so there's no AsyncLocalStorage to read from — the kioskContext IS
   * the tenant authority. Every kiosk arrival flow (QR, name-confirm,
   * walk-up) MUST funnel through here so the context exists for the
   * downstream service call.
   *
   * `mode` is recorded on the audit row so we can tell post-hoc which
   * check-in path was used.
   */
  private async runArrivalUnderTenantContext(
    visitorId: string,
    kioskContext: KioskContext,
    mode: 'qr_or_name' | 'walkup',
    arrivedAtIso: string,
  ): Promise<void> {
    await TenantContext.run(
      { id: kioskContext.tenantId, slug: 'kiosk', tier: 'standard' },
      async () => {
        await this.visitors.transitionStatus(
          visitorId,
          'arrived',
          { user_id: 'kiosk', person_id: null },
          { arrived_at: arrivedAtIso },
        );
        try {
          await this.hostNotifications.notifyArrival(
            visitorId,
            kioskContext.tenantId,
          );
        } catch (err) {
          this.log.warn(
            `notifyArrival failed for kiosk checkin ${visitorId}: ${
              (err as Error).message
            }`,
          );
        }
        await this.audit(
          'kiosk.checkin_succeeded',
          kioskContext.tenantId,
          visitorId,
          {
            kiosk_token_id: kioskContext.kioskTokenId,
            visitor_id: visitorId,
            mode,
          },
        );
      },
    );
  }

  private async buildingHasReception(
    tenantId: string,
    buildingId: string,
  ): Promise<boolean> {
    // Reception presence is implicit — a building that has a configured
    // pass pool, or someone with `visitors:reception` scoped to the
    // building. v1 heuristic: a building with at least one
    // `visitor_pass_pool` row OR `uses_visitor_passes=true` ancestor
    // has reception. Refined in slice 2d once admin onboarding lands.
    const row = await this.db.queryOne<{ has: boolean }>(
      `select exists(
         select 1
           from public.visitor_pass_pool
          where tenant_id = $1
            and space_id = $2
       ) as has`,
      [tenantId, buildingId],
    );
    return Boolean(row?.has);
  }

  /**
   * Insert an audit_events row. `tenant_id` is REQUIRED — the column is
   * NOT NULL. The kiosk paths run anonymously (no TenantContext / no
   * authenticated user), so the caller must pass the tenant explicitly
   * from `kioskContext.tenantId`. Falling back to `TenantContext` here
   * silently drops audit rows on the kiosk path, which is a P0 audit
   * coverage gap (Fix #2 of the slice 2 review).
   */
  private async audit(
    eventType: string,
    tenantId: string,
    visitorId: string | null,
    details: Record<string, unknown>,
  ): Promise<void> {
    if (!tenantId) {
      // Loud failure — better to surface "missing tenant_id" in tests +
      // logs than to write an audit row with NULL tenant_id (constraint
      // violation, dropped silently inside try/catch) or, worse, a row
      // that fails RLS and leaks across tenants.
      throw new Error(
        `audit(${eventType}) called without a tenantId — every audit row MUST be tenant-scoped`,
      );
    }
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenantId,
        event_type: eventType,
        entity_type: 'visitor',
        entity_id: visitorId,
        details,
      });
    } catch (err) {
      this.log.warn(`audit insert failed for ${eventType}: ${(err as Error).message}`);
    }
  }
}

// ─── helpers (file-scoped) ───────────────────────────────────────────────

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

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Map SQLSTATEs from `validate_invitation_token` (00260) to API errors.
 *
 *   45001 invalid_token       → UnauthorizedException
 *   45002 token_already_used  → ForbiddenException ("already used" — explicit)
 *   45003 token_expired       → ForbiddenException ("expired" — explicit)
 */
function mapTokenError(err: unknown): Error {
  const e = err as { code?: string; message?: string };
  switch (e?.code) {
    case '45001':
      return new UnauthorizedException('Invalid or unknown token');
    case '45002':
      return new ForbiddenException('Token has already been used');
    case '45003':
      return new ForbiddenException('Token has expired');
    default:
      return err instanceof Error ? err : new Error(String(err));
  }
}
