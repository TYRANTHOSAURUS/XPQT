import type { RuleListFilters } from './types';

/**
 * Key factory for room-booking-rules. Hierarchical (per
 * docs/react-query-guidelines.md §3): every key starts with `['room-booking-rules']`
 * so a single `invalidateQueries({ queryKey: roomBookingRuleKeys.all })`
 * nukes the module's cache.
 *
 * Saved simulation scenarios live under their own subtree so they can be
 * invalidated independently of rule lists.
 */
export const roomBookingRuleKeys = {
  all: ['room-booking-rules'] as const,

  lists: () => [...roomBookingRuleKeys.all, 'list'] as const,
  list: (filters: RuleListFilters = {}) =>
    [...roomBookingRuleKeys.lists(), filters] as const,

  details: () => [...roomBookingRuleKeys.all, 'detail'] as const,
  detail: (id: string) => [...roomBookingRuleKeys.details(), id] as const,
  versions: (id: string) => [...roomBookingRuleKeys.detail(id), 'versions'] as const,

  templates: () => [...roomBookingRuleKeys.all, 'templates'] as const,

  scenarios: () => [...roomBookingRuleKeys.all, 'scenarios'] as const,
  scenario: (id: string) => [...roomBookingRuleKeys.scenarios(), id] as const,
} as const;
