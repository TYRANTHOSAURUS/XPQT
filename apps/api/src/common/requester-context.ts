import { NotFoundException } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';
import { TenantContext } from './tenant-context';

/**
 * Shared requester profile used by predicate engines (room rules + service
 * rules). Three call sites used to copy-paste this loader; consolidate so a
 * schema change to persons / memberships / users propagates in one place.
 */
export interface RequesterContext {
  id: string;
  type: string | null;
  cost_center: string | null;
  org_node_id: string | null;
  role_ids: string[];
  user_id: string | null;
}

export async function loadRequesterContext(
  supabase: SupabaseService,
  personId: string,
): Promise<RequesterContext> {
  const tenantId = TenantContext.current().id;
  const [
    { data: person, error: pErr },
    { data: membership, error: mErr },
    { data: user, error: uErr },
  ] = await Promise.all([
    supabase.admin
      .from('persons')
      .select('id, type, cost_center')
      .eq('id', personId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
    supabase.admin
      .from('person_org_memberships')
      .select('org_node_id')
      .eq('person_id', personId)
      .eq('tenant_id', tenantId)
      .eq('is_primary', true)
      .maybeSingle(),
    supabase.admin
      .from('users')
      .select('id')
      .eq('person_id', personId)
      .eq('tenant_id', tenantId)
      .maybeSingle(),
  ]);
  if (pErr) throw pErr;
  if (mErr) throw mErr;
  if (uErr) throw uErr;
  if (!person) throw new NotFoundException(`Person ${personId} not found`);
  const userId = (user as { id: string } | null)?.id ?? null;

  let roleIds: string[] = [];
  if (userId) {
    const { data: roles, error: rErr } = await supabase.admin
      .from('user_role_assignments')
      .select('role_id')
      .eq('user_id', userId)
      .eq('tenant_id', tenantId)
      .eq('active', true);
    if (rErr) throw rErr;
    roleIds = ((roles ?? []) as Array<{ role_id: string }>).map((r) => r.role_id);
  }

  return {
    id: personId,
    type: (person as { type: string | null }).type ?? null,
    cost_center: (person as { cost_center: string | null }).cost_center ?? null,
    org_node_id: (membership as { org_node_id: string } | null)?.org_node_id ?? null,
    role_ids: roleIds,
    user_id: userId,
  };
}

/**
 * Materialise the permissions referenced by both room-booking and service
 * rule templates. Today: `rooms.override_rules`, `rooms.book_on_behalf`.
 * Add to `PERMS` here when a template grows a new `has_permission` check —
 * the predicate engine reads from this map at evaluation time.
 */
export async function loadPermissionMap(
  supabase: SupabaseService,
  userId: string | null,
): Promise<Record<string, boolean>> {
  if (!userId) return {};
  const tenantId = TenantContext.current().id;
  const result: Record<string, boolean> = {};
  await Promise.all(
    PERMS.map(async (perm) => {
      const { data, error } = await supabase.admin.rpc('user_has_permission', {
        p_user_id: userId,
        p_tenant_id: tenantId,
        p_permission: perm,
      });
      if (error) throw error;
      result[perm] = Boolean(data);
    }),
  );
  return result;
}

const PERMS = ['rooms.override_rules', 'rooms.book_on_behalf'] as const;
