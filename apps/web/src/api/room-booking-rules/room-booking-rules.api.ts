import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { roomBookingRuleKeys } from './keys';
import type {
  CreateRulePayload,
  FromTemplatePayload,
  ImpactPreviewDraftPayload,
  ImpactPreviewResult,
  RoomBookingRule,
  RuleListFilters,
  RuleTemplate,
  RuleVersion,
  SaveScenarioPayload,
  SimulatePayload,
  SimulationResult,
  SimulationScenario,
  UpdateRulePayload,
} from './types';

/**
 * React Query options + hooks for room-booking-rules. Phase F's admin pages
 * (index + detail + template editor dialog) consume this layer; the data
 * shapes here intentionally mirror the API DTOs one-for-one so admin UI work
 * stays mechanical.
 *
 * Mutation invalidation pattern:
 *   - create / from-template / delete  → invalidate `lists()`
 *   - update                            → invalidate `lists()` + setQueryData on detail
 *   - restoreVersion                    → invalidate `lists()` + detail + versions
 *   - createScenario                    → invalidate `scenarios()`
 */

// ── Rules ─────────────────────────────────────────────────────────────

function buildRulesQuery(filters: RuleListFilters): Record<string, string> {
  const out: Record<string, string> = {};
  if (filters.target_scope) out.target_scope = filters.target_scope;
  if (filters.target_id) out.target_id = filters.target_id;
  if (filters.active !== undefined) out.active = String(filters.active);
  if (filters.effect) out.effect = filters.effect;
  return out;
}

export function roomBookingRulesListOptions(filters: RuleListFilters = {}) {
  return queryOptions({
    queryKey: roomBookingRuleKeys.list(filters),
    queryFn: ({ signal }) =>
      apiFetch<RoomBookingRule[]>('/room-booking-rules', {
        signal,
        query: buildRulesQuery(filters),
      }),
    staleTime: 60_000,
  });
}

export function useRoomBookingRules(filters: RuleListFilters = {}) {
  return useQuery(roomBookingRulesListOptions(filters));
}

export function roomBookingRuleDetailOptions(id: string | undefined) {
  return queryOptions({
    queryKey: roomBookingRuleKeys.detail(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<RoomBookingRule>(`/room-booking-rules/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useRoomBookingRule(id: string | undefined) {
  return useQuery(roomBookingRuleDetailOptions(id));
}

export function roomBookingRuleVersionsOptions(id: string | undefined) {
  return queryOptions({
    queryKey: roomBookingRuleKeys.versions(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<RuleVersion[]>(`/room-booking-rules/${id}/versions`, { signal }),
    enabled: Boolean(id),
    staleTime: 30_000,
  });
}

export function useRoomBookingRuleVersions(id: string | undefined) {
  return useQuery(roomBookingRuleVersionsOptions(id));
}

export function useCreateRoomBookingRule() {
  const qc = useQueryClient();
  return useMutation<RoomBookingRule, Error, CreateRulePayload>({
    mutationFn: (body) =>
      apiFetch<RoomBookingRule>('/room-booking-rules', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.lists() });
    },
  });
}

export function useUpdateRoomBookingRule(id: string) {
  const qc = useQueryClient();
  return useMutation<RoomBookingRule, Error, UpdateRulePayload>({
    mutationFn: (body) =>
      apiFetch<RoomBookingRule>(`/room-booking-rules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (rule) => {
      qc.setQueryData(roomBookingRuleKeys.detail(id), rule);
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.versions(id) });
    },
  });
}

export function useDeleteRoomBookingRule() {
  const qc = useQueryClient();
  return useMutation<RoomBookingRule, Error, string>({
    mutationFn: (id) =>
      apiFetch<RoomBookingRule>(`/room-booking-rules/${id}`, { method: 'DELETE' }),
    onSuccess: (rule, id) => {
      qc.setQueryData(roomBookingRuleKeys.detail(id), rule);
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.lists() });
    },
  });
}

export function useCreateRuleFromTemplate() {
  const qc = useQueryClient();
  return useMutation<RoomBookingRule, Error, FromTemplatePayload>({
    mutationFn: (body) =>
      apiFetch<RoomBookingRule>('/room-booking-rules/from-template', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roomBookingRuleKeys.lists() }),
  });
}

export function useRestoreRoomBookingRuleVersion(id: string) {
  const qc = useQueryClient();
  return useMutation<RoomBookingRule, Error, number>({
    mutationFn: (version_number) =>
      apiFetch<RoomBookingRule>(`/room-booking-rules/${id}/restore-version`, {
        method: 'POST',
        body: JSON.stringify({ version_number }),
      }),
    onSuccess: (rule) => {
      qc.setQueryData(roomBookingRuleKeys.detail(id), rule);
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.lists() });
      qc.invalidateQueries({ queryKey: roomBookingRuleKeys.versions(id) });
    },
  });
}

// ── Templates ─────────────────────────────────────────────────────────

export function roomBookingRuleTemplatesOptions() {
  return queryOptions({
    queryKey: roomBookingRuleKeys.templates(),
    queryFn: ({ signal }) =>
      apiFetch<RuleTemplate[]>('/room-booking-rules/templates', { signal }),
    // Templates are static for the lifetime of the API process; cache hard.
    staleTime: 5 * 60_000,
  });
}

export function useRoomBookingRuleTemplates() {
  return useQuery(roomBookingRuleTemplatesOptions());
}

// ── Simulation ────────────────────────────────────────────────────────

export function useSimulateRoomBookingRule() {
  return useMutation<SimulationResult, Error, SimulatePayload>({
    mutationFn: (body) =>
      apiFetch<SimulationResult>('/room-booking-rules/simulate', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ── Impact preview ────────────────────────────────────────────────────

export function useRoomBookingRuleImpactPreview() {
  return useMutation<ImpactPreviewResult, Error, string>({
    mutationFn: (id) =>
      apiFetch<ImpactPreviewResult>(`/room-booking-rules/${id}/impact-preview`, {
        method: 'POST',
      }),
  });
}

export function useRoomBookingRuleImpactPreviewDraft() {
  return useMutation<ImpactPreviewResult, Error, ImpactPreviewDraftPayload>({
    mutationFn: (body) =>
      apiFetch<ImpactPreviewResult>('/room-booking-rules/impact-preview/draft', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  });
}

// ── Saved scenarios ───────────────────────────────────────────────────

export function roomBookingScenariosOptions() {
  return queryOptions({
    queryKey: roomBookingRuleKeys.scenarios(),
    queryFn: ({ signal }) =>
      apiFetch<SimulationScenario[]>('/room-booking-simulation-scenarios', { signal }),
    staleTime: 60_000,
  });
}

export function useRoomBookingScenarios() {
  return useQuery(roomBookingScenariosOptions());
}

export function useCreateRoomBookingScenario() {
  const qc = useQueryClient();
  return useMutation<SimulationScenario, Error, SaveScenarioPayload>({
    mutationFn: (body) =>
      apiFetch<SimulationScenario>('/room-booking-simulation-scenarios', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roomBookingRuleKeys.scenarios() }),
  });
}

export function useRunRoomBookingScenario() {
  const qc = useQueryClient();
  return useMutation<SimulationResult, Error, string>({
    mutationFn: (id) =>
      apiFetch<SimulationResult>(`/room-booking-simulation-scenarios/${id}/run`, {
        method: 'POST',
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: roomBookingRuleKeys.scenarios() }),
  });
}
