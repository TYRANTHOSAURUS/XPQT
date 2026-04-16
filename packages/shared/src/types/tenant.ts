export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'inactive' | 'provisioning';
  branding: TenantBranding;
  feature_flags: Record<string, boolean>;
  release_ring: 'stable' | 'canary';
  tier: 'standard' | 'enterprise';
  timezone_default: string;
  locale_default: string;
  created_at: string;
  updated_at: string;
}

export interface TenantBranding {
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  theme_mode: 'light' | 'dark' | 'system';
}
