export interface ServiceRuleListFilters {
  active?: boolean;
  target_kind?: 'catalog_item' | 'menu' | 'catalog_category' | 'tenant';
}

export const serviceRuleKeys = {
  all: ['service-rules'] as const,
  lists: () => [...serviceRuleKeys.all, 'list'] as const,
  list: (filters: ServiceRuleListFilters) => [...serviceRuleKeys.lists(), filters] as const,
  details: () => [...serviceRuleKeys.all, 'detail'] as const,
  detail: (id: string) => [...serviceRuleKeys.details(), id] as const,
  templates: () => [...serviceRuleKeys.all, 'templates'] as const,
  simulation: (ruleId: string, scenarioId: string) =>
    [...serviceRuleKeys.all, 'simulation', ruleId, scenarioId] as const,
} as const;
