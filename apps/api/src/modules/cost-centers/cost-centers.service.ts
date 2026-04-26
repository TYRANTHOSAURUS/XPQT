import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CostCenterUpsertDto {
  code: string;
  name: string;
  description?: string | null;
  default_approver_person_id?: string | null;
  active?: boolean;
}

export interface CostCenterRow {
  id: string;
  tenant_id: string;
  code: string;
  name: string;
  description: string | null;
  default_approver_person_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * Admin CRUD over `cost_centers`.
 *
 * Cost centers are a tenant-scoped lookup that bundles route GL chargeback +
 * derived approver resolution against. The dedup approval algorithm
 * (`ApprovalRoutingService.assemble`) hits this table when a service rule
 * uses `approver_target='cost_center.default_approver'`.
 *
 * Code uniqueness is per-tenant (the schema enforces `unique(tenant_id, code)`)
 * — surface 23505 as a 409 with a friendly message so admins know to pick a
 * different code rather than seeing a raw Postgres error.
 */
@Injectable()
export class CostCentersService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters?: { active?: boolean }): Promise<CostCenterRow[]> {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('cost_centers')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('code', { ascending: true });
    if (filters?.active != null) query = query.eq('active', filters.active);
    const { data, error } = await query;
    if (error) throw error;
    return (data ?? []) as CostCenterRow[];
  }

  async findOne(id: string): Promise<CostCenterRow> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('cost_centers')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw new NotFoundException({
        code: 'cost_center_not_found',
        message: `Cost center ${id} not found.`,
      });
    }
    return data as CostCenterRow;
  }

  async create(dto: CostCenterUpsertDto): Promise<CostCenterRow> {
    this.assertValid(dto);
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('cost_centers')
      .insert({
        tenant_id: tenant.id,
        code: dto.code.trim(),
        name: dto.name.trim(),
        description: dto.description ?? null,
        default_approver_person_id: dto.default_approver_person_id ?? null,
        active: dto.active ?? true,
      })
      .select('*')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'cost_center_code_taken',
          message: `Cost center with code "${dto.code}" already exists.`,
        });
      }
      throw error;
    }
    return data as CostCenterRow;
  }

  async update(id: string, dto: Partial<CostCenterUpsertDto>): Promise<CostCenterRow> {
    if (dto.code != null) this.assertValidCode(dto.code);
    if (dto.name != null && dto.name.trim().length === 0) {
      throw new BadRequestException({ code: 'name_required', message: 'name cannot be empty' });
    }
    const tenant = TenantContext.current();
    const patch: Record<string, unknown> = {};
    if (dto.code != null) patch.code = dto.code.trim();
    if (dto.name != null) patch.name = dto.name.trim();
    if ('description' in dto) patch.description = dto.description ?? null;
    if ('default_approver_person_id' in dto) {
      patch.default_approver_person_id = dto.default_approver_person_id ?? null;
    }
    if (dto.active != null) patch.active = dto.active;

    const { data, error } = await this.supabase.admin
      .from('cost_centers')
      .update(patch)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select('*')
      .single();
    if (error) {
      if ((error as { code?: string }).code === '23505') {
        throw new ConflictException({
          code: 'cost_center_code_taken',
          message: `Cost center with code "${dto.code}" already exists.`,
        });
      }
      throw error;
    }
    if (!data) {
      throw new NotFoundException({
        code: 'cost_center_not_found',
        message: `Cost center ${id} not found.`,
      });
    }
    return data as CostCenterRow;
  }

  async remove(id: string): Promise<{ id: string }> {
    const tenant = TenantContext.current();
    // FK on booking_bundles.cost_center_id is `ON DELETE SET NULL` — bundles
    // referencing this cost center stay alive but lose the reference. Reports
    // group such bundles as `cost_center_unknown` (per spec §5.5 risk).
    const { error } = await this.supabase.admin
      .from('cost_centers')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { id };
  }

  // ── Validation ─────────────────────────────────────────────────────────

  private assertValid(dto: CostCenterUpsertDto): void {
    this.assertValidCode(dto.code);
    if (!dto.name?.trim()) {
      throw new BadRequestException({ code: 'name_required', message: 'name is required' });
    }
  }

  private assertValidCode(code: string): void {
    if (!code?.trim()) {
      throw new BadRequestException({ code: 'code_required', message: 'code is required' });
    }
    if (code.trim().length > 32) {
      throw new BadRequestException({
        code: 'code_too_long',
        message: 'code must be 32 characters or fewer',
      });
    }
  }
}
