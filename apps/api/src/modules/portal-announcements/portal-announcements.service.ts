// apps/api/src/modules/portal-announcements/portal-announcements.service.ts
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { Announcement, PublishAnnouncementDto } from './dto';

@Injectable()
export class PortalAnnouncementsService {
  constructor(private readonly supabase: SupabaseService) {}

  /** Walk-up resolver: the first ancestor with an active announcement wins. */
  async getActiveForLocation(locationId: string): Promise<Announcement | null> {
    const tenant = TenantContext.current();
    const [{ data: anns, error: aErr }, { data: spaces, error: sErr }] = await Promise.all([
      this.supabase.admin
        .from('portal_announcements')
        .select('id, location_id, title, body, published_at, expires_at, created_by')
        .eq('tenant_id', tenant.id)
        .or('expires_at.is.null,expires_at.gt.' + new Date().toISOString()),
      this.supabase.admin
        .from('spaces')
        .select('id, parent_id')
        .eq('tenant_id', tenant.id),
    ]);
    if (aErr) throw new InternalServerErrorException(aErr.message);
    if (sErr) throw new InternalServerErrorException(sErr.message);

    const byLoc = new Map<string, Announcement>();
    for (const a of anns ?? []) byLoc.set(a.location_id, a as Announcement);
    const byId = new Map((spaces ?? []).map((s) => [s.id, s.parent_id]));
    const seen = new Set<string>();
    let cur: string | null = locationId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const hit = byLoc.get(cur);
      if (hit) return hit;
      cur = byId.get(cur) ?? null;
    }
    return null;
  }

  async listAll(): Promise<Announcement[]> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('portal_announcements')
      .select('id, location_id, title, body, published_at, expires_at, created_by')
      .eq('tenant_id', tenant.id)
      .order('published_at', { ascending: false });
    if (error) throw new InternalServerErrorException(error.message);
    return (data ?? []) as Announcement[];
  }

  /** Publish retires any existing active announcement for the same location. */
  async publish(dto: PublishAnnouncementDto, authUserId: string): Promise<Announcement> {
    if (!dto.location_id || !dto.title?.trim() || !dto.body?.trim()) {
      throw new BadRequestException('location_id, title, body are required');
    }
    const tenant = TenantContext.current();

    // Retire existing active: expire at now()
    const nowIso = new Date().toISOString();
    await this.supabase.admin
      .from('portal_announcements')
      .update({ expires_at: nowIso })
      .eq('tenant_id', tenant.id)
      .eq('location_id', dto.location_id)
      .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

    const { data, error } = await this.supabase.admin
      .from('portal_announcements')
      .insert({
        tenant_id: tenant.id,
        location_id: dto.location_id,
        title: dto.title.trim(),
        body: dto.body.trim(),
        expires_at: dto.expires_at ?? null,
        created_by: authUserId,
      })
      .select('id, location_id, title, body, published_at, expires_at, created_by')
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    if (!data) throw new NotFoundException('Insert returned no row');
    return data as Announcement;
  }

  async unpublish(id: string): Promise<void> {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('portal_announcements')
      .update({ expires_at: new Date().toISOString() })
      .eq('tenant_id', tenant.id)
      .eq('id', id);
    if (error) throw new InternalServerErrorException(error.message);
  }
}
