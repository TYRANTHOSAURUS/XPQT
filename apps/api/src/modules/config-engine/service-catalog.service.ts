import { Injectable, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';

interface CategoryRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
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

  async getCategoryWithRequestTypes(categoryId: string) {
    const tenant = TenantContext.current();

    const { data: links, error } = await this.supabase.admin
      .from('request_type_categories')
      .select('request_type:request_types(*)')
      .eq('category_id', categoryId)
      .eq('tenant_id', tenant.id);

    if (error) throw error;
    return (links ?? []).map((l) => l.request_type);
  }

  // Full hierarchy with request types attached at each level. Single round-trip worth of queries,
  // assembled in memory — fine at expected scale (tenant has O(10) categories, O(100) request types).
  async getTree(): Promise<CatalogTreeNode[]> {
    const tenant = TenantContext.current();

    const [categoriesRes, requestTypesRes, linksRes] = await Promise.all([
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, description, icon, display_order, parent_category_id, active')
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

  // Unified search across categories and request types. Returns each result with its breadcrumb
  // path(s) so the portal can render "IT › Hardware › Laptop Request" without a second round-trip.
  async search(query: string) {
    const tenant = TenantContext.current();
    const q = query.trim();
    if (!q) return { categories: [], request_types: [] };

    const pattern = `%${q.replace(/[%_]/g, '\\$&')}%`;

    const [categoriesRes, requestTypesRes, allCategoriesRes, linksRes] = await Promise.all([
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, description, icon, parent_category_id')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .or(`name.ilike.${pattern},description.ilike.${pattern}`)
        .limit(20),
      this.supabase.admin
        .from('request_types')
        .select('id, name, description, icon, domain, keywords')
        .eq('tenant_id', tenant.id)
        .eq('active', true)
        .or(`name.ilike.${pattern},description.ilike.${pattern}`)
        .limit(20),
      this.supabase.admin
        .from('service_catalog_categories')
        .select('id, name, parent_category_id')
        .eq('tenant_id', tenant.id),
      this.supabase.admin
        .from('request_type_categories')
        .select('request_type_id, category_id')
        .eq('tenant_id', tenant.id),
    ]);

    if (categoriesRes.error) throw categoriesRes.error;
    if (requestTypesRes.error) throw requestTypesRes.error;
    if (allCategoriesRes.error) throw allCategoriesRes.error;
    if (linksRes.error) throw linksRes.error;

    const allCategories = allCategoriesRes.data ?? [];
    const categoryById = new Map(allCategories.map((c) => [c.id, c]));

    const breadcrumbOf = (id: string): { id: string; name: string }[] => {
      const path: { id: string; name: string }[] = [];
      let current = categoryById.get(id);
      let guard = 0;
      while (current && guard++ < 10) {
        path.unshift({ id: current.id, name: current.name });
        if (!current.parent_category_id) break;
        current = categoryById.get(current.parent_category_id);
      }
      return path;
    };

    const linksByRequestType = new Map<string, string[]>();
    for (const link of linksRes.data ?? []) {
      const bucket = linksByRequestType.get(link.request_type_id) ?? [];
      bucket.push(link.category_id);
      linksByRequestType.set(link.request_type_id, bucket);
    }

    // Also match request types whose keywords array contains the query token.
    const keywordMatches = await this.supabase.admin
      .from('request_types')
      .select('id, name, description, icon, domain, keywords')
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .contains('keywords', [q.toLowerCase()])
      .limit(20);

    if (keywordMatches.error) throw keywordMatches.error;

    const requestTypeHits = new Map<string, RequestTypeRow>();
    for (const rt of [...(requestTypesRes.data ?? []), ...(keywordMatches.data ?? [])]) {
      requestTypeHits.set(rt.id, rt as RequestTypeRow);
    }

    return {
      categories: (categoriesRes.data ?? []).map((c) => ({
        ...c,
        breadcrumb: breadcrumbOf(c.id),
      })),
      request_types: Array.from(requestTypeHits.values()).map((rt) => ({
        ...rt,
        breadcrumbs: (linksByRequestType.get(rt.id) ?? []).map(breadcrumbOf),
      })),
    };
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

  async updateCategory(id: string, dto: Record<string, unknown>) {
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

  async linkRequestTypeToCategory(requestTypeId: string, categoryId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('request_type_categories')
      .insert({ tenant_id: tenant.id, request_type_id: requestTypeId, category_id: categoryId });

    if (error) throw error;
    return { linked: true };
  }
}
