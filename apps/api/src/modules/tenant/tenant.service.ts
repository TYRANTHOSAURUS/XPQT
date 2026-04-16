import { Injectable, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantInfo } from '../../common/tenant-context';

interface TenantRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  tier: 'standard' | 'enterprise';
  db_connection: string | null;
  feature_flags: Record<string, boolean>;
  release_ring: string;
  branding: Record<string, unknown>;
  timezone_default: string;
  locale_default: string;
}

@Injectable()
export class TenantService implements OnModuleInit {
  // Simple in-memory cache — tenant registry is small and rarely changes
  private cache = new Map<string, TenantInfo>();
  private slugIndex = new Map<string, string>(); // slug → id

  constructor(private readonly supabase: SupabaseService) {}

  async onModuleInit() {
    await this.refreshCache();
  }

  async resolveBySlug(slug: string): Promise<TenantInfo | null> {
    const id = this.slugIndex.get(slug);
    if (id) return this.cache.get(id) ?? null;

    // Cache miss — try DB
    await this.refreshCache();
    const retryId = this.slugIndex.get(slug);
    return retryId ? this.cache.get(retryId) ?? null : null;
  }

  async resolveById(id: string): Promise<TenantInfo | null> {
    return this.cache.get(id) ?? null;
  }

  async resolveDefault(): Promise<TenantInfo | null> {
    // For local dev — return the first active tenant
    for (const tenant of this.cache.values()) {
      return tenant;
    }
    return null;
  }

  private async refreshCache() {
    const { data, error } = await this.supabase.admin
      .from('tenants')
      .select('*')
      .eq('status', 'active');

    if (error) {
      console.error('Failed to load tenant registry:', error.message);
      return;
    }

    this.cache.clear();
    this.slugIndex.clear();

    for (const row of (data ?? []) as TenantRecord[]) {
      const info: TenantInfo = {
        id: row.id,
        slug: row.slug,
        tier: row.tier,
        db_connection: row.db_connection ?? undefined,
      };
      this.cache.set(row.id, info);
      this.slugIndex.set(row.slug, row.id);
    }
  }
}
