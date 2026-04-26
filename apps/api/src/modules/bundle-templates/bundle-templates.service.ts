import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface BundleTemplatePayload {
  /** Display name shown to admins. Distinct from BundleTemplateRow.name. */
  name?: string;
  room_criteria?: {
    min_attendees?: number;
    must_have_amenities?: string[];
    preferred_floor_id?: string | null;
  };
  default_duration_minutes?: number;
  services?: Array<{
    catalog_item_id: string;
    menu_id?: string | null;
    quantity?: number;
    quantity_per_attendee?: number;
    /** Signed minutes from start_at; e.g. -30 = 30min before. */
    service_window_offset_minutes?: number;
  }>;
  default_cost_center_id?: string | null;
}

export interface BundleTemplateUpsertDto {
  name: string;
  description?: string | null;
  icon?: string | null;
  active?: boolean;
  payload: BundleTemplatePayload;
}

export interface BundleTemplateRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  active: boolean;
  payload: BundleTemplatePayload;
  created_at: string;
  updated_at: string;
}

/**
 * Admin CRUD over `bundle_templates`.
 *
 * A bundle template is a pre-filled composite booking shape — the user
 * picks one from the chip row above the time picker on /portal/rooms and
 * the form hydrates with editable defaults. The portal then runs the
 * normal booking-confirm flow, so templates don't need their own
 * lifecycle.
 *
 * Active flag drives the chip row visibility. Deletes are hard-deletes
 * (FK ON DELETE SET NULL on booking_bundles.template_id keeps existing
 * bundles alive but loses the back-reference).
 */
@Injectable()
export class BundleTemplatesService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters?: { active?: boolean }): Promise<BundleTemplateRow[]> {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('bundle_templates')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name', { ascending: true });
    if (filters?.active != null) query = query.eq('active', filters.active);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as BundleTemplateRow[];
  }

  async findOne(id: string): Promise<BundleTemplateRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('bundle_templates')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'bundle_template_not_found',
        message: `Bundle template ${id} not found.`,
      });
    }
    return data as BundleTemplateRow;
  }

  async create(dto: BundleTemplateUpsertDto): Promise<BundleTemplateRow> {
    this.assertValid(dto);
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('bundle_templates')
      .insert({
        tenant_id: tenant.id,
        name: dto.name.trim(),
        description: dto.description ?? null,
        icon: dto.icon ?? null,
        active: dto.active ?? true,
        payload: this.normalisePayload(dto.payload),
      })
      .select('*')
      .single();
    if (error) throw error;
    return data as BundleTemplateRow;
  }

  async update(
    id: string,
    dto: Partial<BundleTemplateUpsertDto>,
  ): Promise<BundleTemplateRow> {
    if (dto.name != null && !dto.name.trim()) {
      throw new BadRequestException({
        code: 'name_required',
        message: 'name cannot be empty',
      });
    }
    if (dto.payload != null) this.assertPayload(dto.payload);
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.name != null) patch.name = dto.name.trim();
    if ('description' in dto) patch.description = dto.description ?? null;
    if ('icon' in dto) patch.icon = dto.icon ?? null;
    if (dto.active != null) patch.active = dto.active;
    if (dto.payload != null) patch.payload = this.normalisePayload(dto.payload);

    const { data, error } = await this.supabase.admin
      .from('bundle_templates')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'bundle_template_not_found',
        message: `Bundle template ${id} not found.`,
      });
    }
    return data as BundleTemplateRow;
  }

  async remove(id: string): Promise<{ id: string }> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('bundle_templates')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { id };
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private assertValid(dto: BundleTemplateUpsertDto): void {
    if (!dto.name?.trim()) {
      throw new BadRequestException({ code: 'name_required', message: 'name is required' });
    }
    this.assertPayload(dto.payload);
  }

  private assertPayload(payload: BundleTemplatePayload): void {
    if (!payload || typeof payload !== 'object') {
      throw new BadRequestException({
        code: 'invalid_payload',
        message: 'payload must be an object',
      });
    }
    if (payload.services != null && !Array.isArray(payload.services)) {
      throw new BadRequestException({
        code: 'invalid_services',
        message: 'payload.services must be an array',
      });
    }
    for (const s of payload.services ?? []) {
      if (!s.catalog_item_id) {
        throw new BadRequestException({
          code: 'invalid_service_line',
          message: 'each service line requires a catalog_item_id',
        });
      }
    }
  }

  /**
   * Normalise the payload before persistence — empty arrays/objects collapse
   * to undefined so the JSONB stays compact, and known defaults stay sticky.
   */
  private normalisePayload(payload: BundleTemplatePayload): BundleTemplatePayload {
    const services = (payload.services ?? []).map((s) => ({
      catalog_item_id: s.catalog_item_id,
      ...(s.menu_id ? { menu_id: s.menu_id } : {}),
      ...(s.quantity != null ? { quantity: s.quantity } : {}),
      ...(s.quantity_per_attendee != null
        ? { quantity_per_attendee: s.quantity_per_attendee }
        : {}),
      ...(s.service_window_offset_minutes != null
        ? { service_window_offset_minutes: s.service_window_offset_minutes }
        : {}),
    }));
    return {
      ...(payload.name ? { name: payload.name } : {}),
      ...(payload.room_criteria ? { room_criteria: payload.room_criteria } : {}),
      ...(payload.default_duration_minutes != null
        ? { default_duration_minutes: payload.default_duration_minutes }
        : {}),
      ...(services.length > 0 ? { services } : {}),
      ...(payload.default_cost_center_id
        ? { default_cost_center_id: payload.default_cost_center_id }
        : {}),
    };
  }
}
