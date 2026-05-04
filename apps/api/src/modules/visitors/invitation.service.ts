import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertTenantOwned, assertTenantOwnedAll } from '../../common/tenant-validation';
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

    // Plan A.4 / Commit 9 (I5) / round-4 codex flag invitation.service.ts:140-142.
    // dto.meeting_room_id (FK to spaces) and dto.booking_id (FK to
    // bookings) are written into the visitors row at lines 141-142
    // below. Both FKs prove global existence only; supabase.admin
    // bypasses RLS so a foreign-tenant uuid would land on the visitors
    // row blind, leaking the cross-tenant reference into reception
    // workflows + lobby panel + audit trail. Validate before insert.
    //
    // building_id is already validated by assertBuildingInScope (above)
    // — that gate enforces actor authorization, but it doesn't enforce
    // tenant — duplicate the tenant check here for defense-in-depth?
    // No: the scope-closure helper resolves spaces via the actor's
    // own person_org_memberships, which are tenant-scoped at the source.
    // Adding another assertTenantOwned here would be redundant.
    if (dto.meeting_room_id) {
      await assertTenantOwned(
        this.supabase,
        'spaces',
        dto.meeting_room_id,
        tenant.id,
        { entityName: 'meeting room' },
      );
    }
    if (dto.booking_id) {
      await assertTenantOwned(
        this.supabase,
        'bookings',
        dto.booking_id,
        tenant.id,
        { entityName: 'booking' },
      );
    }

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
    //
    // `visit_date` is the legacy NOT NULL DATE column from migration
    // 00015. The v1 rebuild moved the source-of-truth to `expected_at`
    // (timestamptz) but never made visit_date nullable / default-derived,
    // so we MUST populate it here. The privacy-compliance adapter reads
    // `coalesce(expected_at::date, visit_date)` so consistency is the
    // contract — not a different value. Compute from the same ISO so
    // they always match.
    const visitDate = isoToVisitDate(dto.expected_at);
    // Post-canonicalisation (2026-05-02): visitors link to a single
    // booking via `visitors.booking_id` — the legacy dual-link
    // (booking_bundle_id + reservation_id, 00252:36-37) is gone. The
    // DTO `booking_bundle_id` alias was retired in the post-canonical
    // cleanup; only `dto.booking_id` is accepted now.
    const bookingId = dto.booking_id ?? null;
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
        visit_date: visitDate,                      // derived from expected_at; legacy NOT NULL
        building_id: dto.building_id,
        meeting_room_id: dto.meeting_room_id ?? null,
        booking_id: bookingId,                      // 00278:41 (renamed from booking_bundle_id)
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
    //
    // Plan A.2 / Commit 5 / gap map §invitation.service.ts:159-165.
    // Pre-fix, dto.co_host_person_ids was inserted blind into
    // visitor_hosts. The FK on visitor_hosts.person_id → persons(id)
    // only proves global existence; supabase.admin bypasses RLS, so a
    // foreign-tenant person uuid would land as a co-host — gaining
    // visibility on the visit + appearing in host-side notifications.
    // Validate before the insert so a clean 400 surfaces upstream.
    const coHostsToValidate = (dto.co_host_person_ids ?? []).filter(
      (id) => id !== actor.person_id,
    );
    if (coHostsToValidate.length > 0) {
      await assertTenantOwnedAll(
        this.supabase,
        'persons',
        coHostsToValidate,
        tenant.id,
        { entityName: 'co-host persons' },
      );
    }

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
          /* The cancel_token plaintext is embedded in the domain_event
             payload so slice 5's email worker can build the cancel-link
             URL without ever re-issuing or re-hashing the token. The
             token sha256 is the only thing on disk in
             visit_invitation_tokens; the plaintext exists transiently
             in this row until the worker consumes it.

             Privacy: as of migration 00269, public.domain_events is
             service-role-only — `authenticated` and `anon` no longer
             have SELECT/INSERT/UPDATE/DELETE on the table. The email
             worker reads the payload via the service-role client; no
             tenant user can harvest cancel tokens through PostgREST.
             RLS still enforces tenant isolation defense-in-depth. */
          payload: {
            visitor_id: visitorId,
            primary_host_person_id: actor.person_id,
            building_id: dto.building_id,
            cancel_token: plaintext,
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

/**
 * Derive a `YYYY-MM-DD` DATE string from an ISO 8601 timestamp using the
 * UTC calendar day. Postgres accepts this directly into a DATE column.
 *
 * UTC was chosen over local time because the API server has no client
 * timezone context — using server-local time on a UTC server vs. a CET
 * server would silently shift the date. The privacy adapter compares
 * `expected_at::date` (Postgres' UTC default) with this column, so UTC
 * here keeps both sides aligned.
 */
function isoToVisitDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Should be unreachable — zod schema guards this — but fall back to
    // today UTC rather than insert NULL into a NOT NULL column.
    const now = new Date();
    return now.toISOString().slice(0, 10);
  }
  return d.toISOString().slice(0, 10);
}
