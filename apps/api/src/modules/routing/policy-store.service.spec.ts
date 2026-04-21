import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PolicyStoreService } from './policy-store.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const ENTITY = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const VERSION = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const RT = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const TEAM = 'e5f6a7b8-c9d0-4e1f-9012-3456789abcde';

type AnyTable = Record<string, any>;

function buildSupabase(tables: Record<string, AnyTable[]>) {
  const inserts: Record<string, AnyTable[]> = {};
  const updates: Record<string, AnyTable[]> = {};

  function applyFilters(rows: AnyTable[], filters: Array<[string, any]>): AnyTable[] {
    return rows.filter((r) => filters.every(([k, v]) => r[k] === v));
  }

  function from(table: string) {
    const rows = tables[table] ?? [];
    inserts[table] ??= [];
    updates[table] ??= [];

    const qb: any = {
      _filters: [] as Array<[string, any]>,
      _order: null as { col: string; asc: boolean } | null,
      _limit: null as number | null,

      select() { return qb; },
      insert(payload: AnyTable) {
        const row = { id: crypto.randomUUID(), ...payload };
        inserts[table].push(row);
        rows.push(row);
        qb._pendingInsertRow = row;
        return qb;
      },
      update(patch: AnyTable) {
        qb._pendingUpdatePatch = patch;
        return qb;
      },
      eq(col: string, val: any) {
        qb._filters.push([col, val]);
        return qb;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        qb._order = { col, asc: opts?.ascending ?? true };
        return qb;
      },
      limit(n: number) {
        qb._limit = n;
        return qb;
      },
      async single() {
        if (qb._pendingInsertRow) return { data: qb._pendingInsertRow, error: null };
        if (qb._pendingUpdatePatch) {
          const filtered = applyFilters(rows, qb._filters);
          for (const r of filtered) Object.assign(r, qb._pendingUpdatePatch);
          updates[table].push({ filters: qb._filters, patch: qb._pendingUpdatePatch });
          return { data: filtered[0] ?? null, error: null };
        }
        const filtered = applyFilters(rows, qb._filters);
        return { data: filtered[0] ?? null, error: filtered.length ? null : null };
      },
      async maybeSingle() {
        if (qb._pendingUpdatePatch) {
          const filtered = applyFilters(rows, qb._filters);
          for (const r of filtered) Object.assign(r, qb._pendingUpdatePatch);
          updates[table].push({ filters: qb._filters, patch: qb._pendingUpdatePatch });
          return { data: filtered[0] ?? null, error: null };
        }
        let filtered = applyFilters(rows, qb._filters);
        if (qb._order) {
          filtered = [...filtered].sort((a, b) => {
            const d = (a[qb._order!.col] ?? 0) - (b[qb._order!.col] ?? 0);
            return qb._order!.asc ? d : -d;
          });
        }
        if (qb._limit != null) filtered = filtered.slice(0, qb._limit);
        return { data: filtered[0] ?? null, error: null };
      },
      then(resolve: any) {
        // Terminal promise for .update().eq() chains without .single()/.maybeSingle()
        if (qb._pendingUpdatePatch) {
          const filtered = applyFilters(rows, qb._filters);
          for (const r of filtered) Object.assign(r, qb._pendingUpdatePatch);
          updates[table].push({ filters: qb._filters, patch: qb._pendingUpdatePatch });
          resolve({ data: null, error: null });
          return;
        }
        resolve({ data: applyFilters(rows, qb._filters), error: null });
      },
    };
    return qb;
  }

  return { admin: { from }, _inserts: inserts, _updates: updates, _tables: tables };
}

function validCaseOwnerDef() {
  return {
    schema_version: 1,
    request_type_id: RT,
    scope_source: 'requester_home' as const,
    rows: [],
    default_target: { kind: 'team' as const, team_id: TEAM },
  };
}

