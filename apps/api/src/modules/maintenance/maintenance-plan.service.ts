import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors } from '../../common/errors';
import { throwZodError } from '../../common/errors/zod';
import {
  CreateMaintenancePlanSchema,
  ListMaintenancePlansQuerySchema,
  UpdateMaintenancePlanSchema,
  type ListMaintenancePlansQuery,
} from './dto/maintenance-plan.dto';
import {
  computeInitialNextRunAt,
  isRecurrenceUnit,
  type RecurrenceUnit,
} from './recurrence';

/**
 * Row shape returned by the admin surface. Mirrors public.maintenance_plans
 * (00386:62-115) — every column the controller renders + audit columns.
 */
export interface MaintenancePlanRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  active: boolean;
  asset_id: string | null;
  asset_type_id: string | null;
  request_type_id: string;
  location_id: string | null;
  title_template: string;
  description_template: string | null;
  priority: 'low' | 'medium' | 'high' | 'critical' | 'urgent';
  planned_duration_minutes: number | null;
  recurrence_interval: number;
  recurrence_unit: RecurrenceUnit;
  anchor_date: string;
  lead_days: number;
  next_run_at: string;
  last_completed_at: string | null;
  last_generated_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

const SELECT_COLUMNS =
  'id, tenant_id, name, description, active, asset_id, asset_type_id, request_type_id, location_id, title_template, description_template, priority, planned_duration_minutes, recurrence_interval, recurrence_unit, anchor_date, lead_days, next_run_at, last_completed_at, last_generated_at, created_at, updated_at, created_by, updated_by';

interface ResolveActorOptions {
  authUid: string | undefined;
}

/**
 * MaintenancePlanService — CRUD over public.maintenance_plans.
 *
 * Spec: ai/slice-c-plan.md §5. Tenant invariant #0 enforced on every
 * read/write via TenantContext.current() + explicit .eq('tenant_id', …)
 * (RLS bypass under supabase.admin makes the explicit filter mandatory).
 *
 * The composite FKs in 00386 enforce tenant ownership at the DB layer —
 * a cross-tenant asset_id / asset_type_id / request_type_id / location_id
 * fails the FK check and surfaces as a generic db.constraint. We surface
 * the high-frequency error (asset_id XOR asset_type_id) inline as
 * maintenance_plans.target_mutex_violation so the operator gets a
 * targeted message; the DB CHECK is the backstop.
 *
 * Soft-delete semantics: DELETE deactivates the plan when any work_order
 * references it (preserves audit chain); hard-deletes only when no WOs
 * are linked. The 409 maintenance_plans.in_use signal is reserved for
 * future "force-hard-delete" callers — v1 callers always degrade
 * gracefully to soft-delete.
 */
@Injectable()
export class MaintenancePlanService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(query: unknown): Promise<{ rows: MaintenancePlanRow[]; total: number }> {
    const parsed = ListMaintenancePlansQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throwZodError(parsed);
    const filters = parsed.data;
    const tenant = TenantContext.current();

    let request = this.supabase.admin
      .from('maintenance_plans')
      .select(SELECT_COLUMNS, { count: 'exact' })
      .eq('tenant_id', tenant.id);

    if (filters.asset_id) request = request.eq('asset_id', filters.asset_id);
    if (filters.asset_type_id)
      request = request.eq('asset_type_id', filters.asset_type_id);
    if (filters.request_type_id)
      request = request.eq('request_type_id', filters.request_type_id);
    if (filters.active !== undefined) request = request.eq('active', filters.active);

    const limit = (filters as ListMaintenancePlansQuery).limit ?? 50;
    const offset = (filters as ListMaintenancePlansQuery).offset ?? 0;

