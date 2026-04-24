export const spaceKeys = {
  all: ['spaces'] as const,
  tree: () => [...spaceKeys.all, 'tree'] as const,
  lists: () => [...spaceKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown> = {}) => [...spaceKeys.lists(), filters] as const,
  details: () => [...spaceKeys.all, 'detail'] as const,
  detail: (id: string) => [...spaceKeys.details(), id] as const,
  children: (parentId: string) => [...spaceKeys.all, 'children', parentId] as const,
} as const;
