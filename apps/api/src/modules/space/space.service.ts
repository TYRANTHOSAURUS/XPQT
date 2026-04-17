import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

export interface CreateSpaceDto {
  parent_id?: string;
  type: string;
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
  capacity?: number;
  amenities?: string[];
  attributes?: Record<string, unknown>;
  reservable?: boolean;
  active?: boolean;
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
  }) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('spaces')
      .select('*')
      .eq('tenant_id', tenant.id)
      .order('name');

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
    return this.buildTree(data ?? [], rootId ?? null);
  }

  async create(dto: CreateSpaceDto) {
    const tenant = TenantContext.current();
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

  private buildTree(spaces: Array<Record<string, unknown>>, parentId: string | null): unknown[] {
    return spaces
      .filter((s) => s.parent_id === parentId)
      .map((s) => ({
        ...s,
        children: this.buildTree(spaces, s.id as string),
      }));
  }
}
