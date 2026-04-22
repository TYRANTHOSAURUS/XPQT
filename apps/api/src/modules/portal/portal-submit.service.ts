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
  PortalAvailabilityTrace,
  PortalSubmitDto,
} from './portal-submit.types';

/**
 * Contract 0 implementation: resolves an authenticated portal submission into a
 * correctly-populated IntakeContext and creates the ticket.
 *
 * See docs/portal-scope-slice.md §2 and §5.5.
 */
@Injectable()
export class PortalSubmitService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly ticketService: TicketService,
  ) {}

  async submit(authUid: string, dto: PortalSubmitDto) {
    const { intake, portal_trace } = await this.resolvePortalSubmit(authUid, dto);

    // tickets.location_id MUST be the effective location (user-picked or asset-resolved)
    // so approval/visibility/list queries don't see a null-location ticket while the
    // request pauses pre-routing. scope_source preservation is a separate slice — see
    // docs/portal-scope-slice.md §2 caveat.
    const ticket = await this.ticketService.create({
      ticket_type_id: intake.request_type_id,
      title: dto.title,
      description: dto.description,
      priority: intake.priority,
      requester_person_id: intake.requester_person_id!,
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
  ): Promise<{ intake: IntakeContext; portal_trace: PortalAvailabilityTrace }> {
    const tenant = TenantContext.current();

    // 1. Auth-bind: resolve person_id from users.auth_uid.
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
    const personId = userRow.person_id;

    // 2. Server-side request-type intake enforcement (today enforced only client-side).
    const rtLookup = await this.supabase.admin
      .from('request_types')
      .select(
        'id, active, requires_asset, asset_required, asset_type_filter, requires_location, location_required, location_granularity',
      )
      .eq('id', dto.request_type_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();

    const rt = rtLookup.data as
      | {
          id: string;
          active: boolean;
          requires_asset: boolean | null;
          asset_required: boolean | null;
          asset_type_filter: string[] | null;
          requires_location: boolean | null;
          location_required: boolean | null;
          location_granularity: string | null;
        }
      | null;

    if (!rt || !rt.active) {
      throw new NotFoundException('Request type not found or inactive');
    }

    if (rt.asset_required && !dto.asset_id) {
      throw new BadRequestException({
        code: 'asset_required',
        message: 'This request type requires an asset',
      });
    }

    let assetAssignedSpaceId: string | null = null;
    if (dto.asset_id) {
      // Tenant-scoped asset lookup.
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

      if (
        rt.asset_type_filter &&
        rt.asset_type_filter.length > 0 &&
        !rt.asset_type_filter.includes(asset.asset_type_id ?? '')
      ) {
        throw new BadRequestException({
          code: 'asset_type_mismatch',
          message: `Asset type is not allowed for this request type`,
        });
      }

      assetAssignedSpaceId = asset.assigned_space_id;
    }

    // 3. Determine effective location for validation.
    let effectiveLocationId: string | null = null;
    if (dto.location_id) {
      effectiveLocationId = dto.location_id;
    } else if (assetAssignedSpaceId) {
      effectiveLocationId = assetAssignedSpaceId;
    }

    // 4. Run the single-source-of-truth trace.
    const { data: traceData, error: traceError } = await this.supabase.admin.rpc(
      'portal_availability_trace',
      {
        p_person_id: personId,
        p_effective_space_id: effectiveLocationId,
        p_request_type_id: dto.request_type_id,
        p_tenant_id: tenant.id,
      },
    );
    if (traceError) throw traceError;

    const portal_trace = traceData as unknown as PortalAvailabilityTrace;

    if (!portal_trace.overall_valid) {
      throw new BadRequestException({
        code: 'portal_availability_failed',
        message: portal_trace.failure_reason ?? 'Submission not allowed',
        trace: portal_trace,
      });
    }

    // 5. Build the Contract-1-aligned IntakeContext.
    const intake: IntakeContext = {
      tenant_id: tenant.id,
      request_type_id: dto.request_type_id,
      requester_person_id: personId,
      selected_location_id: dto.location_id ?? null, // user-picked only; never asset-resolved
      asset_id: dto.asset_id ?? null,
      priority: (dto.priority ?? 'normal') as IntakeContext['priority'],
      evaluated_at: new Date().toISOString(),
    };

    return { intake, portal_trace };
  }
}
