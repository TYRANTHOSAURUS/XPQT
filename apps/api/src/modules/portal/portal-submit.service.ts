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
  PortalRequestableTrace,
  PortalSubmitDto,
} from './portal-submit.types';

/**
 * Portal submission resolver.
 *
 * Service-catalog redesign phase 2: the DTO accepts EITHER service_item_id
 * (preferred in v2) OR request_type_id (legacy, resolved via the
 * request_type_service_item_bridge). The single-source-of-truth predicate is
 * portal_requestable_trace(), which returns a strict superset of the shipped
 * portal_availability_trace shape. See docs/service-catalog-redesign.md §4.2.
 *
 * Tickets are still inserted with ticket_type_id pointing at the fulfillment
 * type (= the legacy request_type id), keeping downstream routing/SLA/
 * workflow paths unchanged. tickets.requested_for_person_id is populated from
 * the DTO when provided (defaults to the auth-bound requester).
 */
@Injectable()
export class PortalSubmitService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ticketService: TicketService,
  ) {}

  async submit(authUid: string, dto: PortalSubmitDto) {
    const { intake, portal_trace, requested_for_person_id, fulfillment_type_id } =
      await this.resolvePortalSubmit(authUid, dto);

    const ticket = await this.ticketService.create({
      ticket_type_id: fulfillment_type_id,
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
    portal_trace: PortalRequestableTrace;
    requested_for_person_id: string;
    fulfillment_type_id: string;
  }> {
    const tenant = TenantContext.current();

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

    // 2. Resolve service_item_id + fulfillment_type_id.
    //    Preferred: DTO passes service_item_id directly.
    //    Legacy: DTO passes request_type_id; we bridge to the paired service_item.
    let serviceItemId = dto.service_item_id ?? null;
    if (!serviceItemId && dto.request_type_id) {
      const { data: bridgeRow } = await this.supabase.admin
        .from('request_type_service_item_bridge')
        .select('service_item_id')
        .eq('request_type_id', dto.request_type_id)
        .eq('tenant_id', tenant.id)
        .maybeSingle();
      serviceItemId = (bridgeRow as { service_item_id: string } | null)?.service_item_id ?? null;
    }
    if (!serviceItemId) {
      throw new BadRequestException({
        code: 'service_item_required',
        message: 'service_item_id or request_type_id must be provided',
      });
    }

    const { data: siRow } = await this.supabase.admin
      .from('service_items')
      .select('id, active, fulfillment_type_id, on_behalf_policy')
      .eq('id', serviceItemId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    const si = siRow as
      | { id: string; active: boolean; fulfillment_type_id: string; on_behalf_policy: string }
      | null;
    if (!si || !si.active) {
      throw new NotFoundException('Service item not found or inactive');
    }
    const fulfillmentTypeId = si.fulfillment_type_id;

    // 3. Load fulfillment intake (for asset-resolve preflight).
    const { data: ftRow } = await this.supabase.admin
      .from('fulfillment_types')
      .select('id, active, requires_asset, asset_required, asset_type_filter')
      .eq('id', fulfillmentTypeId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    const ft = ftRow as
      | {
          id: string;
          active: boolean;
          requires_asset: boolean | null;
          asset_required: boolean | null;
          asset_type_filter: string[] | null;
        }
      | null;
    if (!ft || !ft.active) {
      throw new NotFoundException('Fulfillment type inactive');
    }

    // 4. Early asset lookup (tenant-scoped) to derive the effective location
    //    and catch cross-tenant leakage before portal_requestable_trace runs.
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

    // 5. Effective location: user-picked, else asset-resolved, else null.
    const effectiveLocationId: string | null = dto.location_id
      ? dto.location_id
      : assetAssignedSpaceId;

    // 6. requested_for defaults to requester (self-submit).
    const requestedForPersonId = dto.requested_for_person_id ?? requesterPersonId;

    // 7. Single source of truth: portal_requestable_trace.
    const { data: traceData, error: traceError } = await this.supabase.admin.rpc(
      'portal_requestable_trace',
      {
        p_actor_person_id: requesterPersonId,
        p_service_item_id: serviceItemId,
        p_requested_for_person_id: requestedForPersonId,
        p_effective_space_id: effectiveLocationId,
        p_asset_id: dto.asset_id ?? null,
        p_tenant_id: tenant.id,
      },
    );
    if (traceError) throw traceError;
    const portal_trace = traceData as unknown as PortalRequestableTrace;

    if (!portal_trace.overall_valid) {
      throw new BadRequestException({
        code: 'portal_requestable_failed',
        message: portal_trace.failure_reason ?? 'Submission not allowed',
        trace: portal_trace,
      });
    }

    // 8. Build Contract-1-aligned IntakeContext. request_type_id on the
    //    intake points at the fulfillment_type_id (same UUID in phase-1/2).
    const intake: IntakeContext = {
      tenant_id: tenant.id,
      request_type_id: fulfillmentTypeId,
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
      fulfillment_type_id: fulfillmentTypeId,
    };
  }
}
