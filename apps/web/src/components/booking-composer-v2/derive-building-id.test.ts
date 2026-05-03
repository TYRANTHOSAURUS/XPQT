import { describe, expect, it } from 'vitest';
import { deriveBuildingId } from './derive-building-id';
import type { Space } from '@/api/spaces';

const tree: Space[] = [
  { id: 'site-1', name: 'HQ', type: 'site', parent_id: null, capacity: null } as unknown as Space,
  { id: 'b-1', name: 'Tower A', type: 'building', parent_id: 'site-1', capacity: null } as unknown as Space,
  { id: 'f-1', name: 'Floor 3', type: 'floor', parent_id: 'b-1', capacity: null } as unknown as Space,
  { id: 'r-1', name: 'Maple', type: 'room', parent_id: 'f-1', capacity: 8 } as unknown as Space,
  { id: 'r-orphan', name: 'Detached', type: 'room', parent_id: null, capacity: null } as unknown as Space,
  { id: 'site-only', name: 'Annex', type: 'site', parent_id: null, capacity: null } as unknown as Space,
  { id: 'r-site-only', name: 'AnnexRoom', type: 'room', parent_id: 'site-only', capacity: null } as unknown as Space,
];

describe('deriveBuildingId', () => {
  it('returns the building when one exists in the chain', () => {
    expect(deriveBuildingId(tree, 'r-1')).toBe('b-1');
  });

  it('falls back to a site when no building exists', () => {
    expect(deriveBuildingId(tree, 'r-site-only')).toBe('site-only');
  });

  it('returns empty string when no anchor can be resolved', () => {
    expect(deriveBuildingId(tree, 'r-orphan')).toBe('');
  });

  it('returns empty string when spaceId is null', () => {
    expect(deriveBuildingId(tree, null)).toBe('');
  });

  it('returns empty string when the cache is undefined', () => {
    expect(deriveBuildingId(undefined, 'r-1')).toBe('');
  });
});
