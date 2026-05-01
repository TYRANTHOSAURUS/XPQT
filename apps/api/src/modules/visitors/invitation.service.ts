import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PersonService } from '../person/person.service';
import type { CreateInvitationDto } from './dto/create-invitation.dto';

export interface InvitationActor {
  user_id: string;
  person_id: string;
  /** Tenant of the actor; sanity-checked against TenantContext.current(). */
  tenant_id: string;
}

export interface CreateInvitationResult {
  visitor_id: string;
  status: 'expected' | 'pending_approval';
  approval_id: string | null;
  /**
   * Plaintext cancel-link token. Returned to internal callers (slice 5
   * email worker uses it to populate the email body) and never exposed via
   * the REST controller's response. Stored only as sha256(hash).
   */
  cancel_token: string;
}

interface VisitorTypeRow {
  id: string;
  tenant_id: string;
  requires_approval: boolean;
  allow_walk_up: boolean;
  default_expected_until_offset_minutes: number | null;
  active: boolean;
}

/**
 * Visitor invite flow.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §6
 *
 * Order of operations (must NOT be reordered without re-reading the spec):
 *   1. Cross-building scope check — inviter's authorized closure must
 *      include `dto.building_id` (reviewer C3 fix; spec §6.3).
 *   2. Look up visitor_type — drives requires_approval branch + default
 *      expected_until offset.
 *   3. Resolve persons row — dedup via tenant setting; otherwise create
 *      a new visitor-typed persons row.
 *   4. INSERT visitors row directly with status = 'pending_approval' or
 *      'expected'. We do NOT route through transitionStatus for the
 *      initial insert: the §5 trigger fires on UPDATE OF status, not
 *      INSERT, and the matrix has no incoming edge to pending_approval/
 *      expected.
 *   5. INSERT visitor_hosts — primary host (actor) + each co-host id.
 *   6. INSERT visit_invitation_tokens — sha256 hash + plaintext returned.
 *   7. If pending_approval: INSERT approvals row. Slice 3 wires the
 *      dispatcher to call transitionStatus on grant/deny.
 *   8. Audit event.
 *   9. Return { visitor_id, status, approval_id, cancel_token }.
 */
@Injectable()
export class InvitationService {
  private readonly log = new Logger(InvitationService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly persons: PersonService,
  ) {}

