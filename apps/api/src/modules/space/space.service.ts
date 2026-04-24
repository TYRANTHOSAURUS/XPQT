import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { isValidSpaceParent, SpaceType } from '@prequest/shared';

export interface CreateSpaceDto {
  parent_id?: string | null;
  type: SpaceType;
  code?: string;
  name: string;
  capacity?: number;
  amenities?: string[];
  attributes?: Record<string, unknown>;
  reservable?: boolean;
}

export interface UpdateSpaceDto {
  name?: string;
  code?: string;
  capacity?: number | null;
  amenities?: string[];
  attributes?: Record<string, unknown>;
  reservable?: boolean;
  active?: boolean;
}

export interface MoveSpaceDto {
  parent_id: string | null;
}

export interface BulkUpdateDto {
  ids: string[];
  patch: UpdateSpaceDto;
}

@Injectable()
export class SpaceService {
  constructor(private readonly supabase: SupabaseService) {}

  async list(filters?: {
    type?: string;
    types?: string[];
    parent_id?: string;
    reservable?: boolean;
    search?: string;
    active_only?: boolean;
  }) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');

    if (filters?.active_only) query = query.eq('active', true);
    if (filters?.type) query = query.eq('type', filters.type);
    if (filters?.types?.length) query = query.in('type', filters.types);
    if (filters?.parent_id) query = query.eq('parent_id', filters.parent_id);
    if (filters?.reservable !== undefined) query = query.eq('reservable', filters.reservable);
    if (filters?.search) query = query.ilike('name', `%${filters.search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) throw new NotFoundException('Space not found');
    return data;
  }

  /**
   * Returns the full active tree for this tenant, each node enriched with
   * `child_count` (direct children only). Used by the admin explorer.
   */
  async getHierarchy(rootId?: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('type')
      .order('name');

    if (error) throw error;

    const childCounts = new Map<string | null, number>();
    for (const s of data ?? []) {
      const key = (s.parent_id as string | null) ?? null;
      childCounts.set(key, (childCounts.get(key) ?? 0) + 1);
    }

    return this.buildTree(data ?? [], childCounts, rootId ?? null);
  }

  async create(dto: CreateSpaceDto) {
    const tenant = TenantContext.current();
    await this.assertValidParent(dto.parent_id ?? null, dto.type);

    const { data, error } = await this.supabase.admin
      .from('spaces')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async update(id: string, dto: UpdateSpaceDto) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async move(id: string, dto: MoveSpaceDto) {
    const tenant = TenantContext.current();
    const current = await this.getById(id);
    await this.assertValidParent(dto.parent_id, current.type as SpaceType);

    const { data, error } = await this.supabase.admin
      .from('spaces')
      .update({ parent_id: dto.parent_id })
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Applies the same patch to every id. Returns per-id results. Tenant
   * isolation is enforced per-row (the eq('tenant_id', …) filter in update()).
   */
  async bulkUpdate(dto: BulkUpdateDto) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of dto.ids) {
      try {
        await this.update(id, dto.patch);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }
    return { results };
  }

  private async assertValidParent(parentId: string | null, childType: SpaceType) {
    if (parentId === null) {
      if (!isValidSpaceParent(null, childType)) {
        throw new BadRequestException(`${childType} cannot be created at root`);
      }
      return;
    }

    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('spaces')
      .select('type')
      .eq('id', parentId)
      .eq('tenant_id', tenant.id)
      .single();

    if (error || !data) {
      throw new BadRequestException('Parent space not found');
    }

    if (!isValidSpaceParent(data.type as SpaceType, childType)) {
      throw new BadRequestException(
        `${childType} cannot be a child of ${data.type}`,
      );
    }
  }

  private buildTree(
    spaces: Array<Record<string, unknown>>,
    childCounts: Map<string | null, number>,
    parentId: string | null,
  ): unknown[] {
    return spaces
      .filter((s) => (s.parent_id as string | null) === parentId)
      .map((s) => ({
        ...s,
        child_count: childCounts.get(s.id as string) ?? 0,
        children: this.buildTree(spaces, childCounts, s.id as string),
      }));
  }
}
