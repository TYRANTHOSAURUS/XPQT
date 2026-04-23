import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { IntakeContext } from '@prequest/shared';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { TicketService } from '../ticket/ticket.service';
import {
  RequestTypeTrace,
  PortalSubmitDto,
} from './portal-submit.types';

/**
 * Portal submission resolver.
 *
 * Single path: the DTO carries request_type_id; validation is a single call to
 * public.request_type_requestable_trace(). tickets.requested_for_person_id is
 * populated from the DTO (defaults to the auth-bound requester).
 * See docs/service-catalog-live.md §6.
 */
@Injectable()
export class PortalSubmitService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ticketService: TicketService,
  ) {}

  async submit(authUid: string, dto: PortalSubmitDto) {
    const { intake, portal_trace, requested_for_person_id } =
      await this.resolvePortalSubmit(authUid, dto);

    const ticket = await this.ticketService.create({
      ticket_type_id: dto.request_type_id,
      title: dto.title,
      description: dto.description,
      priority: intake.priority,
      requester_person_id: intake.requester_person_id!,
      requested_for_person_id,
      location_id: portal_trace.effective_location_id ?? undefined,
      asset_id: intake.asset_id ?? undefined,
      impact: dto.impact,
      urgency: dto.urgency,
      source_channel: 'portal',
      form_data: dto.form_data,
    });

    return { ticket, portal_trace };
  }

  async resolvePortalSubmit(
    authUid: string,
    dto: PortalSubmitDto,
  ): Promise<{
    intake: IntakeContext;
    portal_trace: RequestTypeTrace;
    requested_for_person_id: string;
  }> {
    const tenant = TenantContext.current();

    if (!dto.request_type_id) {
      throw new BadRequestException({
        code: 'request_type_required',
        message: 'request_type_id is required',
      });
    }

    // 1. Auth-bind requester.
    const userLookup = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('tenant_id', tenant.id)
      .eq('auth_uid', authUid)
      .maybeSingle();
    const userRow = userLookup.data as { id: string; person_id: string | null } | null;
    if (!userRow || !userRow.person_id) {
      throw new UnauthorizedException('No linked person for authenticated user');
    }
    const requesterPersonId = userRow.person_id;

    // 2. Load request type for intake preflight (inactive → 404 before trace).
    const { data: rtRow } = await this.supabase.admin
      .from('request_types')
      .select('id, active')
      .eq('id', dto.request_type_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    const rt = rtRow as { id: string; active: boolean } | null;
    if (!rt || !rt.active) {
      throw new NotFoundException('Request type not found or inactive');
    }

    // 3. Early asset lookup (tenant-scoped) to derive the effective location
    //    and catch cross-tenant leakage before the trace RPC runs.
    let assetAssignedSpaceId: string | null = null;
    if (dto.asset_id) {
      const assetLookup = await this.supabase.admin
        .from('assets')
        .select('id, asset_type_id, assigned_space_id')
        .eq('id', dto.asset_id)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      const asset = assetLookup.data as
        | { id: string; asset_type_id: string | null; assigned_space_id: string | null }
        | null;
      if (!asset) {
        throw new BadRequestException({
          code: 'asset_not_found',
          message: 'Asset does not exist or is not accessible',
        });
      }
      assetAssignedSpaceId = asset.assigned_space_id;
    }

    // 4. Effective location: user-picked, else asset-resolved, else null.
    const effectiveLocationId: string | null = dto.location_id
      ? dto.location_id
      : assetAssignedSpaceId;

    // 5. requested_for defaults to requester (self-submit).
    const requestedForPersonId = dto.requested_for_person_id ?? requesterPersonId;

    // 6. Single source of truth: request_type_requestable_trace.
    const { data: traceData, error: traceError } = await this.supabase.admin.rpc(
      'request_type_requestable_trace',
      {
        p_actor_person_id: requesterPersonId,
        p_request_type_id: dto.request_type_id,
        p_requested_for_person_id: requestedForPersonId,
        p_effective_space_id: effectiveLocationId,
        p_asset_id: dto.asset_id ?? null,
        p_tenant_id: tenant.id,
      },
    );
    if (traceError) throw traceError;
    const portal_trace = traceData as unknown as RequestTypeTrace;

    if (!portal_trace.overall_valid) {
      throw new BadRequestException({
        code: 'portal_requestable_failed',
        message: portal_trace.failure_reason ?? 'Submission not allowed',
        trace: portal_trace,
      });
    }

    // 7. Build Contract-1-aligned IntakeContext.
    const intake: IntakeContext = {
      tenant_id: tenant.id,
      request_type_id: dto.request_type_id,
      requester_person_id: requesterPersonId,
      selected_location_id: dto.location_id ?? null,
      asset_id: dto.asset_id ?? null,
      priority: (dto.priority ?? 'normal') as IntakeContext['priority'],
      evaluated_at: new Date().toISOString(),
    };

    return {
      intake,
      portal_trace,
      requested_for_person_id: requestedForPersonId,
    };
  }
}
