import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SupabaseService } from '../../common/supabase/supabase.service';
import { TenantContext } from '../../common/tenant-context';
import { AppError, AppErrors, wrapPgError } from '../../common/errors';

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

@Injectable()
export class PersonService {
  constructor(private readonly supabase: SupabaseService) {}

  async search(query: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `id, first_name, last_name, email, type,
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .or(`first_name.ilike.%${query}%,last_name.ilike.%${query}%,email.ilike.%${query}%`)
      .order('first_name')
      .limit(20);

    if (error) {
      throw wrapPgError(error, 'person.search_failed', {
        detail: 'Person search query failed',
      });
    }
    return data;
  }

  async list() {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `*, manager:persons!manager_person_id(id, first_name, last_name),
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code)),
         user:users!person_id(id, email, status)`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name')
      .limit(100);

    if (error) {
      throw wrapPgError(error, 'person.list_failed', {
        detail: 'Person list query failed',
      });
    }
    return data;
  }

  async getById(id: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('persons')
      .select(
        `*, primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .single();

    if (error) {
      throw wrapPgError(error, 'person.lookup_failed', {
        detail: `Person ${id} lookup failed`,
        notFoundCode: 'person.not_found',
      });
    }
    return data;
  }

  /**
   * R1 (handoff-residuals 2026-05-20): real `/api/persons/me` endpoint.
   *
   * Previously a `GET /api/persons/me` request matched the controller's
   * `@Get(':id')` route with `id='me'`, which forwarded `'me'` into
   * `getById()` → Postgres rejected it as an invalid UUID → the
   * `if (error) throw error` (legacy bare rethrow) re-surfaced the raw
   * PostgrestError → the global filter mapped it to
   * `unknown.server_error` 500.
   *
   * This method resolves the caller's own person row via the
   * AuthGuard-attached `request.user.platformUserId` (the auth_uid → users
   * bridge already runs once per request — see `auth/auth.guard.ts:82`),
   * then fetches the `persons` row via a SECOND tenant-scoped query
   * (defense-in-depth against a bad/back-filled `users.person_id` FK
   * pointing at a foreign-tenant `persons` row).
   *
   * Failure paths use AppError factories per the error-handling spec
   * (`docs/superpowers/specs/2026-05-02-error-handling-system-design.md`):
   *   - missing platformUserId        → 500 auth.guard_contract_violation
   *     (AuthGuard's contract was broken — it's a server/config bug, not
   *     a client-credential bug, so 401-then-reauth would loop forever)
   *   - supabase error                → 500 person.lookup_failed
   *   - no users row                  → 404 person.not_found (genuine miss
   *     — AuthGuard already gated on tenant so this is a deletion race)
   *   - users.person_id is NULL OR    → 422 person.no_profile_link
   *     persons fetch returns no row    (user exists, no linked profile
   *     yet — service account / onboarding gap — frontend renders
   *     "your profile isn't linked" not "person 404 — bad URL")
   *
   * R1 tertiary fold (codex P0, 2026-05-20): split the original
   * `from('users').select(... persons:persons!person_id(...))` join into
   * two sequential queries. The `users.person_id → persons(id)` FK at
   * `supabase/migrations/00003_people_users_roles.sql:38` is NOT
   * composite-tenant-scoped, so a bad/back-filled `users.person_id` value
   * (data corruption, migration bug, mis-typed insert) could point at a
   * `persons` row in a DIFFERENT tenant. Because `getMe` uses the
   * service-role admin client, RLS does NOT catch this. The single-join
   * shape relied on RLS catching the cross-tenant leak — under admin
   * client it didn't. The two-query shape catches the leak by re-asserting
   * `tenant_id = current_tenant` on the persons read. This matches the
   * `portal.service.ts:159-175` defense-in-depth pattern: every persons
   * row read is explicitly tenant-checked. Per memory
   * `feedback_tenant_id_ultimate_rule` + `feedback_visibility_gate_lateral`.
   */
  async getMe(request: Request) {
    const platformUserId = (request as { user?: { platformUserId?: string } })
      .user?.platformUserId;
    if (!platformUserId) {
      // R1 tertiary fold FIX B (codex should-fix, 2026-05-20): if AuthGuard
      // ran successfully, platformUserId WILL be set (see auth.guard.ts:82).
      // If it's missing, AuthGuard's contract was broken — that's a
      // server/config bug (guard chain ordering, middleware swap), NOT a
      // client-credential bug. A 401 would tell the client "reauth", the
      // client would reauth, AuthGuard would re-run successfully, and
      // platformUserId would STILL be missing because the bug is
      // server-side → infinite loop. 500 is the honest status.
      throw AppErrors.server('auth.guard_contract_violation', {
        detail: 'AuthGuard did not attach platformUserId — guard chain or middleware ordering broken',
      });
    }

    const tenant = TenantContext.current();

    // Step 1 — resolve users.id → person_id, strictly tenant-scoped.
    // (AuthGuard already enforces this binding, but the explicit
    // `.eq('tenant_id', ...)` here makes the tenant filter local to the
    // call site rather than implicit from an upstream guard. Per memory
    // `feedback_tenant_id_ultimate_rule`.)
    const userRes = await this.supabase.admin
      .from('users')
      .select('id, person_id')
      .eq('id', platformUserId)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (userRes.error) {
      throw AppErrors.server('person.lookup_failed', {
        detail: 'User lookup failed',
        cause: userRes.error,
      });
    }
    if (!userRes.data) {
      // No users row in this tenant for this auth_uid. AuthGuard ALREADY
      // gated on this; if we reach here, the user was deleted between
      // AuthGuard and this call (race), or the binding rotated. Genuinely
      // "not found".
      throw AppErrors.notFound('person');
    }
    if (!userRes.data.person_id) {
      // User exists but no linked person yet (service account,
      // mid-onboarding, manually-inserted row). Distinct from 404 so the
      // frontend can render "your profile isn't linked — contact admin"
      // instead of "person 404 — bad URL".
      throw new AppError('person.no_profile_link', 422, {
        detail: 'User has no linked person record',
      });
    }

    // Step 2 — fetch the persons row with BOTH id AND tenant_id filters.
    // This is the defense against a bad `users.person_id` FK pointing at
    // a `persons` row in a DIFFERENT tenant (the codex P0 finding). If the
    // FK is bad we get `maybeSingle() → null` and surface as
    // `person.no_profile_link` — not a 200 with a foreign person.
    //
    // DTO scrub (R1 plan-review C2, 2026-05-20): the select is an
    // EXPLICIT column allowlist, NOT `*`. Wildcards leaked HR-class
    // columns like `manager_person_id`, `cost_center`, `division`,
    // `department`, `external_source` back to the authenticated user
    // about themselves. The column set here mirrors `portal.service.ts:
    // 162-165` (the canonical "what does the requester see about
    // themselves" set). `org_node_id` is dropped from the membership
    // projection because `org_node.id` carries the same value.
    const personRes = await this.supabase.admin
      .from('persons')
      .select(
        `id, first_name, last_name, email, phone, type, default_location_id, avatar_url, primary_membership:person_org_memberships(is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('id', userRes.data.person_id)
      .eq('tenant_id', tenant.id)
      .maybeSingle();
    if (personRes.error) {
      throw AppErrors.server('person.lookup_failed', {
        detail: 'Person lookup failed',
        cause: personRes.error,
      });
    }
    if (!personRes.data) {
      // Either users.person_id points at a deleted persons row OR — the
      // codex P0 scenario — it points at a persons row in a DIFFERENT
      // tenant. The `.eq('tenant_id', ...)` filter just rejected the bad
      // FK; surface as no_profile_link (422) so the operator log shows
      // "user X has dangling FK / cross-tenant FK" without leaking the
      // foreign tenant's existence.
      throw new AppError('person.no_profile_link', 422, {
        detail: 'User has linked person_id but persons row is missing or in another tenant',
      });
    }
    return personRes.data;
  }

  async create(dto: {
    first_name: string;
    last_name: string;
    email?: string;
    phone?: string;
    type: string;
    cost_center?: string;
    manager_person_id?: string;
    primary_org_node_id?: string | null;
  }) {
    const tenant = TenantContext.current();
    const { primary_org_node_id, ...personFields } = dto;

    const { data, error } = await this.supabase.admin
      .from('persons')
      .insert({ ...personFields, tenant_id: tenant.id })
      .select()
      .single();
    if (error) {
      throw wrapPgError(error, 'person.create_failed', {
        detail: 'Person insert failed',
      });
    }

    if (primary_org_node_id) {
      await this.upsertPrimaryMembership(data.id, primary_org_node_id);
    }
    return data;
  }

  async update(id: string, dto: Record<string, unknown>) {
    const tenant = TenantContext.current();
    const { primary_org_node_id, ...rest } = dto as Record<string, unknown> & {
      primary_org_node_id?: string | null;
    };

    const { data, error } = await this.supabase.admin
      .from('persons')
      .update(rest)
      .eq('id', id)
      .eq('tenant_id', tenant.id)
      .select()
      .single();
    if (error) {
      throw wrapPgError(error, 'person.update_failed', {
        detail: `Person ${id} update failed`,
        notFoundCode: 'person.not_found',
      });
    }

    if (primary_org_node_id !== undefined) {
      if (primary_org_node_id === null) {
        await this.clearPrimaryMembership(id);
      } else {
        await this.upsertPrimaryMembership(id, primary_org_node_id);
      }
    }
    return data;
  }

  async listByType(type?: string) {
    const tenant = TenantContext.current();
    let query = this.supabase.admin
      .from('persons')
      .select(
        `*, manager:persons!manager_person_id(id, first_name, last_name),
         primary_membership:person_org_memberships(org_node_id, is_primary, org_node:org_nodes(id, name, code))`,
      )
      .eq('tenant_id', tenant.id)
      .eq('active', true)
      .order('first_name');

    if (type) query = query.eq('type', type);

    const { data, error } = await query;
    if (error) {
      throw wrapPgError(error, 'person.list_failed', {
        detail: 'Person listByType query failed',
      });
    }
    return data;
  }

  private async upsertPrimaryMembership(personId: string, orgNodeId: string) {
    const tenant = TenantContext.current();
    // Demote any existing primary for this person.
    const { error: demoteErr } = await this.supabase.admin
      .from('person_org_memberships')
      .update({ is_primary: false })
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .eq('is_primary', true);
    if (demoteErr) {
      throw wrapPgError(demoteErr, 'person.membership_update_failed', {
        detail: `Person ${personId} membership demote failed`,
      });
    }

    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .upsert(
        {
          tenant_id: tenant.id,
          person_id: personId,
          org_node_id: orgNodeId,
          is_primary: true,
        },
        { onConflict: 'person_id,org_node_id' },
      );
    if (error) {
      if (isUniqueViolation(error)) {
        throw AppErrors.conflict('person.org_change_in_progress', {
          detail: 'Another organisation change for this person is in progress. Reload and try again.',
        });
      }
      throw wrapPgError(error, 'person.membership_update_failed', {
        detail: `Person ${personId} membership upsert failed`,
      });
    }
  }

  private async clearPrimaryMembership(personId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_org_memberships')
      .delete()
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .eq('is_primary', true);
    if (error) {
      throw wrapPgError(error, 'person.membership_remove_failed', {
        detail: `Person ${personId} primary membership clear failed`,
      });
    }
  }

  // ── Portal-scope slice: location grants ──────────────────────────────────

  async listLocationGrants(personId: string) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_location_grants')
      .select('id, space_id, granted_by_user_id, granted_at, note, space:spaces(id, name, type)')
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id)
      .order('granted_at');
    if (error) {
      throw wrapPgError(error, 'person.location_grant_list_failed', {
        detail: `Person ${personId} location grants list failed`,
      });
    }
    return data;
  }

  async addLocationGrant(
    personId: string,
    dto: { space_id: string; note?: string },
    grantedByUserId?: string,
  ) {
    const tenant = TenantContext.current();
    const { data, error } = await this.supabase.admin
      .from('person_location_grants')
      .insert({
        tenant_id: tenant.id,
        person_id: personId,
        space_id: dto.space_id,
        note: dto.note ?? null,
        granted_by_user_id: grantedByUserId ?? null,
      })
      .select('id, space_id, granted_by_user_id, granted_at, note')
      .single();
    if (error) {
      throw wrapPgError(error, 'person.location_grant_create_failed', {
        detail: `Person ${personId} location grant insert failed`,
      });
    }
    return data;
  }

  async removeLocationGrant(personId: string, grantId: string) {
    const tenant = TenantContext.current();
    const { error } = await this.supabase.admin
      .from('person_location_grants')
      .delete()
      .eq('id', grantId)
      .eq('person_id', personId)
      .eq('tenant_id', tenant.id);
    if (error) {
      throw wrapPgError(error, 'person.location_grant_remove_failed', {
        detail: `Person ${personId} location grant ${grantId} delete failed`,
      });
    }
    return { ok: true };
  }

  /**
   * Effective portal authorization for this person — the union of:
   *  - persons.default_location_id (source: 'default')
   *  - person_location_grants rows (source: 'grant')
   *  - org_node_location_grants walked through person_org_memberships (source: 'org_grant')
   *
   * Mirrors public.portal_authorized_root_matches (migration 00080). Returned
   * rows are enriched with space + grant + org-node names so the admin UI can
   * show why each location is authorized.
   */
  async listEffectiveAuthorization(personId: string) {
    const tenant = TenantContext.current();

    const { data: rows, error: rpcErr } = await this.supabase.admin.rpc(
      'portal_authorized_root_matches',
      { p_person_id: personId, p_tenant_id: tenant.id },
    );
    if (rpcErr) {
      throw wrapPgError(rpcErr, 'person.authorization_load_failed', {
        detail: `Person ${personId} portal_authorized_root_matches RPC failed`,
      });
    }

    const matches = ((rows ?? []) as Array<{ root_id: string; source: string; grant_id: string | null }>);
    if (matches.length === 0) return [];

    const spaceIds = Array.from(new Set(matches.map((m) => m.root_id)));
    const grantIds = matches.filter((m) => m.source === 'grant' && m.grant_id).map((m) => m.grant_id!);
    const orgGrantIds = matches.filter((m) => m.source === 'org_grant' && m.grant_id).map((m) => m.grant_id!);

    const [spacesRes, grantsRes, orgGrantsRes] = await Promise.all([
      this.supabase.admin
        .from('spaces')
        .select('id, name, type')
        .in('id', spaceIds)
        .eq('tenant_id', tenant.id),
      grantIds.length > 0
        ? this.supabase.admin
            .from('person_location_grants')
            .select('id, granted_at, note')
            .in('id', grantIds)
            .eq('tenant_id', tenant.id)
        : Promise.resolve({ data: [], error: null }),
      orgGrantIds.length > 0
        ? this.supabase.admin
            .from('org_node_location_grants')
            .select('id, org_node_id, org_node:org_nodes(id, name)')
            .in('id', orgGrantIds)
            .eq('tenant_id', tenant.id)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const spacesById = new Map(
      ((spacesRes.data ?? []) as Array<{ id: string; name: string; type: string }>).map((s) => [s.id, s]),
    );
    const grantsById = new Map(
      ((grantsRes.data ?? []) as Array<{ id: string; granted_at: string; note: string | null }>).map(
        (g) => [g.id, g],
      ),
    );
    const orgGrantsById = new Map(
      ((orgGrantsRes.data ?? []) as Array<{ id: string; org_node_id: string; org_node: { id: string; name: string } | { id: string; name: string }[] | null }>).map((o) => {
        const node = Array.isArray(o.org_node) ? o.org_node[0] : o.org_node;
        return [o.id, { org_node_id: o.org_node_id, org_node_name: node?.name ?? null }];
      }),
    );

    return matches
      .map((m) => {
        const space = spacesById.get(m.root_id);
        if (!space) return null;
        if (m.source === 'default') {
          return {
            source: 'default' as const,
            space,
            grant_id: null as string | null,
            granted_at: null as string | null,
            note: null as string | null,
            org_node: null as { id: string; name: string } | null,
          };
        }
        if (m.source === 'grant') {
          const g = m.grant_id ? grantsById.get(m.grant_id) : null;
          return {
            source: 'grant' as const,
            space,
            grant_id: m.grant_id,
            granted_at: g?.granted_at ?? null,
            note: g?.note ?? null,
            org_node: null,
          };
        }
        const o = m.grant_id ? orgGrantsById.get(m.grant_id) : null;
        return {
          source: 'org_grant' as const,
          space,
          grant_id: m.grant_id,
          granted_at: null,
          note: null,
          org_node: o?.org_node_name
            ? { id: o.org_node_id, name: o.org_node_name }
            : null,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }
}
