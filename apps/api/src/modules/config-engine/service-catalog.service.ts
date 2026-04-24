import { Injectable, BadRequestException, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

const BUCKET = 'portal-assets';
const COVER_MAX_BYTES = 2 * 1024 * 1024;
const COVER_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon' | null;
  display_order: number;
  parent_category_id: string | null;
  active: boolean;
}

interface RequestTypeRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  display_order: number;
  domain: string | null;
  keywords: string[];
  active: boolean;
}

export interface CatalogTreeNode extends CategoryRow {
  children: CatalogTreeNode[];
  request_types: RequestTypeRow[];
}

@Injectable()
export class ServiceCatalogService {
  constructor(private readonly supabase: SupabaseService) {}

  async listCategories() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .select('*')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('display_order');

    if (error) throw error;
    return data;
  }

  // Full hierarchy with request types attached at each level. Single round-trip worth of queries,
  // assembled in memory — fine at expected scale (tenant has O(10) categories, O(100) request types).
  async getTree(): Promise<CatalogTreeNode[]> {
    const tenant = TenantContext.current();

    const [categoriesRes, requestTypesRes, linksRes] = await Promise.all([
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, description, icon, display_order, parent_category_id, active, cover_image_url, cover_source')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('display_order'),
      this.supabase.admin
        .from('request_types')
        .select('id, name, description, icon, display_order, domain, keywords, active')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .order('display_order'),
      this.supabase.admin
        .from('request_type_categories')
        .select('request_type_id, category_id')
        .eq('tenant_id', tenant.id),
    ]);

    if (categoriesRes.error) throw categoriesRes.error;
    if (requestTypesRes.error) throw requestTypesRes.error;
    if (linksRes.error) throw linksRes.error;

    const categories = (categoriesRes.data ?? []) as CategoryRow[];
    const requestTypes = (requestTypesRes.data ?? []) as RequestTypeRow[];
    const links = linksRes.data ?? [];

    const requestTypeById = new Map(requestTypes.map((rt) => [rt.id, rt]));
    const requestTypesByCategory = new Map<string, RequestTypeRow[]>();
    for (const link of links) {
      const rt = requestTypeById.get(link.request_type_id);
      if (!rt) continue;
      const bucket = requestTypesByCategory.get(link.category_id) ?? [];
      bucket.push(rt);
      requestTypesByCategory.set(link.category_id, bucket);
    }

    const nodeById = new Map<string, CatalogTreeNode>();
    for (const cat of categories) {
      nodeById.set(cat.id, {
        ...cat,
        children: [],
        request_types: requestTypesByCategory.get(cat.id) ?? [],
      });
    }

    const roots: CatalogTreeNode[] = [];
    for (const node of nodeById.values()) {
      if (node.parent_category_id && nodeById.has(node.parent_category_id)) {
        nodeById.get(node.parent_category_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  // Translate the category hierarchy trigger errors into actionable validation messages.
  private rethrowCategoryError(error: { message: string; code?: string }): never {
    const msg = error.message ?? '';
    if (msg.includes('category_depth_exceeded')) {
      throw new BadRequestException('Catalog hierarchy is capped at 3 levels.');
    }
    if (msg.includes('category_cycle') || msg.includes('category_self_parent')) {
      throw new BadRequestException('This parent assignment would create a cycle.');
    }
    throw error;
  }

  async createCategory(dto: { name: string; description?: string; icon?: string; parent_category_id?: string; display_order?: number }) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .insert({ ...dto, tenant_id: tenant.id })
      .select()
      .single();

    if (error) this.rethrowCategoryError(error);
    return data;
  }

  async updateCategory(
    id: string,
    dto: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      cover_image_url?: string | null;
      cover_source?: 'image' | 'icon' | null;
      parent_category_id?: string | null;
      display_order?: number;
      active?: boolean;
    },
  ) {
    if (dto.cover_source !== undefined && dto.cover_source !== null && dto.cover_source !== 'image' && dto.cover_source !== 'icon') {
      throw new BadRequestException(`cover_source must be 'image', 'icon', or null`);
    }
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update(dto)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();

    if (error) this.rethrowCategoryError(error);
    return data;
  }

  async uploadCategoryCover(
    categoryId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ) {
    if (!file) throw new BadRequestException('Missing file');
    if (!COVER_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported mime: ${file.mimetype}. Allowed: jpeg, png, webp`);
    }
    if (file.buffer.byteLength > COVER_MAX_BYTES) {
      throw new BadRequestException(`File too large: ${file.buffer.byteLength} bytes (max ${COVER_MAX_BYTES})`);
    }

    const tenant = TenantContext.current();
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)[
      file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'
    ];
    const path = `${tenant.id}/category-cover/${categoryId}.${ext}`;

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
    if (uploadErr) throw new InternalServerErrorException(uploadErr.message);

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update({ cover_image_url: bustedUrl, cover_source: 'image' })
      .eq('id', categoryId)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Category not found');
    return data;
  }

  // Batch reorder/reparent — drives the drag-n-drop admin UI. Each item gets a new parent and
  // display_order in one transaction; trigger re-validates depth per row.
  async reorderCategories(updates: Array<{ id: string; parent_category_id: string | null; display_order: number }>) {
    const tenant = TenantContext.current();
    for (const u of updates) {
      const { error } = await this.supabase.admin
        .from('service_catalog_categories')
        .update({ parent_category_id: u.parent_category_id, display_order: u.display_order })
        .eq('id', u.id)
        .eq('tenant_id', tenant.id);
      if (error) this.rethrowCategoryError(error);
    }
    return { updated: updates.length };
  }

  // Drag-n-drop move of a request type: updates display_order and replaces category membership
  // with a single category. Multi-category assignment stays managed through the dedicated form.
  async moveRequestTypes(updates: Array<{ id: string; category_id: string; display_order: number }>) {
    const tenant = TenantContext.current();
    for (const u of updates) {
      const { error: orderErr } = await this.supabase.admin
        .from('request_types')
        .update({ display_order: u.display_order })
        .eq('id', u.id)
        .eq('tenant_id', tenant.id);
      if (orderErr) throw orderErr;

      const { error: unlinkErr } = await this.supabase.admin
        .from('request_type_categories')
        .delete()
        .eq('request_type_id', u.id)
        .eq('tenant_id', tenant.id);
      if (unlinkErr) throw unlinkErr;

      const { error: linkErr } = await this.supabase.admin
        .from('request_type_categories')
        .insert({ tenant_id: tenant.id, request_type_id: u.id, category_id: u.category_id });
      if (linkErr) throw linkErr;
    }
    return { updated: updates.length };
  }

  async deleteCategory(id: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update({ active: false })
      .eq('id', id)
      .eq('tenant_id', tenant.id);

    if (error) throw error;
    return { deleted: true };
  }

}
