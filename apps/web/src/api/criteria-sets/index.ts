import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';

export type CriteriaAttr =
  | 'type'
  | 'cost_center'
  | 'manager_person_id'
  | 'org_node_id'
  | 'org_node_code'
  | 'org_node_name';

export type ScalarOp = 'eq' | 'neq';
export type ListOp = 'in' | 'not_in';
export type CriteriaOp = ScalarOp | ListOp;

/**
 * Scalar leaf: `{ attr, op: 'eq' | 'neq', value }`. The plpgsql evaluator
 * reads `p_node->>'value'`, so the key is `value` (singular).
 */
export interface CriteriaScalarLeaf {
  attr: CriteriaAttr;
  op: ScalarOp;
  value: string;
}

/**
 * List leaf: `{ attr, op: 'in' | 'not_in', values: [...] }`. The plpgsql
 * evaluator reads `p_node->'values'`, so the key is `values` (plural).
 */
export interface CriteriaListLeaf {
  attr: CriteriaAttr;
  op: ListOp;
  values: string[];
}

export type CriteriaLeaf = CriteriaScalarLeaf | CriteriaListLeaf;

export type CriteriaNode =
  | CriteriaLeaf
  | { all_of: CriteriaNode[] }
  | { any_of: CriteriaNode[] }
  | { not: CriteriaNode };

export interface CriteriaSet {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  expression: CriteriaNode;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CriteriaSetUpsertBody {
  name: string;
  description?: string | null;
  expression: CriteriaNode;
  active?: boolean;
}

export interface CriteriaMatchRow {
  id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  type: string | null;
  primary_org: { id: string; code: string | null; name: string | null } | null;
}

export interface CriteriaPreviewResult {
  count: number;
  sample: CriteriaMatchRow[];
}

export interface CriteriaMatchesResult {
  criteriaSet: { id: string; name: string; description: string | null };
  count: number;
  matches: CriteriaMatchRow[];
}

export const criteriaSetKeys = {
  all: ['criteria-sets'] as const,
  lists: () => [...criteriaSetKeys.all, 'list'] as const,
  list: () => [...criteriaSetKeys.lists(), {}] as const,
  details: () => [...criteriaSetKeys.all, 'detail'] as const,
  detail: (id: string) => [...criteriaSetKeys.details(), id] as const,
  matches: (id: string) => [...criteriaSetKeys.all, 'matches', id] as const,
} as const;

export function criteriaSetsListOptions() {
  return queryOptions({
    queryKey: criteriaSetKeys.list(),
    queryFn: ({ signal }) => apiFetch<CriteriaSet[]>('/criteria-sets', { signal }),
    staleTime: 60_000,
  });
}

export function useCriteriaSets() {
  return useQuery(criteriaSetsListOptions());
}

export function criteriaSetOptions(id: string | undefined) {
  return queryOptions({
    queryKey: criteriaSetKeys.detail(id ?? ''),
    queryFn: ({ signal }) => apiFetch<CriteriaSet>(`/criteria-sets/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useCriteriaSet(id: string | undefined) {
  return useQuery(criteriaSetOptions(id));
}

export function useCreateCriteriaSet() {
  const qc = useQueryClient();
  return useMutation<CriteriaSet, Error, CriteriaSetUpsertBody>({
    mutationFn: (body) =>
      apiFetch<CriteriaSet>('/criteria-sets', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: criteriaSetKeys.lists() }),
  });
}

export function useUpdateCriteriaSet(id: string) {
  const qc = useQueryClient();
  return useMutation<CriteriaSet, Error, Partial<CriteriaSetUpsertBody>>({
    mutationFn: (body) =>
      apiFetch<CriteriaSet>(`/criteria-sets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      }),
    onSuccess: (cs) => {
      qc.invalidateQueries({ queryKey: criteriaSetKeys.lists() });
      qc.setQueryData(criteriaSetKeys.detail(id), cs);
    },
  });
}

export function useDeleteCriteriaSet() {
  const qc = useQueryClient();
  return useMutation<CriteriaSet, Error, string>({
    mutationFn: (id) => apiFetch<CriteriaSet>(`/criteria-sets/${id}`, { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: criteriaSetKeys.lists() }),
  });
}

export function usePreviewCriteriaExpression(limit = 10) {
  return useMutation<CriteriaPreviewResult, Error, CriteriaNode>({
    mutationFn: (expression) =>
      apiFetch<CriteriaPreviewResult>('/criteria-sets/preview', {
        method: 'POST',
        body: JSON.stringify({ expression, limit }),
      }),
  });
}

export function criteriaSetMatchesOptions(id: string | undefined) {
  return queryOptions({
    queryKey: criteriaSetKeys.matches(id ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<CriteriaMatchesResult>(`/criteria-sets/${id}/matches`, { signal }),
    enabled: Boolean(id),
    staleTime: 15_000,
  });
}

export function useCriteriaSetMatches(id: string | undefined) {
  return useQuery(criteriaSetMatchesOptions(id));
}
