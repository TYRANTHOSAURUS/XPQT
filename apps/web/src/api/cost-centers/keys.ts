export const costCenterKeys = {
  all: ['cost-centers'] as const,
  lists: () => [...costCenterKeys.all, 'list'] as const,
  list: (params: { active?: boolean }) => [...costCenterKeys.lists(), params] as const,
  details: () => [...costCenterKeys.all, 'detail'] as const,
  detail: (id: string) => [...costCenterKeys.details(), id] as const,
} as const;
