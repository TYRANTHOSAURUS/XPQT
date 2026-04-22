import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { assertValidHex, assertUsablePrimary } from './color-utils';
import { sanitizeSvg } from './svg-sanitizer';

const BUCKET = 'tenant-branding';
const LOGO_MAX_BYTES = 1 * 1024 * 1024;
const FAVICON_MAX_BYTES = 256 * 1024;

const LOGO_MIMES = new Set(['image/svg+xml', 'image/png', 'image/webp']);
const FAVICON_MIMES = new Set([
  'image/svg+xml',
  'image/png',
  'image/x-icon',
  'image/vnd.microsoft.icon',
]);

export type LogoKind = 'light' | 'dark' | 'favicon';

export interface Branding {
  logo_light_url: string | null;
  logo_dark_url: string | null;
  favicon_url: string | null;
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

export interface UpdateBrandingDto {
  primary_color: string;
  accent_color: string;
  theme_mode_default: 'light' | 'dark' | 'system';
}

const KIND_TO_FIELD: Record<LogoKind, keyof Branding> = {
  light: 'logo_light_url',
  dark: 'logo_dark_url',
  favicon: 'favicon_url',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
};

@Injectable()
export class BrandingService {
  constructor(private readonly supabase: SupabaseService) {}

  async get(): Promise<Branding> {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('branding')
      .eq('id', tenant.id)
      .single();
    if (error || !data) throw new NotFoundException('Tenant not found');
    return data.branding as Branding;
  }

  async update(dto: UpdateBrandingDto): Promise<Branding> {
    assertValidHex(dto.primary_color, 'primary_color');
    assertValidHex(dto.accent_color, 'accent_color');
    assertUsablePrimary(dto.primary_color);
    if (!['light', 'dark', 'system'].includes(dto.theme_mode_default)) {
      throw new BadRequestException('theme_mode_default must be light, dark, or system');
    }

    const tenant = TenantContext.current();
    const current = await this.get();
    const next: Branding = {
      ...current,
      primary_color: dto.primary_color.toLowerCase(),
      accent_color: dto.accent_color.toLowerCase(),
      theme_mode_default: dto.theme_mode_default,
    };
    const { error } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);

    await this.writeAuditEvent('tenant.branding.updated', { fields: Object.keys(dto) });
    return next;
  }

  async uploadLogo(
    kind: LogoKind,
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<Branding> {
    this.assertLogoFile(kind, file);

    let bodyBuffer = file.buffer;
    if (file.mimetype === 'image/svg+xml') {
      const clean = sanitizeSvg(file.buffer.toString('utf8'));
      bodyBuffer = Buffer.from(clean, 'utf8');
    }

    const tenant = TenantContext.current();
    const ext = EXT_BY_MIME[file.mimetype];
    const path = `${tenant.id}/${kind === 'favicon' ? 'favicon' : `logo-${kind}`}.${ext}`;

    const { error: uploadError } = await this.supabase.admin.storage
      .from(BUCKET)
      .upload(path, bodyBuffer, {
        contentType: file.mimetype,
        upsert: true,
        cacheControl: '3600',
      });
    if (uploadError) throw new InternalServerErrorException(uploadError.message);

    const { data: pub } = this.supabase.admin.storage.from(BUCKET).getPublicUrl(path);
    const bustedUrl = `${pub.publicUrl}?v=${Date.now()}`;

    const current = await this.get();
    const next: Branding = { ...current, [KIND_TO_FIELD[kind]]: bustedUrl };
    const { error: updateError } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (updateError) throw new InternalServerErrorException(updateError.message);

    await this.writeAuditEvent('tenant.branding.updated', { uploaded: kind });
    return next;
  }

  async removeLogo(kind: LogoKind): Promise<Branding> {
    const tenant = TenantContext.current();
    const current = await this.get();

    // Best-effort delete across possible extensions
    const baseName = kind === 'favicon' ? 'favicon' : `logo-${kind}`;
    const candidates = ['svg', 'png', 'webp', 'ico'].map(
      (ext) => `${tenant.id}/${baseName}.${ext}`,
    );
    await this.supabase.admin.storage.from(BUCKET).remove(candidates);

    const next: Branding = { ...current, [KIND_TO_FIELD[kind]]: null };
    const { error } = await this.supabase.admin
      .from('tenants')
      .update({ branding: next })
      .eq('id', tenant.id);
    if (error) throw new InternalServerErrorException(error.message);

    await this.writeAuditEvent('tenant.branding.updated', { removed: kind });
    return next;
  }

  private assertLogoFile(
    kind: LogoKind,
    file: { mimetype: string; size: number; buffer: Buffer },
  ): void {
    const allowed = kind === 'favicon' ? FAVICON_MIMES : LOGO_MIMES;
    if (!allowed.has(file.mimetype)) {
      throw new BadRequestException(
        `Unsupported MIME type for ${kind}: ${file.mimetype}. Allowed: ${[...allowed].join(', ')}`,
      );
    }
    // Trust buffer.byteLength, not the client-reported file.size (from Content-Length).
    const limit = kind === 'favicon' ? FAVICON_MAX_BYTES : LOGO_MAX_BYTES;
    const actualBytes = file.buffer.byteLength;
    if (actualBytes > limit) {
      throw new BadRequestException(
        `File too large: ${actualBytes} bytes (max ${limit} bytes for ${kind})`,
      );
    }
  }

  private async writeAuditEvent(
    eventType: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current();
    // Non-fatal — audit failures should not block the operation but MUST be logged.
    // Supabase returns { error } rather than throwing, so catch both the returned
    // error and any thrown (network) error.
    try {
      const { error } = await this.supabase.admin.from('audit_events').insert({
        tenant_id: tenant.id,
        event_type: eventType,
        entity_type: 'tenant',
        entity_id: tenant.id,
        details,
      });
      if (error) {
        console.error('Audit insert failed:', error.message, { eventType, details });
      }
    } catch (err) {
      console.error('Audit insert threw:', err, { eventType, details });
    }
  }
}