    const { data, error, count } = await request
      .order('next_run_at', { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return {
      rows: (data ?? []) as MaintenancePlanRow[],
      total: count ?? 0,
    };
  }

  async findById(id: string): Promise<MaintenancePlanRow> {
    const tenant = TenantContext.current();
    if (typeof id !== 'string' || id.length === 0) {
      throw AppErrors.notFoundWithCode('maintenance_plans.not_found');
    }
    const { data, error } = await this.supabase.admin
      .from('maintenance_plans')
      .select(SELECT_COLUMNS)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw AppErrors.notFoundWithCode('maintenance_plans.not_found');
    }
    return data as MaintenancePlanRow;
  }

  async create(
    body: unknown,
    options: ResolveActorOptions,
  ): Promise<MaintenancePlanRow> {
    const parsed = CreateMaintenancePlanSchema.safeParse(body);
    if (!parsed.success) throwZodError(parsed);
    const dto = parsed.data;
    this.assertTargetMutex(dto.asset_id ?? null, dto.asset_type_id ?? null);

    const tenant = TenantContext.current();
    const actorUserId = await this.resolveActorUserId(options.authUid, tenant.id);

    const nextRunAt = computeInitialNextRunAt(
      dto.anchor_date,
      dto.recurrence_interval,
      dto.recurrence_unit,
      new Date(),
    );

    const insertRow = {
      tenant_id: tenant.id,
      name: dto.name,
      description: dto.description ?? null,
      active: dto.active ?? true,
      asset_id: dto.asset_id ?? null,
      asset_type_id: dto.asset_type_id ?? null,
      request_type_id: dto.request_type_id,
      location_id: dto.location_id ?? null,
      title_template: dto.title_template,
      description_template: dto.description_template ?? null,
      priority: dto.priority ?? 'medium',
      planned_duration_minutes: dto.planned_duration_minutes ?? 60,
      recurrence_interval: dto.recurrence_interval,
      recurrence_unit: dto.recurrence_unit,
      anchor_date: dto.anchor_date,
      lead_days: dto.lead_days ?? 7,
      next_run_at: nextRunAt.toISOString(),
      created_by: actorUserId,
      updated_by: actorUserId,
    };

    const { data, error } = await this.supabase.admin
      .from('maintenance_plans')
      .insert(insertRow)
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw error;
    return data as MaintenancePlanRow;
  }

  async update(
    id: string,
    body: unknown,
    options: ResolveActorOptions,
  ): Promise<MaintenancePlanRow> {
    const parsed = UpdateMaintenancePlanSchema.safeParse(body);
    if (!parsed.success) throwZodError(parsed);
    const dto = parsed.data;

    const tenant = TenantContext.current();
    const existing = await this.findById(id);

    const nextAssetId = pickPatchValue(dto, 'asset_id', existing.asset_id);
    const nextAssetTypeId = pickPatchValue(
      dto,
      'asset_type_id',
      existing.asset_type_id,
    );
    this.assertTargetMutex(nextAssetId, nextAssetTypeId);

    const update: Record<string, unknown> = {};
    if ('name' in dto) update.name = dto.name;
    if ('description' in dto) update.description = dto.description ?? null;
    if ('active' in dto) update.active = dto.active;
    if ('asset_id' in dto) update.asset_id = dto.asset_id ?? null;
    if ('asset_type_id' in dto) update.asset_type_id = dto.asset_type_id ?? null;
    if ('request_type_id' in dto) update.request_type_id = dto.request_type_id;
    if ('location_id' in dto) update.location_id = dto.location_id ?? null;
    if ('title_template' in dto) update.title_template = dto.title_template;
    if ('description_template' in dto)
      update.description_template = dto.description_template ?? null;
    if ('priority' in dto) update.priority = dto.priority;
    if ('planned_duration_minutes' in dto)
      update.planned_duration_minutes = dto.planned_duration_minutes ?? null;
    if ('recurrence_interval' in dto)
      update.recurrence_interval = dto.recurrence_interval;
    if ('recurrence_unit' in dto) update.recurrence_unit = dto.recurrence_unit;
    if ('anchor_date' in dto) update.anchor_date = dto.anchor_date;
    if ('lead_days' in dto) update.lead_days = dto.lead_days;

    const recurrenceChanged =
      'recurrence_interval' in dto ||
      'recurrence_unit' in dto ||
      'anchor_date' in dto;
    if (recurrenceChanged) {
      const interval = dto.recurrence_interval ?? existing.recurrence_interval;
      const unitRaw = dto.recurrence_unit ?? existing.recurrence_unit;
      if (!isRecurrenceUnit(unitRaw)) {
        throw AppErrors.validationFailed('maintenance_plans.invalid_recurrence');
      }
      const anchor = dto.anchor_date ?? existing.anchor_date;
      const nextRunAt = computeInitialNextRunAt(
        anchor,
        interval,
        unitRaw,
        new Date(),
      );
      update.next_run_at = nextRunAt.toISOString();
    }

    const actorUserId = await this.resolveActorUserId(options.authUid, tenant.id);
    if (actorUserId) update.updated_by = actorUserId;

    const { data, error } = await this.supabase.admin
      .from('maintenance_plans')
      .update(update)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select(SELECT_COLUMNS)
      .single();
    if (error) throw error;
    return data as MaintenancePlanRow;
  }

