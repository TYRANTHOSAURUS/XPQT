import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export const SERVICE_CATEGORIES = [
  'catering',
  'av_equipment',
  'supplies',
  'facilities_services',
  'cleaning',
  'maintenance',
  'transport',
  'other',
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export interface ServiceRoutingUpsertDto {
  /** NULL = tenant default (applies wherever no per-location row matches). */
  location_id?: string | null;
  service_category: ServiceCategory;
  internal_team_id?: string | null;
  default_lead_time_minutes?: number;
  sla_policy_id?: string | null;
  active?: boolean;
}

export interface ServiceRoutingRow {
  id: string;
  tenant_id: string;
  location_id: string | null;
  service_category: ServiceCategory;
  internal_team_id: string | null;
  default_lead_time_minutes: number;
  sla_policy_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Admin CRUD over `location_service_routing` (00194). The matrix that
 * tells the booking-origin work-order auto-creation flow:
 *
 *   "for THIS service category at THIS location (or tenant-wide),
 *    route the internal setup task to THIS team with THIS lead time
 *    and THIS SLA policy."
 *
 * The flat-config sibling to the routing-rules engine (which is for
 * conditional logic). See docs/assignments-routing-fulfillment.md §25.
 *
 * Uniqueness:
 *   - per-location row: unique on (tenant, location_id, service_category)
 *   - tenant-default row: unique on (tenant, service_category) where
 *     location_id IS NULL
 *   Both enforced by partial unique indexes (00194). 23505 → 409 with
 *   a friendly code so admins know they're trying to duplicate a row.
 */
@Injectable()
export class ServiceRoutingService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(): Promise<ServiceRoutingRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('location_service_routing')
      .select('*')
      .eq('tenant_id', tenant.id)
      // Tenant-default rows (location_id NULL) sort first, then per-location rows.
      .order('location_id', { ascending: true, nullsFirst: true })
      .order('service_category', { ascending: true });
    if (error) throw error;
    return (data ?? []) as ServiceRoutingRow[];
  }

  async findOne(id: string): Promise<ServiceRoutingRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('location_service_routing')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'service_routing_not_found',
        message: `Service routing ${id} not found.`,
      });
    }
    return data as ServiceRoutingRow;
  }

  async create(dto: ServiceRoutingUpsertDto): Promise<ServiceRoutingRow> {
    this.assertValid(dto);
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('location_service_routing')
      .insert({
        tenant_id: tenant.id,
        location_id: dto.location_id ?? null,
        service_category: dto.service_category,
        internal_team_id: dto.internal_team_id ?? null,
        default_lead_time_minutes: dto.default_lead_time_minutes ?? 30,
        sla_policy_id: dto.sla_policy_id ?? null,
        active: dto.active ?? true,
      })
      .select('*')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'service_routing_duplicate',
          message: dto.location_id
            ? `A routing rule already exists for this location and "${dto.service_category}". Edit it instead.`
            : `A tenant-default rule already exists for "${dto.service_category}". Edit it instead.`,
        });
      }
      throw error;
    }
    return data as ServiceRoutingRow;
  }

  async update(id: string, dto: Partial<ServiceRoutingUpsertDto>): Promise<ServiceRoutingRow> {
    if (dto.service_category !== undefined || dto.location_id !== undefined) {
      // service_category and location_id form the uniqueness key. Editing
      // them is conceptually "delete + create" — refuse here so admins
      // don't accidentally collide with another row.
      throw new BadRequestException({
        code: 'service_routing_immutable_key',
        message:
          'Service category and location are part of the routing key. To change them, delete this row and add a new one.',
      });
    }
    this.assertValidPartial(dto);
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.internal_team_id !== undefined) patch.internal_team_id = dto.internal_team_id;
    if (dto.default_lead_time_minutes !== undefined)
      patch.default_lead_time_minutes = dto.default_lead_time_minutes;
    if (dto.sla_policy_id !== undefined) patch.sla_policy_id = dto.sla_policy_id;
    if (dto.active !== undefined) patch.active = dto.active;
    if (Object.keys(patch).length === 0) {
      // No-op patch — just return the existing row.
      return this.findOne(id);
    }
    const { data, error } = await this.supabase.admin
      .from('location_service_routing')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'service_routing_not_found',
        message: `Service routing ${id} not found.`,
      });
    }
    return data as ServiceRoutingRow;
  }

  async remove(id: string): Promise<{ id: string }> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('location_service_routing')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { id };
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private assertValid(dto: ServiceRoutingUpsertDto): void {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    if (!SERVICE_CATEGORIES.includes(dto.service_category)) {
      throw new BadRequestException({
        code: 'invalid_service_category',
        message: `service_category must be one of: ${SERVICE_CATEGORIES.join(', ')}`,
      });
    }
    this.assertValidPartial(dto);
  }

  private assertValidPartial(dto: Partial<ServiceRoutingUpsertDto>): void {
    if (
      dto.default_lead_time_minutes !== undefined &&
      (!Number.isInteger(dto.default_lead_time_minutes) ||
        dto.default_lead_time_minutes < 0 ||
        dto.default_lead_time_minutes > 24 * 60)
    ) {
      throw new BadRequestException({
        code: 'invalid_lead_time',
        message: 'default_lead_time_minutes must be a non-negative integer up to 1440 (24h).',
      });
    }
  }
}