  async create(
    dto: CreateInvitationDto,
    actor: InvitationActor,
  ): Promise<CreateInvitationResult> {
    const tenant = TenantContext.current();
    if (actor.tenant_id !== tenant.id) {
      // Cross-tenant defence — actor cannot drive an invite in a tenant
      // other than the one their context resolved to.
      throw new ForbiddenException('actor tenant mismatch');
    }

    // 1. Cross-building scope check.
    await this.assertBuildingInScope(actor.person_id, dto.building_id);

    // 2. Visitor type lookup.
    const visitorType = await this.loadVisitorType(dto.visitor_type_id);
    if (!visitorType) {
      throw new NotFoundException(
        `visitor_type ${dto.visitor_type_id} not found or inactive`,
      );
    }

    // 3. Persons row resolution (dedup or create).
    const visitorPersonId = await this.resolvePersonForVisitor(dto);

    // 4. Determine status + expected_until.
    const status: 'pending_approval' | 'expected' = visitorType.requires_approval
      ? 'pending_approval'
      : 'expected';

    const expectedUntil = dto.expected_until ?? this.defaultExpectedUntil(
      dto.expected_at,
      visitorType.default_expected_until_offset_minutes ?? 240,
    );

    // 5. INSERT visitors row directly. Slice 1's CHECK constraints
    // validate the status enum + the logged_after_arrived invariant
    // (logged_at is null on insert; satisfied trivially).
    const { data: visitorRow, error: insertError } = await this.supabase.admin
      .from('visitors')
      .insert({
        tenant_id: tenant.id,
        status,
        host_person_id: actor.person_id,            // legacy adapter alignment (spec §14.2)
        primary_host_person_id: actor.person_id,    // canonical
        visitor_type_id: visitorType.id,
        person_id: visitorPersonId,                 // visitors.persons FK (spec §3)
        first_name: dto.first_name,                 // legacy denorm; PII canonical on persons
        last_name: dto.last_name ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        company: dto.company ?? null,
        expected_at: dto.expected_at,
        expected_until: expectedUntil,
        building_id: dto.building_id,
        meeting_room_id: dto.meeting_room_id ?? null,
        booking_bundle_id: dto.booking_bundle_id ?? null,
        reservation_id: dto.reservation_id ?? null,
        notes_for_visitor: dto.notes_for_visitor ?? null,
        notes_for_reception: dto.notes_for_reception ?? null,
      })
      .select()
      .single();
    if (insertError || !visitorRow) {
      throw insertError ?? new Error('failed to insert visitors row');
    }
    const visitorId = (visitorRow as { id: string }).id;

    // 6. visitor_hosts — primary + co-hosts.
    const hostRows = [
      {
        visitor_id: visitorId,
        person_id: actor.person_id,
        tenant_id: tenant.id,
      },
      ...(dto.co_host_person_ids ?? [])
        .filter((id) => id !== actor.person_id)            // de-dupe primary
        .map((id) => ({
          visitor_id: visitorId,
          person_id: id,
          tenant_id: tenant.id,
        })),
    ];
    const { error: hostsError } = await this.supabase.admin
      .from('visitor_hosts')
      .insert(hostRows);
    if (hostsError) throw hostsError;

    // 7. Cancel-link token (plaintext returned; only sha256 hash persisted).
    const plaintext = randomBytes(32).toString('hex');                   // 64 hex chars
    const tokenHash = createHash('sha256').update(plaintext).digest('hex');
    const tokenExpiresAt = new Date(
      new Date(dto.expected_at).getTime() + 24 * 60 * 60 * 1000,
    ).toISOString();
    const { error: tokenErr } = await this.supabase.admin
      .from('visit_invitation_tokens')
      .insert({
        tenant_id: tenant.id,
        visitor_id: visitorId,
        token_hash: tokenHash,
        purpose: 'cancel',
        expires_at: tokenExpiresAt,
      });
    if (tokenErr) throw tokenErr;

    // 8. Approval routing (only when type requires approval).
    let approvalId: string | null = null;
    if (status === 'pending_approval') {
      const { data: approval, error: apErr } = await this.supabase.admin
        .from('approvals')
        .insert({
          tenant_id: tenant.id,
          target_entity_type: 'visitor_invite',
          target_entity_id: visitorId,
          status: 'pending',
          // approver_person_id / approver_team_id are populated by the
          // approval routing dispatcher (slice 3). For the v1 cut, we
          // ship the unrouted row and let slice 3 fan out per type.
        })
        .select()
        .single();
      if (apErr || !approval) throw apErr ?? new Error('approval create failed');
      approvalId = (approval as { id: string }).id;
    }

    // 9. Audit. Best-effort — do not roll back the invite if audit fails.
    try {
      await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant.id,
        event_type: 'visitor.invited',
        entity_type: 'visitor',
        entity_id: visitorId,
        details: {
          visitor_id: visitorId,
          host_person_id: actor.person_id,
          visitor_type_id: visitorType.id,
          building_id: dto.building_id,
          expected_at: dto.expected_at,
          status,
          has_approval: approvalId !== null,
          co_host_count: (dto.co_host_person_ids ?? []).length,
        },
      });
    } catch (err) {
      this.log.warn(`audit insert visitor.invited failed: ${(err as Error).message}`);
    }

    // For status='expected', slice 5's email worker will pick up the cancel
    // token + invite payload via a domain event. Emit it here so the worker
    // has a hook to subscribe; on pending_approval we hold the email until
    // the approval grants (slice 3 handler).
    if (status === 'expected') {
      try {
        await this.supabase.admin.from('domain_events').insert({
          tenant_id: tenant.id,
          event_type: 'visitor.invitation.expected',
          entity_type: 'visitor',
          entity_id: visitorId,
          payload: {
            visitor_id: visitorId,
            primary_host_person_id: actor.person_id,
            building_id: dto.building_id,
          },
        });
      } catch (err) {
        this.log.warn(`domain_events emit failed: ${(err as Error).message}`);
      }
    }

    return {
      visitor_id: visitorId,
      status,
      approval_id: approvalId,
      cancel_token: plaintext,
    };
  }

  /**
   * Confirm `building_id` is inside the actor's authorized space closure.
   * Uses the `portal_authorized_space_ids` RPC which already accounts for
   * default_location + person_location_grants + org_node_location_grants
   * (migration 00080's three-tier source list).
   */
  private async assertBuildingInScope(personId: string, buildingId: string): Promise<void> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin.rpc('portal_authorized_space_ids', {
      p_person_id: personId,
      p_tenant_id: tenant.id,
    });
    if (error) throw error;

    // The function returns either an array of uuids OR an array of {id} rows
    // depending on the postgrest negotiation. Normalise.
    const ids = ((data ?? []) as Array<string | { id: string }>).map((row) =>
      typeof row === 'string' ? row : row.id,
    );

    if (!ids.includes(buildingId)) {
      throw new ForbiddenException(
        "You don't have access to invite visitors at this building. Contact your admin.",
      );
    }
  }

  private async loadVisitorType(typeId: string): Promise<VisitorTypeRow | null> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('visitor_types')
      .select('id, tenant_id, requires_approval, allow_walk_up, default_expected_until_offset_minutes, active')
      .eq('id', typeId)
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .maybeSingle();
    if (error) throw error;
    return (data as VisitorTypeRow | null) ?? null;
  }

  private async resolvePersonForVisitor(dto: CreateInvitationDto): Promise<string> {
    const tenant = TenantContext.current();

    if (dto.email && (await this.isDedupEnabled())) {
      const existing = await this.findExistingVisitorPersonByEmail(dto.email);
      if (existing) return existing.id;
    }

    // No dedup hit — create a fresh visitor-typed persons row. Visitors
    // never get an org_node membership or default_location (spec §3).
    const created = await this.persons.create({
      first_name: dto.first_name,
      last_name: dto.last_name ?? '',
      email: dto.email ?? undefined,
      phone: dto.phone ?? undefined,
      type: 'visitor',
      // primary_org_node_id intentionally omitted — visitors aren't in the
      // requester org tree (spec §3 "persons row at invite").
      // is_external + default_location_id default appropriately at the DB
      // level (default_location_id NULL by default).
    });
    // Belt-and-braces: persons.create returns the row from PersonService
    // which includes the id we need. Tenant scoping is enforced by
    // PersonService via TenantContext.current(); no cross-tenant risk here.
    void tenant;
    return (created as { id: string }).id;
  }

  private async isDedupEnabled(): Promise<boolean> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenant_settings')
      .select('visitor_dedup_by_email')
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) {
      // Treat missing/empty tenant_settings as dedup OFF (safe default per spec).
      return false;
    }
    return Boolean((data as { visitor_dedup_by_email?: boolean } | null)?.visitor_dedup_by_email);
  }

  private async findExistingVisitorPersonByEmail(
    email: string,
  ): Promise<{ id: string } | null> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select('id, email')
      .eq('tenant_id', tenant.id)
      .eq('type', 'visitor')
      .eq('active', true)
      .eq('email', email)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null) ?? null;
  }

  private defaultExpectedUntil(expectedAt: string, offsetMinutes: number): string {
    return new Date(new Date(expectedAt).getTime() + offsetMinutes * 60 * 1000).toISOString();
  }
}