  /**
   * Delete a plan.
   *
   * Soft-delete (active=false) when any work_order references it. Hard
   * delete only when no WOs are linked. Returns `{ mode: 'soft' | 'hard' }`
   * so the controller / FE can render the right toast verb.
   *
   * The plan-references query uses supabase.admin so RLS bypass is
   * accepted; the .eq('tenant_id', …) filter is mandatory to keep the
   * count tenant-scoped. The composite FK on work_orders
   * (tenant_id, maintenance_plan_id) means cross-tenant references are
   * impossible at the DB layer too — but defense-in-depth.
   */
  async delete(id: string): Promise<{ mode: 'soft' | 'hard' }> {
    const tenant = TenantContext.current();
    await this.findById(id);

    const { count, error: countErr } = await this.supabase.admin
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id)
      .eq('maintenance_plan_id', id);
    if (countErr) throw countErr;

    if ((count ?? 0) > 0) {
      const { error } = await this.supabase.admin
        .from('maintenance_plans')
        .update({ active: false })
        .eq('id', id)
        .eq('tenant_id', tenant.id);
      if (error) throw error;
      return { mode: 'soft' };
    }

    const { error } = await this.supabase.admin
      .from('maintenance_plans')
      .delete()
      .eq('id', id)
      .eq('tenant_id', tenant.id);
    if (error) throw error;
    return { mode: 'hard' };
  }

  private assertTargetMutex(
    assetId: string | null,
    assetTypeId: string | null,
  ): void {
    const hasAsset = assetId !== null && assetId !== undefined;
    const hasType = assetTypeId !== null && assetTypeId !== undefined;
    if (hasAsset === hasType) {
      throw AppErrors.validationFailed(
        'maintenance_plans.target_mutex_violation',
      );
    }
  }

  /**
   * Resolve the auth UID (request JWT sub) to the users.id PK in this
   * tenant. `created_by` / `updated_by` reference public.users, NOT
   * auth.users — passing the auth UID directly violates the FK and 500s.
   * Returns null when the caller has no linked users row (the columns
   * are nullable; callers that lack a linked user just leave them
   * unstamped — non-fatal).
   */
  private async resolveActorUserId(
    authUid: string | undefined,
    tenantId: string,
  ): Promise<string | null> {
    if (!authUid) return null;
    const { data, error } = await this.supabase.admin
      .from('users')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('auth_uid', authUid)
      .maybeSingle();
    if (error) throw error;
    return (data as { id: string } | null)?.id ?? null;
  }
}

function pickPatchValue<K extends string>(
  patch: Record<string, unknown>,
  key: K,
  fallback: string | null,
): string | null {
  if (key in patch) {
    const v = patch[key];
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return v;
  }
  return fallback;
}
