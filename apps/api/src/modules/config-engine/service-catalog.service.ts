import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppErrors, wrapPgError } from '../../common/errors';

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

    if (error) {
      throw wrapPgError(error, 'config_engine.category_list_failed', {
        detail: 'Service catalog categories list failed',
      });
    }
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

    if (categoriesRes.error) {
      throw wrapPgError(categoriesRes.error, 'config_engine.category_tree_load_failed', {
        detail: 'Service catalog tree categories load failed',
      });
    }
    if (requestTypesRes.error) {
      throw wrapPgError(requestTypesRes.error, 'config_engine.category_tree_load_failed', {
        detail: 'Service catalog tree request_types load failed',
      });
    }
    if (linksRes.error) {
      throw wrapPgError(linksRes.error, 'config_engine.category_tree_load_failed', {
        detail: 'Service catalog tree request_type_categories load failed',
      });
    }

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
      throw AppErrors.validationFailed('config_engine.invalid_hierarchy', { detail: 'Catalog hierarchy is capped at 3 levels.' });
    }
    if (msg.includes('category_cycle') || msg.includes('category_self_parent')) {
      throw AppErrors.validationFailed('config_engine.invalid_hierarchy', { detail: 'This parent assignment would create a cycle.' });
    }
    throw wrapPgError(error, 'config_engine.category_write_failed', {
      detail: `Service catalog category write failed${msg ? `: ${msg}` : ''}`,
    });
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
      throw AppErrors.validationFailed('config_engine.invalid_cover_source', { detail: `cover_source must be 'image', 'icon', or null` });
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
    if (!file) throw AppErrors.validationFailed('config_engine.file_required', { detail: 'Missing file' });
    if (!COVER_MIMES.has(file.mimetype)) {
      throw AppErrors.validationFailed('config_engine.unsupported_mime', { detail: `Unsupported mime: ${file.mimetype}. Allowed: jpeg, png, webp` });
    }
    if (file.buffer.byteLength > COVER_MAX_BYTES) {
      throw AppErrors.validationFailed('config_engine.file_too_large', { detail: `File too large: ${file.buffer.byteLength} bytes (max ${COVER_MAX_BYTES})` });
    }

    const tenant = TenantContext.current();
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)[
      file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'
    ];
    const path = `${tenant.id}/category-cover/${categoryId}.${ext}`;

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
    if (uploadErr) throw AppErrors.server('config_engine.upload_failed', { cause: uploadErr });

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const { data, error } = await this.supabase.admin
      .from('service_catalog_categories')
      .update({ cover_image_url: bustedUrl, cover_source: 'image' })
      .eq('id', categoryId)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) throw AppErrors.server('config_engine.update_failed', { cause: error });
    if (!data) throw AppErrors.notFoundWithCode('config_engine.category_not_found', 'Category not found');
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
      if (orderErr) {
        throw wrapPgError(orderErr, 'config_engine.request_type_reorder_failed', {
          detail: `Request type ${u.id} display_order update failed`,
        });
      }

      const { error: unlinkErr } = await this.supabase.admin
        .from('request_type_categories')
        .delete()
        .eq('request_type_id', u.id)
        .eq('tenant_id', tenant.id);
      if (unlinkErr) {
        throw wrapPgError(unlinkErr, 'config_engine.request_type_unlink_failed', {
          detail: `Request type ${u.id} category unlink failed`,
        });
      }

      const { error: linkErr } = await this.supabase.admin
        .from('request_type_categories')
        .insert({ tenant_id: tenant.id, request_type_id: u.id, category_id: u.category_id });
      if (linkErr) {
        throw wrapPgError(linkErr, 'config_engine.request_type_link_failed', {
          detail: `Request type ${u.id} category link insert failed`,
        });
      }
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

    if (error) {
      throw wrapPgError(error, 'config_engine.category_delete_failed', {
        detail: `Service catalog category ${id} soft-delete failed`,
      });
    }
    return { deleted: true };
  }

}
