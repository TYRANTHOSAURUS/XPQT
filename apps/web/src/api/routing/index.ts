import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch, type ApiFetchOptions } from '@/lib/api';

/**
 * Routing-studio module. Covers the entire routing namespace:
 * - routing_rules (conditional overrides)
 * - location_teams (matrix of team/vendor per space × domain)
 * - space_groups
 * - domains (v2 registry)
 * - domain_parents (legacy fallback chain)
 * - routing_decisions (audit log)
 * - coverage (resolve-coverage function)
 * - simulator (POST /routing/preview)
 * - case ownership / child dispatch v2 policies
 *
 * Mutations use a generic invalidate-whole-namespace strategy. Routing state
 * is small and highly interdependent — changing a rule can affect decisions,
 * coverage, simulator output. Over-invalidation is cheaper than subtle drift.
 */

// ---------- Keys ----------

export const routingKeys = {
  all: ['routing'] as const,

  rules: () => [...routingKeys.all, 'rules'] as const,
  rulesList: (filters?: Record<string, unknown>) =>
    [...routingKeys.rules(), 'list', filters ?? {}] as const,

  locationTeams: () => [...routingKeys.all, 'location-teams'] as const,
  locationTeamsList: () => [...routingKeys.locationTeams(), 'list'] as const,

  spaceGroups: () => [...routingKeys.all, 'space-groups'] as const,
  spaceGroupsList: () => [...routingKeys.spaceGroups(), 'list'] as const,
  spaceGroupMembers: (groupId: string) =>
    [...routingKeys.spaceGroups(), 'members', groupId] as const,

  domainRegistry: () => [...routingKeys.all, 'domains'] as const,
  domainRegistryList: () => [...routingKeys.domainRegistry(), 'list'] as const,

  domainParents: () => [...routingKeys.all, 'domain-parents'] as const,
  domainParentsList: () => [...routingKeys.domainParents(), 'list'] as const,

  decisions: () => [...routingKeys.all, 'decisions'] as const,
  decisionsList: (filters?: Record<string, unknown>) =>
    [...routingKeys.decisions(), 'list', filters ?? {}] as const,

  coverage: () => [...routingKeys.all, 'coverage'] as const,
  coverageFor: (filters: Record<string, unknown>) =>
    [...routingKeys.coverage(), filters] as const,

  simulator: () => [...routingKeys.all, 'simulator'] as const,
  simulate: (input: Record<string, unknown>) => [...routingKeys.simulator(), input] as const,

  policies: () => [...routingKeys.all, 'policies'] as const,
  policy: (id: string) => [...routingKeys.policies(), id] as const,

  mode: () => [...routingKeys.all, 'mode'] as const,
} as const;

// ---------- Shared types ----------

export interface RoutingRule {
  id: string;
  name: string;
  priority: number;
  active: boolean;
  conditions: Record<string, unknown>;
  target: Record<string, unknown>;
  domain?: string | null;
  request_type_id?: string | null;
}

export interface LocationTeam {
  id: string;
  domain: string;
  space_id: string | null;
  space_group_id: string | null;
  team_id: string | null;
  vendor_id: string | null;
}

export interface SpaceGroup {
  id: string;
  name: string;
  description?: string | null;
}

export interface SpaceGroupMember {
  group_id: string;
  space_id: string;
}

export interface DomainRegistryEntry {
  domain: string;
  label: string;
  description?: string | null;
  is_system?: boolean;
  active: boolean;
}

export interface DomainParent {
  domain: string;
  parent_domain: string;
}

export interface RoutingDecision {
  id: string;
  ticket_id: string;
  strategy: string;
  chosen_team_id: string | null;
  chosen_vendor_id: string | null;
  trace: unknown;
  created_at: string;
}

// ---------- Generic mutation helper ----------

/**
 * Generic mutation that invalidates the whole routing namespace on settle.
 * Use for any write against a /routing/* endpoint when per-key targeting
 * isn't worth the extra code.
 */
export function useRoutingMutation<TVars = unknown, TData = unknown>(
  fn: (vars: TVars) => Promise<TData>,
) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars>({
    mutationFn: fn,
    onSettled: () => qc.invalidateQueries({ queryKey: routingKeys.all }),
  });
}

