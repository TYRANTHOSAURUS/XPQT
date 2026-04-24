// apps/api/src/modules/portal-appearance/portal-appearance.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { PortalAppearance, UpdatePortalAppearanceDto } from './dto';

const BUCKET = 'portal-assets';
const HERO_MAX_BYTES = 2 * 1024 * 1024;
const HERO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

interface AppearanceRow {
  location_id: string;
  hero_image_url: string | null;
  welcome_headline: string | null;
  supporting_line: string | null;
  greeting_enabled: boolean;
}

interface SpaceRow { id: string; parent_id: string | null }

/**
 * Walk up the spaces tree from `startId` looking for a portal_appearance row
 * whose location_id matches the walked id. Returns the first match, else null.
 * Exported for unit testing (pure function, no I/O).
 */
export function resolveAppearance(
  startId: string,
  rows: AppearanceRow[],
  spaces: SpaceRow[],
): AppearanceRow | null {
  const byId = new Map(spaces.map((s) => [s.id, s]));
  const byLoc = new Map(rows.map((r) => [r.location_id, r]));
  const seen = new Set<string>();
  let cur: string | null = startId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const hit = byLoc.get(cur);
    if (hit) return hit;
    cur = byId.get(cur)?.parent_id ?? null;
  }
  return null;
}

@Injectable()
export class PortalAppearanceService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(locationId: string): Promise<PortalAppearance | null> {
    const tenant = TenantContext.current();
    const [{ data: rows, error: rowsErr }, { data: spaces, error: spacesErr }] =
      await Promise.all([
        this.supabase.admin
          .from('portal_appearance')
          .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
          .eq('tenant_id', tenant.id),
        this.supabase.admin
          .from('spaces')
          .select('id, parent_id')
          .eq('tenant_id', tenant.id),
      ]);
    if (rowsErr) throw new InternalServerErrorException(rowsErr.message);
    if (spacesErr) throw new InternalServerErrorException(spacesErr.message);

    const resolved = resolveAppearance(locationId, rows ?? [], spaces ?? []);
    return resolved;
  }

  async list(): Promise<AppearanceRow[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .eq('tenant_id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);
    return data ?? [];
  }

  async update(dto: UpdatePortalAppearanceDto): Promise<PortalAppearance> {
    if (!dto.location_id) throw new BadRequestException('location_id is required');
    const tenant = TenantContext.current();

    const payload: Record<string, unknown> = { tenant_id: tenant.id, location_id: dto.location_id };
    if (dto.welcome_headline !== undefined) payload.welcome_headline = dto.welcome_headline;
    if (dto.supporting_line !== undefined) payload.supporting_line = dto.supporting_line;
    if (dto.greeting_enabled !== undefined) payload.greeting_enabled = dto.greeting_enabled;

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .upsert(payload, { onConflict: 'tenant_id,location_id' })
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Upsert returned no row');
    return data as PortalAppearance;
  }

  async uploadHero(
    locationId: string,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<PortalAppearance> {
    if (!locationId) throw new BadRequestException('location_id is required');
    if (!file) throw new BadRequestException('Missing file');
    if (!HERO_MIMES.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported mime: ${file.mimetype}`);
    }
    if (file.buffer.byteLength > HERO_MAX_BYTES) {
      throw new BadRequestException(`File too large: ${file.buffer.byteLength} (max ${HERO_MAX_BYTES})`);
    }

    const tenant = TenantContext.current();
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const)[file.mimetype as 'image/jpeg' | 'image/png' | 'image/webp'];
    const path = `${tenant.id}/hero/${locationId}.${ext}`;

    const { error: uploadErr } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, file.buffer, { contentType: file.mimetype, upsert: true, cacheControl: '3600' });
    if (uploadErr) throw new InternalServerErrorException(uploadErr.message);

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .upsert(
        { tenant_id: tenant.id, location_id: locationId, hero_image_url: bustedUrl },
        { onConflict: 'tenant_id,location_id' },
      )
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Upsert returned no row');
    return data as PortalAppearance;
  }

  async removeHero(locationId: string): Promise<PortalAppearance | null> {
    const tenant = TenantContext.current();
    const paths = ['jpg', 'png', 'webp'].map((e) => `${tenant.id}/hero/${locationId}.${e}`);
    await this.supabase.admin.storage.from(BUCKET).remove(paths);

    const { data, error } = await this.supabase.admin
      .from('portal_appearance')
      .update({ hero_image_url: null })
      .eq('tenant_id', tenant.id)
      .eq('location_id', locationId)
      .select('location_id, hero_image_url, welcome_headline, supporting_line, greeting_enabled')
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? null) as PortalAppearance | null;
  }
}