describe('PolicyStoreService', () => {
  it('createEntity inserts a routing-studio config type', async () => {
    const sb = buildSupabase({ config_entities: [] });
    const svc = new PolicyStoreService(sb as any);

    const entity = await svc.createEntity({
      tenant_id: TENANT,
      config_type: 'case_owner_policy',
      slug: 'amsterdam-it',
      display_name: 'IT Service Desk Amsterdam',
    });

    expect(entity.config_type).toBe('case_owner_policy');
    expect(entity.slug).toBe('amsterdam-it');
    expect(sb._inserts.config_entities).toHaveLength(1);
  });

  it('createEntity rejects a non-routing config type (defense in depth)', async () => {
    const sb = buildSupabase({ config_entities: [] });
    const svc = new PolicyStoreService(sb as any);

    await expect(
      svc.createEntity({
        tenant_id: TENANT,
        config_type: 'workflow' as any,
        slug: 'x',
        display_name: 'x',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('createDraftVersion validates the payload and assigns the next version number', async () => {
    const sb = buildSupabase({
      config_entities: [
        {
          id: ENTITY,
          tenant_id: TENANT,
          config_type: 'case_owner_policy',
          slug: 'x',
          display_name: 'x',
          current_published_version_id: null,
          status: 'active',
        },
      ],
      config_versions: [
        { id: 'v0', config_entity_id: ENTITY, tenant_id: TENANT, version_number: 1, status: 'archived', definition: {} },
        { id: 'v1', config_entity_id: ENTITY, tenant_id: TENANT, version_number: 2, status: 'published', definition: {} },
      ],
    });
    const svc = new PolicyStoreService(sb as any);

    const version = await svc.createDraftVersion({
      tenant_id: TENANT,
      entity_id: ENTITY,
      definition: validCaseOwnerDef(),
    });

    expect(version.version_number).toBe(3);
    expect(version.status).toBe('draft');
  });

  it('createDraftVersion rejects malformed payload before touching DB', async () => {
    const sb = buildSupabase({
      config_entities: [
        {
          id: ENTITY,
          tenant_id: TENANT,
          config_type: 'case_owner_policy',
          slug: 'x',
          display_name: 'x',
          current_published_version_id: null,
          status: 'active',
        },
      ],
      config_versions: [],
    });
    const svc = new PolicyStoreService(sb as any);

    await expect(
      svc.createDraftVersion({
        tenant_id: TENANT,
        entity_id: ENTITY,
        definition: { schema_version: 99 }, // wildly wrong
      }),
    ).rejects.toThrow(BadRequestException);

    expect(sb._inserts.config_versions ?? []).toHaveLength(0);
  });

  it('publishVersion transitions draft → published and points the entity at it', async () => {
    const sb = buildSupabase({
      config_entities: [
        {
          id: ENTITY,
          tenant_id: TENANT,
          config_type: 'case_owner_policy',
          slug: 'x',
          display_name: 'x',
          current_published_version_id: null,
          status: 'active',
        },
      ],
      config_versions: [
        {
          id: VERSION,
          config_entity_id: ENTITY,
          tenant_id: TENANT,
          version_number: 1,
          status: 'draft',
          definition: validCaseOwnerDef(),
        },
      ],
    });
    const svc = new PolicyStoreService(sb as any);

    await svc.publishVersion({ tenant_id: TENANT, version_id: VERSION });

    const ver = sb._tables.config_versions.find((v: any) => v.id === VERSION)!;
    const ent = sb._tables.config_entities.find((e: any) => e.id === ENTITY)!;
    expect(ver.status).toBe('published');
    expect(ver.published_at).toBeTruthy();
    expect(ent.current_published_version_id).toBe(VERSION);
  });

  it('publishVersion refuses to publish an already-published version', async () => {
    const sb = buildSupabase({
      config_entities: [
        { id: ENTITY, tenant_id: TENANT, config_type: 'case_owner_policy', slug: 'x', display_name: 'x', current_published_version_id: VERSION, status: 'active' },
      ],
      config_versions: [
        { id: VERSION, config_entity_id: ENTITY, tenant_id: TENANT, version_number: 1, status: 'published', definition: validCaseOwnerDef() },
      ],
    });
    const svc = new PolicyStoreService(sb as any);

    await expect(
      svc.publishVersion({ tenant_id: TENANT, version_id: VERSION }),
    ).rejects.toThrow(/only draft versions can be published/);
  });

  it('getPublishedDefinition returns null when nothing published, payload when set', async () => {
    const sb = buildSupabase({
      config_entities: [
        { id: ENTITY, tenant_id: TENANT, config_type: 'case_owner_policy', slug: 'x', display_name: 'x', current_published_version_id: null, status: 'active' },
      ],
      config_versions: [],
    });
    const svc = new PolicyStoreService(sb as any);

    expect(await svc.getPublishedDefinition(TENANT, ENTITY)).toBeNull();

    sb._tables.config_entities[0].current_published_version_id = VERSION;
    sb._tables.config_versions.push({ id: VERSION, config_entity_id: ENTITY, tenant_id: TENANT, version_number: 1, status: 'published', definition: validCaseOwnerDef() });

    const result = await svc.getPublishedDefinition(TENANT, ENTITY);
    expect(result?.version_id).toBe(VERSION);
    expect(result?.config_type).toBe('case_owner_policy');
  });

  it('getEntity 404s when entity does not exist', async () => {
    const sb = buildSupabase({ config_entities: [] });
    const svc = new PolicyStoreService(sb as any);
    await expect(svc.getEntity(TENANT, ENTITY)).rejects.toThrow(NotFoundException);
  });
});
