import { Injectable } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { AppErrors } from '../../common/errors';
import { throwZodError } from '../../common/errors';
import { UpdateDraftSchema } from './dto/update-draft.dto';
import type { DraftResponse } from './dto/get-draft.dto';

@Injectable()
export class FloorPlanDraftService {
  constructor(private readonly supabase: SupabaseService) {}

  async getOrCreate(floorSpaceId: string, userId: string, tenantId: string): Promise<DraftResponse> {
    const client = this.supabase.admin;

    const { data: existing } = await client
      .from('floor_plan_drafts')
      .select('*')
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (existing) return existing as DraftResponse;

    // Seed from published state
    const { data: floor } = await client
      .from('floor_plans')
      .select('image_url, width_px, height_px, labels')
      .eq('space_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .maybeSingle();

    const { data: spaces } = await client
      .from('spaces')
      .select('id, floor_plan_polygon, floor_plan_render_hint')
      .eq('parent_id', floorSpaceId)
      .eq('tenant_id', tenantId)
      .not('floor_plan_polygon', 'is', null);

    // Validate each published polygon before seeding the draft. Migration 00367
    // forces {points:[…]} shape, but its CHECK only requires array-length >= 3
    // — not that each entry is a finite {x,y}. Any malformed row would otherwise
    // poison the draft, autosave back to the server, and 422 forever.
    const seedPolygons = (spaces ?? [])
      .map((s) => {
        const raw = s.floor_plan_polygon as { points?: unknown } | null;
        const pts = raw && Array.isArray(raw.points) ? raw.points : [];
        const valid: Array<{ x: number; y: number }> = [];
        for (const p of pts) {
          if (
            p &&
            typeof p === 'object' &&
            typeof (p as { x?: unknown }).x === 'number' &&
            typeof (p as { y?: unknown }).y === 'number' &&
            Number.isFinite((p as { x: number }).x) &&
            Number.isFinite((p as { y: number }).y)
          ) {
            valid.push({ x: (p as { x: number }).x, y: (p as { y: number }).y });
          }
        }
        if (valid.length < 3) return null;
        return {
          space_id: s.id,
          points: valid,
          render_hint: (s as { floor_plan_render_hint?: string }).floor_plan_render_hint ?? 'default',
        };
      })
      .filter((p): p is { space_id: string; points: Array<{ x: number; y: number }>; render_hint: string } => p !== null);

    const { data: created, error } = await client
      .from('floor_plan_drafts')
      .insert({
        tenant_id: tenantId,
        floor_space_id: floorSpaceId,
        image_url: floor?.image_url ?? null,
        width_px: floor?.width_px ?? null,
        height_px: floor?.height_px ?? null,
        polygons: seedPolygons,
        labels: floor?.labels ?? [],
        created_by: userId,
      })
      .select('*')
      .single();

    if (error || !created) throw AppErrors.server('floor_plan.draft.create_failed');
    return created as DraftResponse;
  }

  /**
   * Atomic CAS update: single UPDATE … WHERE updated_at = $ifMatch RETURNING *.
   * If 0 rows returned: disambiguate (missing = 404, exists with different updated_at = 409).
   * Caller passes If-Match header value as ifMatch.
   */
  async update(
    floorSpaceId: string,
    tenantId: string,
    ifMatch: string | undefined,
    body: unknown,
  ): Promise<DraftResponse> {
    const parsed = UpdateDraftSchema.safeParse(body);
    if (!parsed.success) throwZodError(parsed.error);

    const client = this.supabase.admin;

    // Validate every polygon's space_id is a child of this floor in this tenant.
    if (parsed.data.polygons && parsed.data.polygons.length > 0) {
      const ids = parsed.data.polygons.map((p) => p.space_id).filter(Boolean);
      if (ids.length > 0) {
        const { data: spaces } = await client
          .from('spaces')
          .select('id, parent_id')
          .in('id', ids)
          .eq('tenant_id', tenantId);
        const valid = new Set((spaces ?? []).filter((s) => s.parent_id === floorSpaceId).map((s) => s.id));
        const invalid = ids.filter((id) => !valid.has(id));
        if (invalid.length > 0) {
          throw AppErrors.validationFailed('floor_plan.draft.invalid_polygons', {
            detail: `Space IDs not children of this floor: ${invalid.join(', ')}`,
          });
        }
      }
    }

    // Atomic CAS: single UPDATE with updated_at filter. If ifMatch is provided
    // and doesn't match the DB row, the WHERE matches 0 rows → stale-write.
    // Without ifMatch (first caller / seed), unconditionally update (last-writer-wins).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query: any = client
      .from('floor_plan_drafts')
      .update({ ...parsed.data })
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId);
    if (ifMatch) query = query.eq('updated_at', ifMatch);

    const { data, error } = await (query as ReturnType<typeof client.from>).select('*').maybeSingle();
    if (error) throw AppErrors.server('floor_plan.draft.update_failed');

    if (!data) {
      // Either the row doesn't exist OR our ifMatch was stale. Disambiguate.
      const { data: current } = await client
        .from('floor_plan_drafts')
        .select('updated_at')
        .eq('floor_space_id', floorSpaceId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (!current) throw AppErrors.notFoundWithCode('floor_plan.draft.not_found');
      throw AppErrors.conflict('floor_plan.draft.stale_update', {
        serverVersion: (current as { updated_at: string }).updated_at,
      });
    }
    return data as DraftResponse;
  }

  async discard(floorSpaceId: string, tenantId: string): Promise<void> {
    const client = this.supabase.admin;
    const { error } = await client
      .from('floor_plan_drafts')
      .delete()
      .eq('floor_space_id', floorSpaceId)
      .eq('tenant_id', tenantId);
    if (error) throw AppErrors.server('floor_plan.draft.discard_failed');
  }
}