// ---------- routing_rules ----------

// Endpoint paths (centralized so a rename only happens in one place).
const PATHS = {
  rules: '/routing-rules',
  locationTeams: '/location-teams',
  spaceGroups: '/space-groups',
  domainParents: '/domain-parents',
  domainRegistry: '/admin/routing/domains',
  decisions: '/routing/decisions',
  studioDecisions: '/routing/studio/decisions',
  studioDualRunLogs: '/routing/studio/dualrun-logs',
  studioCoverage: '/routing/studio/coverage',
  studioCoverageCell: '/routing/studio/coverage/cell',
  studioSimulate: '/routing/studio/simulate',
  studioMode: '/routing/studio/mode',
  policiesCaseOwner: '/admin/routing/policies/case_owner_policy',
  policiesChildDispatch: '/admin/routing/policies/child_dispatch_policy',
  policyVersions: '/admin/routing/policies/versions',
} as const;

// ---------- routing_rules ----------

export function routingRulesListOptions(filters?: Record<string, unknown>) {
  return queryOptions({
    queryKey: routingKeys.rulesList(filters),
    queryFn: ({ signal }) =>
      apiFetch<RoutingRule[]>(PATHS.rules, { signal, query: filters as ApiFetchOptions['query'] }),
    staleTime: 30_000,
  });
}
export function useRoutingRules(filters?: Record<string, unknown>) {
  return useQuery(routingRulesListOptions(filters));
}

// ---------- location_teams ----------

export function locationTeamsListOptions() {
  return queryOptions({
    queryKey: routingKeys.locationTeamsList(),
    queryFn: ({ signal }) => apiFetch<LocationTeam[]>(PATHS.locationTeams, { signal }),
    staleTime: 30_000,
  });
}
export function useLocationTeams() {
  return useQuery(locationTeamsListOptions());
}

// ---------- space_groups ----------

export function spaceGroupsListOptions() {
  return queryOptions({
    queryKey: routingKeys.spaceGroupsList(),
    queryFn: ({ signal }) => apiFetch<SpaceGroup[]>(PATHS.spaceGroups, { signal }),
    staleTime: 60_000,
  });
}
export function useSpaceGroups() {
  return useQuery(spaceGroupsListOptions());
}

