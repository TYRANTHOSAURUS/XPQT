import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';

@Injectable()
export class FloorPlanService {
  constructor(private readonly supabase: SupabaseService) {}

  async getPublished(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.admin;
    const { data: floor } = await client
      .from('floor_plans')
      .select('*')
      .eq('space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!floor) return null;

    const { data: spaces } = await client
      .from('spaces')
      .select('id, name, type, capacity, amenities, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .not('floor_plan_polygon', 'is', null);

    // floor.image_url is a STORAGE PATH (not a URL). Resolve to a fresh signed URL
    // here so consumers don't see stale signatures. 1h TTL is plenty for a page load
    // + reasonable user session; clients re-fetch via React Query on revisit.
    const signedImageUrl = await this.signFloorPlanImage(floor.image_url as string | null);

    return { floor: { ...floor, image_url: signedImageUrl }, spaces: spaces ?? [] };
  }

  /** Resolve a storage path stored in floor_plans.image_url into a fresh signed URL. */
  private async signFloorPlanImage(pathOrNull: string | null): Promise<string | null> {
    if (!pathOrNull) return null;
    // If somehow a full URL is stored (legacy compat), pass through.
    if (pathOrNull.startsWith('http://') || pathOrNull.startsWith('https://')) return pathOrNull;
    const client = this.supabase.admin;
    const { data } = await client.storage.from('floor-plans').createSignedUrl(pathOrNull, 3600);
    return data?.signedUrl ?? null;
  }

  async publish(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.admin;
    const { data: draft } = await client
      .from('floor_plan_drafts')
      .select('id, image_url, width_px, height_px, polygons')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!draft) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');

    // Server-side preflight — fail fast with structured errors before invoking RPC.
    if (!(draft as { image_url: string | null }).image_url ||
        !(draft as { width_px: number | null }).width_px ||
        !(draft as { height_px: number | null }).height_px) {
      throw AppErrors.validationFailed('floor_plan.publish.image_required');
    }
    const polygons = (draft as { polygons: Array<{ space_id: string }> }).polygons;
    const unlinked = polygons.filter((p) => !p.space_id);
    if (unlinked.length > 0) {
      throw AppErrors.validationFailed('floor_plan.publish.unlinked_polygons', {
        detail: `${unlinked.length} polygon(s) have no linked space.`,
      });
    }

    const { data, error } = await client.rpc('publish_floor_plan_draft', {
      p_draft_id: (draft as { id: string }).id,
    });
    if (error) {
      // Translate known PG error codes; everything else is server-class.
      const code = (error as { code?: string }).code ?? '';
      if (code === '23502') throw AppErrors.validationFailed('floor_plan.publish.image_required');
      if (code === '22023') throw AppErrors.validationFailed('floor_plan.publish.invalid_polygons');
      if (code === '42501') throw AppErrors.forbidden('floor_plan.publish.cross_tenant');
      if (code === 'P0002') throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
      throw AppErrors.server('floor_plan.publish_failed');
    }
    return data as { history_id: string };
  }

  /** Direct query — no RPC needed (read-only, no cross-table invariants). */
  async listForAdmin(tenantId: string) {
    const client = this.supabase.admin;
    const { data, error } = await client
      .from('spaces')
      .select(
        `
        id, name,
        parent:parent_id (id, name),
        floor_plans (space_id, updated_at)
      `,
      )
      .eq('type', 'floor')
      .eq('tenant_id', tenantId)
      .order('name');
    if (error) throw AppErrors.server('floor_plan.list_failed');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((row: any) => {
      const fp = Array.isArray(row.floor_plans) ? row.floor_plans[0] : row.floor_plans;
      return {
        id: row.id as string,
        name: row.name as string,
        building_name: (row.parent?.name as string | undefined) ?? '—',
        has_plan: fp != null,
        last_published_at: (fp?.updated_at as string | undefined) ?? null,
      };
    });
  }

  async restorePublish(historyId: string, _tenantId: string) {
    const client = this.supabase.admin;
    const { error } = await client.rpc('restore_floor_plan_publish', { p_history_id: historyId });
    if (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code === 'P0002') throw AppErrors.notFoundWithCode('floor_plan.history.not_found');
      if (code === '42501') throw AppErrors.forbidden('floor_plan.history.cross_tenant');
      throw AppErrors.server('floor_plan.restore_failed');
    }
    return { ok: true };
  }

  async getAvailability(floorSpaceId: string, tenantId: string, userId: string, windowStart: string, windowEnd: string) {
    const client = this.supabase.admin;
    // p_tenant_id is server-resolved (TenantContext); RPC trusts the param because
    // it's granted only to service_role (codex C5 + C7).
    const { data, error } = await client.rpc('floor_availability', {
      p_tenant_id: tenantId,
      p_floor_space_id: floorSpaceId,
      p_window_start: windowStart,
      p_window_end: windowEnd,
      p_user_id: userId,
    });
    if (error) {
      const code = (error as { code?: string }).code ?? '';
      if (code === '22023') throw AppErrors.validationFailed('floor_plan.availability.invalid_window');
      throw AppErrors.server('floor_plan.availability_failed');
    }
    // Resolve image_url to a fresh signed URL if a published floor plan exists.
    const { data: floor } = await client
      .from('floor_plans')
      .select('image_url, width_px, height_px')
      .eq('space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    const floorMeta = floor
      ? { image_url: await this.signFloorPlanImage(floor.image_url as string | null), width_px: floor.width_px, height_px: floor.height_px }
      : null;
    return { ...(data as object), floor: floorMeta };
  }

  async listPublishHistory(floorSpaceId: string, tenantId: string) {
    const client = this.supabase.admin;
    const { data } = await client
      .from('floor_plan_publish_history')
      .select('id, published_at, published_by, image_url, width_px, height_px, polygons, labels')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .order('published_at', { ascending: false })
      .limit(20);
    return data ?? [];
  }
}
