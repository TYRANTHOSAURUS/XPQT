import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { ServiceRuleService, type ServiceRuleUpsertDto } from './service-rule.service';

/**
 * Service catalog endpoints.
 *
 * Two surfaces share this module:
 *   - Portal-facing reads under `/service-catalog/...` consumed by the
 *     booking-confirm dialog and the standalone-order flow.
 *   - Admin reads/writes under `/admin/booking-services/...` (rules CRUD +
 *     simulation; lands in a 2E follow-up).
 *
 * The `available-items` probe is the booking dialog's
 * "what can I order here, right now?" question — fired once per service
 * section when expanded. Scoped per (delivery_space, on_date, service_type).
 */
@Controller()
export class ServiceCatalogController {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly rules: ServiceRuleService,
  ) {}

  // ── Portal reads ───────────────────────────────────────────────────────

  /**
   * GET /service-catalog/available-items
   *   ?delivery_space_id=<uuid>
   *   &on_date=<YYYY-MM-DD>
   *   &service_type=catering|av_equipment|supplies|facilities_services|...
   *
   * Returns every catalog_item with at least one resolvable menu offer for
   * the (delivery_space, date) tuple. Each row carries the highest-ranked
   * offer's price, unit, lead_time_hours, vendor/team, and menu provenance —
   * so the dialog can render lines without a follow-up RPC.
   *
   * Why one probe per section: the dialog opens with sections collapsed; we
   * only fetch when the user expands one. React Query staletime keeps
   * collapse/re-expand cheap inside the same dialog session.
   */
  @Get('service-catalog/available-items')
  async listAvailableItems(
    @Query('delivery_space_id') deliverySpaceId: string,
    @Query('on_date') onDate: string,
    @Query('service_type') serviceType: string,
  ) {
    if (!deliverySpaceId) {
      throw new BadRequestException({
        code: 'missing_delivery_space',
        message: 'delivery_space_id query parameter is required',
      });
    }
    if (!serviceType) {
      throw new BadRequestException({
        code: 'missing_service_type',
        message: 'service_type query parameter is required',
      });
    }
    const tenant = TenantContext.current();
    const category = SERVICE_TYPE_TO_CATEGORY[serviceType] ?? null;
    if (!category) return { items: [] };

    // 1. Pull every active catalog_item in the tenant matching the
    //    category bucket implied by service_type.
    const itemsRes = await this.supabase.admin
      .from('catalog_items')
      .select('id, name, description, category, subcategory, dietary_tags, image_url, lead_time_hours')
      .eq('tenant_id', tenant.id)
      .eq('category', category)
      .eq('active', true);
    if (itemsRes.error) throw itemsRes.error;

    const items = (itemsRes.data ?? []) as Array<{
      id: string;
      name: string;
      description: string | null;
      category: string;
      subcategory: string | null;
      dietary_tags: string[] | null;
      image_url: string | null;
      lead_time_hours: number | null;
    }>;
    if (items.length === 0) return { items: [] };

    // 2. Resolve each via resolve_menu_offer in parallel; drop items
    //    that don't resolve (no menu serves this location/date).
    const resolved = await Promise.all(
      items.map(async (item) => {
        const offer = await this.supabase.admin.rpc('resolve_menu_offer', {
          p_catalog_item_id: item.id,
          p_delivery_space_id: deliverySpaceId,
          p_on_date: onDate || new Date().toISOString().slice(0, 10),
        });
        if (offer.error) throw offer.error;
        const offerRow = ((offer.data ?? []) as Array<{
          menu_id: string;
          menu_item_id: string;
          vendor_id: string | null;
          fulfillment_team_id: string | null;
          price: number | null;
          unit: 'per_item' | 'per_person' | 'flat_rate' | null;
          lead_time_hours: number | null;
          service_type: string;
        }>)[0];
        return offerRow ? { item, offer: offerRow } : null;
      }),
    );

    // 3. Filter by service_type — the resolver may surface items
    //    whose menu has a different service_type than the section
    //    requested; in that case skip.
    return {
      items: resolved
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .filter((r) => r.offer.service_type === serviceType)
        .map((r) => ({
          catalog_item_id: r.item.id,
          name: r.item.name,
          description: r.item.description,
          category: r.item.category,
          subcategory: r.item.subcategory,
          dietary_tags: r.item.dietary_tags ?? [],
          image_url: r.item.image_url,
          menu_id: r.offer.menu_id,
          vendor_id: r.offer.vendor_id,
          fulfillment_team_id: r.offer.fulfillment_team_id,
          price: r.offer.price,
          unit: r.offer.unit,
          lead_time_hours: r.offer.lead_time_hours ?? r.item.lead_time_hours,
          service_type: r.offer.service_type,
        })),
    };
  }

  // ── Service rule CRUD (admin) ──────────────────────────────────────────

  @Get('admin/booking-services/rule-templates')
  listTemplates() {
    return this.rules.listTemplates();
  }

  @Get('admin/booking-services/rules')
  list(@Query('active') active?: string) {
    const filter =
      active === 'true' ? { active: true } : active === 'false' ? { active: false } : undefined;
    return this.rules.list(filter);
  }

  @Get('admin/booking-services/rules/:id')
  findOne(@Param('id') id: string) {
    return this.rules.findOne(id);
  }

  @Post('admin/booking-services/rules')
  create(@Body() dto: ServiceRuleUpsertDto) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.rules.create(dto);
  }

  @Patch('admin/booking-services/rules/:id')
  update(@Param('id') id: string, @Body() dto: Partial<ServiceRuleUpsertDto>) {
    if (!dto || typeof dto !== 'object') {
      throw new BadRequestException({ code: 'invalid_payload', message: 'request body required' });
    }
    return this.rules.update(id, dto);
  }

  @Delete('admin/booking-services/rules/:id')
  remove(@Param('id') id: string) {
    return this.rules.remove(id);
  }
}

const SERVICE_TYPE_TO_CATEGORY: Record<string, string> = {
  // Maps catalog_menus.service_type → catalog_items.category. The resolver
  // ranks across menus + items, but we still pre-filter at the category
  // boundary so the candidate set stays small.
  catering: 'food_and_drinks',
  av_equipment: 'equipment',
  supplies: 'supplies',
  facilities_services: 'services',
  cleaning: 'services',
  maintenance: 'services',
  transport: 'services',
  other: 'services',
};
