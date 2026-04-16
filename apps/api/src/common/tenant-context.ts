import { AsyncLocalStorage } from 'async_hooks';

export interface TenantInfo {
  id: string;
  slug: string;
  tier: 'standard' | 'enterprise';
  db_connection?: string; // only set for enterprise tier with dedicated DB
}

const tenantStorage = new AsyncLocalStorage<TenantInfo>();

export const TenantContext = {
  run<T>(tenant: TenantInfo, fn: () => T): T {
    return tenantStorage.run(tenant, fn);
  },

  current(): TenantInfo {
    const tenant = tenantStorage.getStore();
    if (!tenant) {
      throw new Error('No tenant context — request not processed through TenantMiddleware');
    }
    return tenant;
  },

  currentOrNull(): TenantInfo | undefined {
    return tenantStorage.getStore();
  },
};
