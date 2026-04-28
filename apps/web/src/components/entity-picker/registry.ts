import { catalogItemEntityAdapter } from './adapters/catalog-item';
import { costCenterEntityAdapter } from './adapters/cost-center';
import { personEntityAdapter } from './adapters/person';
import { requestTypeEntityAdapter } from './adapters/request-type';
import type { EntityAdapter, EntityType } from './types';

/**
 * Static adapter registry. Sprint 1A ships four; subsequent sweeps register
 * more (location, vendor, asset_type, role, …).
 *
 * Adapters are stateless + idempotent — registering once at module load is
 * enough. We intentionally avoid runtime registration to keep the union
 * type a closed set.
 */
const REGISTRY: Record<EntityType, EntityAdapter<{ id: string }>> = {
  person:        personEntityAdapter as unknown as EntityAdapter<{ id: string }>,
  catalog_item:  catalogItemEntityAdapter as unknown as EntityAdapter<{ id: string }>,
  request_type:  requestTypeEntityAdapter as unknown as EntityAdapter<{ id: string }>,
  cost_center:   costCenterEntityAdapter as unknown as EntityAdapter<{ id: string }>,
};

export function getEntityAdapter<T extends { id: string }>(type: EntityType): EntityAdapter<T> {
  return REGISTRY[type] as unknown as EntityAdapter<T>;
}

export function listRegisteredEntityTypes(): EntityType[] {
  return Object.keys(REGISTRY) as EntityType[];
}
