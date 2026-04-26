export const bundleTemplateKeys = {
  all: ['bundle-templates'] as const,
  lists: () => [...bundleTemplateKeys.all, 'list'] as const,
  list: (params: { active?: boolean }) => [...bundleTemplateKeys.lists(), params] as const,
  details: () => [...bundleTemplateKeys.all, 'detail'] as const,
  detail: (id: string) => [...bundleTemplateKeys.details(), id] as const,
} as const;
