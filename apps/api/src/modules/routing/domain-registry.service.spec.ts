import { NotFoundException } from '@nestjs/common';
import { DomainRegistryService } from './domain-registry.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const D_FM = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const D_DOORS = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const D_IT = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';

type AnyTable = Record<string, any>;

function buildSupabase(tables: Record<string, AnyTable[]>) {
  function applyFilters(rows: AnyTable[], filters: Array<[string, any]>) {
    return rows.filter((r) => filters.every(([k, v]) => r[k] === v));
  }

  function from(table: string) {
    const rows = tables[table] ?? [];
    const qb: any = {
      _filters: [] as Array<[string, any]>,
      _order: null as { col: string; asc: boolean } | null,
      _pending: null as null | { kind: 'insert'; payload: AnyTable } | { kind: 'update'; patch: AnyTable },

      select() { return qb; },
      insert(payload: AnyTable) {
        const unique = table === 'domains'
          ? !rows.some((r) => r.tenant_id === payload.tenant_id && r.key === payload.key)
          : true;
        if (!unique) {
          qb._uniqueViolation = true;
        } else {
          const row = { id: crypto.randomUUID(), active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...payload };
          rows.push(row);
          qb._pending = { kind: 'insert', payload: row };
        }
        return qb;
      },
      update(patch: AnyTable) {
        qb._pending = { kind: 'update', patch };
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
      async single() {
        if (qb._uniqueViolation) {
          return { data: null, error: { code: '23505', message: 'duplicate key' } };
        }
        if (qb._pending?.kind === 'insert') return { data: qb._pending.payload, error: null };
        if (qb._pending?.kind === 'update') {
          const filtered = applyFilters(rows, qb._filters);
          for (const r of filtered) Object.assign(r, qb._pending.patch);
          return { data: filtered[0] ?? null, error: null };
        }
        const filtered = applyFilters(rows, qb._filters);
        return { data: filtered[0] ?? null, error: null };
      },
      async maybeSingle() {
        const filtered = applyFilters(rows, qb._filters);
        return { data: filtered[0] ?? null, error: null };
      },
      then(resolve: any) {
        const filtered = applyFilters(rows, qb._filters);
        let ordered = filtered;
        if (qb._order) {
          ordered = [...filtered].sort((a, b) => {
            const av = a[qb._order!.col] ?? '';
            const bv = b[qb._order!.col] ?? '';
            if (av < bv) return qb._order!.asc ? -1 : 1;
            if (av > bv) return qb._order!.asc ? 1 : -1;
            return 0;
          });
        }
        resolve({ data: ordered, error: null });
      },
    };
    return qb;
  }

  return { admin: { from }, _tables: tables };
}

describe('DomainRegistryService', () => {
  it('create normalizes key (trim + lowercase) and rejects invalid characters', async () => {
    const sb = buildSupabase({ domains: [] });
    const svc = new DomainRegistryService(sb as any);

    const row = await svc.create({ tenant_id: TENANT, key: '  IT  ', display_name: 'IT' });
    expect(row.key).toBe('it');

    await expect(
      svc.create({ tenant_id: TENANT, key: 'IT Ops!', display_name: 'x' }),
    ).rejects.toThrow(/invalid/);
  });

  it('create rejects duplicate key for the same tenant', async () => {
    const sb = buildSupabase({
      domains: [{ id: D_FM, tenant_id: TENANT, key: 'fm', display_name: 'FM', parent_domain_id: null, active: true, created_at: '', updated_at: '' }],
    });
    const svc = new DomainRegistryService(sb as any);
    await expect(
      svc.create({ tenant_id: TENANT, key: 'fm', display_name: 'Facilities' }),
    ).rejects.toThrow(/already exists/);
  });

  it('findByKey returns the domain', async () => {
    const sb = buildSupabase({
      domains: [{ id: D_FM, tenant_id: TENANT, key: 'fm', display_name: 'FM', parent_domain_id: null, active: true, created_at: '', updated_at: '' }],
    });
    const svc = new DomainRegistryService(sb as any);
    const found = await svc.findByKey(TENANT, 'fm');
    expect(found?.id).toBe(D_FM);
  });

  it('update refuses self-parent', async () => {
    const sb = buildSupabase({
      domains: [{ id: D_FM, tenant_id: TENANT, key: 'fm', display_name: 'FM', parent_domain_id: null, active: true, created_at: '', updated_at: '' }],
    });
    const svc = new DomainRegistryService(sb as any);
    await expect(
      svc.update({ tenant_id: TENANT, id: D_FM, parent_domain_id: D_FM }),
    ).rejects.toThrow(/own parent/);
  });

  it('update detects a transitive cycle — setting doors.parent=it when it.parent=doors', async () => {
    // Graph: it → doors (it's parent is doors). If we set doors.parent = it,
    // we'd form doors → it → doors.
    const sb = buildSupabase({
      domains: [
        { id: D_IT, tenant_id: TENANT, key: 'it', display_name: 'IT', parent_domain_id: D_DOORS, active: true, created_at: '', updated_at: '' },
        { id: D_DOORS, tenant_id: TENANT, key: 'doors', display_name: 'Doors', parent_domain_id: null, active: true, created_at: '', updated_at: '' },
      ],
    });
    const svc = new DomainRegistryService(sb as any);

    await expect(
      svc.update({ tenant_id: TENANT, id: D_DOORS, parent_domain_id: D_IT }),
    ).rejects.toThrow(/cycle/);
  });

  it('update accepts a valid re-parent and persists only provided fields', async () => {
    const sb = buildSupabase({
      domains: [
        { id: D_FM, tenant_id: TENANT, key: 'fm', display_name: 'FM', parent_domain_id: null, active: true, created_at: '', updated_at: '' },
        { id: D_DOORS, tenant_id: TENANT, key: 'doors', display_name: 'Doors', parent_domain_id: null, active: true, created_at: '', updated_at: '' },
      ],
    });
    const svc = new DomainRegistryService(sb as any);

    const updated = await svc.update({
      tenant_id: TENANT,
      id: D_DOORS,
      parent_domain_id: D_FM,
    });

    expect(updated.parent_domain_id).toBe(D_FM);
    expect(updated.display_name).toBe('Doors'); // untouched
  });

  it('deactivate is soft delete — active=false, row stays', async () => {
    const sb = buildSupabase({
      domains: [{ id: D_FM, tenant_id: TENANT, key: 'fm', display_name: 'FM', parent_domain_id: null, active: true, created_at: '', updated_at: '' }],
    });
    const svc = new DomainRegistryService(sb as any);

    await svc.deactivate(TENANT, D_FM);

    expect(sb._tables.domains[0].active).toBe(false);
  });

  it('get 404s when missing', async () => {
    const sb = buildSupabase({ domains: [] });
    const svc = new DomainRegistryService(sb as any);
    await expect(svc.get(TENANT, D_FM)).rejects.toThrow(NotFoundException);
  });

  it('create validates parent exists before insert', async () => {
    const sb = buildSupabase({ domains: [] });
    const svc = new DomainRegistryService(sb as any);

    await expect(
      svc.create({ tenant_id: TENANT, key: 'doors', display_name: 'Doors', parent_domain_id: D_FM }),
    ).rejects.toThrow(NotFoundException);
  });
});
