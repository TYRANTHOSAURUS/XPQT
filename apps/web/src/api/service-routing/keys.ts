export const serviceRoutingKeys = {
  all: ['service-routing'] as const,
  lists: () => [...serviceRoutingKeys.all, 'list'] as const,
  list: () => [...serviceRoutingKeys.lists()] as const,
  details: () => [...serviceRoutingKeys.all, 'detail'] as const,
  detail: (id: string) => [...serviceRoutingKeys.details(), id] as const,
} as const;
