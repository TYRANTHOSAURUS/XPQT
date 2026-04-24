import { queryOptions, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { permissionKeys } from '@/api/permissions';

export type RoleType = 'admin' | 'agent' | 'employee';

export interface Role {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  permissions: string[];
  type: RoleType | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RoleUpsertBody {
  name: string;
  description?: string | null;
  permissions: string[];
  type?: RoleType;
}

export const roleKeys = {
  all: ['roles'] as const,
  lists: () => [...roleKeys.all, 'list'] as const,
  list: () => [...roleKeys.lists(), {}] as const,
  details: () => [...roleKeys.all, 'detail'] as const,
  detail: (id: string) => [...roleKeys.details(), id] as const,
  audits: () => [...roleKeys.all, 'audit'] as const,
  roleAudit: (id: string) => [...roleKeys.audits(), 'role', id] as const,
  userAudit: (id: string) => [...roleKeys.audits(), 'user', id] as const,
} as const;

export interface RoleAuditEvent {
  id: string;
  tenant_id: string;
  actor_user_id: string | null;
  event_type:
    | 'role.created'
    | 'role.updated'
    | 'role.deleted'
    | 'role.permissions_changed'
    | 'assignment.created'
    | 'assignment.updated'
    | 'assignment.revoked';
  target_role_id: string | null;
  target_user_id: string | null;
  target_assignment_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
  actor?: {
    id: string;
    email: string | null;
    person: { id: string; first_name: string; last_name: string } | null;
  } | null;
}

export function rolesListOptions() {
  return queryOptions({
    queryKey: roleKeys.list(),
    queryFn: ({ signal }) => apiFetch<Role[]>('/roles', { signal }),
    staleTime: 60_000,
  });
}

export function useRoles() {
  return useQuery(rolesListOptions());
}

export function roleOptions(id: string | undefined) {
  return queryOptions({
    queryKey: roleKeys.detail(id ?? ''),
    queryFn: async ({ signal }) => {
      // /roles returns the full list; no GET by id exists. Fetch list and
      // pick. Cheap because staleTime covers both keys.
      const list = await apiFetch<Role[]>('/roles', { signal });
      return list.find((r) => r.id === id) ?? null;
    },
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useRole(id: string | undefined) {
  return useQuery(roleOptions(id));
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation<Role, Error, RoleUpsertBody>({
    mutationFn: (body) =>
      apiFetch<Role>('/roles', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: roleKeys.lists() });
      // A new role can't yet affect effective-permissions (it has no
      // assignments), so no per-user invalidation.
    },
  });
}

export function roleAuditOptions(roleId: string | undefined) {
  return queryOptions({
    queryKey: roleKeys.roleAudit(roleId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<RoleAuditEvent[]>(`/roles/${roleId}/audit`, { signal }),
    enabled: Boolean(roleId),
    staleTime: 10_000,
  });
}

export function useRoleAudit(roleId: string | undefined) {
  return useQuery(roleAuditOptions(roleId));
}

export function userAuditOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: roleKeys.userAudit(userId ?? ''),
    queryFn: ({ signal }) =>
      apiFetch<RoleAuditEvent[]>(`/users/${userId}/audit`, { signal }),
    enabled: Boolean(userId),
    staleTime: 10_000,
  });
}

export function useUserAudit(userId: string | undefined) {
  return useQuery(userAuditOptions(userId));
}

export function useUpdateRole(id: string) {
  const qc = useQueryClient();
  return useMutation<Role, Error, Partial<RoleUpsertBody>>({
    mutationFn: (body) =>
      apiFetch<Role>(`/roles/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: (role) => {
      qc.invalidateQueries({ queryKey: roleKeys.lists() });
      qc.setQueryData(roleKeys.detail(id), role);
      // Any user carrying this role now has a different effective-permissions
      // set. Invalidate the whole 'effective' namespace — cheap, and we can't
      // know locally which users hold the role.
      qc.invalidateQueries({ queryKey: [...permissionKeys.all, 'effective'] });
    },
  });
}