export function spaceGroupMembersOptions(groupId: string | null | undefined) {
  return queryOptions({
    queryKey: routingKeys.spaceGroupMembers(groupId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<SpaceGroupMember[]>(`${PATHS.spaceGroups}/${groupId}/members`, { signal }),
    enabled: Boolean(groupId),
    staleTime: 60_000,
  });
}
export function useSpaceGroupMembers(groupId: string | null | undefined) {
  return useQuery(spaceGroupMembersOptions(groupId));
}

// ---------- domain registry (v2) ----------

export function domainRegistryListOptions() {
  return queryOptions({
    queryKey: routingKeys.domainRegistryList(),
    queryFn: ({ signal }) => apiFetch<DomainRegistryEntry[]>(PATHS.domainRegistry, { signal }),
    staleTime: 5 * 60_000, // admin-edited, rarely.
  });
}
export function useDomainRegistry() {
  return useQuery(domainRegistryListOptions());
}

// ---------- domain parents (legacy) ----------

export function domainParentsListOptions() {
  return queryOptions({
    queryKey: routingKeys.domainParentsList(),
    queryFn: ({ signal }) => apiFetch<DomainParent[]>(PATHS.domainParents, { signal }),
    staleTime: 5 * 60_000,
  });
}
export function useDomainParents() {
  return useQuery(domainParentsListOptions());
}

// ---------- decisions (audit log) ----------

export function routingStudioDecisionsOptions<T = { rows: RoutingDecision[]; total: number }>(
  filters: Record<string, unknown> = {},
) {
  return queryOptions({
    queryKey: [...routingKeys.decisionsList(filters), 'studio'] as const,
    queryFn: ({ signal }) =>
      apiFetch<T>(PATHS.studioDecisions, { signal, query: filters as ApiFetchOptions['query'] }),
    staleTime: 10_000,
  });
}
export function useRoutingStudioDecisions<T = { rows: RoutingDecision[]; total: number }>(
  filters: Record<string, unknown> = {},
) {
  return useQuery(routingStudioDecisionsOptions<T>(filters));
}

/** Dual-run comparison logs (v1 vs v2) for the audit tab. */
export function routingDualRunLogsOptions<T>(filters: Record<string, unknown> = {}) {
  return queryOptions({
    queryKey: [...routingKeys.all, 'dualrun-logs', filters] as const,
    queryFn: ({ signal }) =>
      apiFetch<T>(PATHS.studioDualRunLogs, { signal, query: filters as ApiFetchOptions['query'] }),
    staleTime: 10_000,
  });
}
export function useRoutingDualRunLogs<T>(filters: Record<string, unknown> = {}) {
  return useQuery(routingDualRunLogsOptions<T>(filters));
}

// ---------- coverage ----------

export function coverageOptions<T = unknown>(filters: Record<string, unknown> = {}) {
  return queryOptions({
    queryKey: routingKeys.coverageFor(filters),
    queryFn: ({ signal }) =>
      apiFetch<T>(PATHS.studioCoverage, { signal, query: filters as ApiFetchOptions['query'] }),
    staleTime: 30_000,
  });
}
export function useCoverage<T = unknown>(filters: Record<string, unknown> = {}) {
  return useQuery(coverageOptions<T>(filters));
}

// ---------- simulator (POST) ----------

export function simulatorPreviewOptions<T = unknown>(input: Record<string, unknown>) {
  return queryOptions({
    queryKey: routingKeys.simulate(input),
    queryFn: ({ signal }) =>
      apiFetch<T>(PATHS.studioSimulate, {
        signal,
        method: 'POST',
        body: JSON.stringify(input),
      }),
    enabled: Object.keys(input).length > 0,
    staleTime: 10_000,
  });
}
export function useSimulatorPreview<T = unknown>(input: Record<string, unknown>) {
  return useQuery(simulatorPreviewOptions<T>(input));
}

// ---------- policies (v2 case ownership + child dispatch) ----------

function policyKindPath(kind: 'case-owner' | 'child-dispatch') {
  return kind === 'case-owner' ? PATHS.policiesCaseOwner : PATHS.policiesChildDispatch;
}

export function policyEntitiesOptions<T = unknown>(kind: 'case-owner' | 'child-dispatch') {
  return queryOptions({
    queryKey: [...routingKeys.policies(), 'entities', kind] as const,
    queryFn: ({ signal }) => apiFetch<T[]>(policyKindPath(kind), { signal }),
    staleTime: 60_000,
  });
}
export function usePolicyEntities<T = unknown>(kind: 'case-owner' | 'child-dispatch') {
  return useQuery(policyEntitiesOptions<T>(kind));
}

export function publishedPolicyOptions<T = unknown>(
  kind: 'case-owner' | 'child-dispatch',
  entityId: string | null | undefined,
) {
  return queryOptions({
    queryKey: [...routingKeys.policies(), 'published', kind, entityId ?? ''] as const,
    queryFn: ({ signal }) => apiFetch<T>(`${policyKindPath(kind)}/${entityId}`, { signal }),
    enabled: Boolean(entityId),
    staleTime: 60_000,
  });
}
export function usePublishedPolicy<T = unknown>(
  kind: 'case-owner' | 'child-dispatch',
  entityId: string | null | undefined,
) {
  return useQuery(publishedPolicyOptions<T>(kind, entityId));
}

// ---------- routing mode (v1/v2 flag) ----------

export interface RoutingModeResponse {
  mode: 'legacy' | 'v2' | 'dual' | 'off';
}
export function routingModeOptions() {
  return queryOptions({
    queryKey: routingKeys.mode(),
    queryFn: ({ signal }) => apiFetch<RoutingModeResponse>(PATHS.studioMode, { signal }),
    staleTime: 5 * 60_000,
  });
}
export function useRoutingMode() {
  return useQuery(routingModeOptions());
}

export { PATHS as routingPaths };
