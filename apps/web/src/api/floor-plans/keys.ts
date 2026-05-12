export const floorPlanKeys = {
  all: ['floor-plans'] as const,
  adminIndex: () => [...floorPlanKeys.all, 'admin-index'] as const,
  floor: (floorSpaceId: string) => [...floorPlanKeys.all, 'floor', floorSpaceId] as const,
  floorDraft: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'draft'] as const,
  floorPublished: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'published'] as const,
  floorHistory: (floorSpaceId: string) => [...floorPlanKeys.floor(floorSpaceId), 'history'] as const,
};
