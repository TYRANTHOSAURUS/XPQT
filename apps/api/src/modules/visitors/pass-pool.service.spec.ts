/**
 * VisitorPassPoolService — pass pool unit tests.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md
 *   §4.4, §4.5, §7.6
 *
 * The DB layer is the source of truth (composite FK + state CHECK in
 * migration 00249). These tests assert the application layer:
 *   - locks the pass row (FOR UPDATE)
 *   - validates state transitions BEFORE issuing UPDATEs
 *   - tenant-checks both the pass and the visitor
 *   - emits audit events with the right payload
 *   - clears `visitors.visitor_pass_id` on return / mark-missing
 *   - drops back-references at the right moments
 *
 * Pattern mirrors visitor-service.spec.ts — fake `pg.PoolClient` that
 * answers SELECT FOR UPDATE on visitor_pass_pool / visitors with canned
 * rows, captures UPDATEs + audit_events for assertion.
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { VisitorPassPoolService, type VisitorPassPool } from './pass-pool.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const PASS_ID = '22222222-2222-4222-8222-222222222222';
const VISITOR_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_VISITOR_ID = '44444444-4444-4444-8444-444444444444';
const BUILDING_ID = '55555555-5555-4555-8555-555555555555';
const SITE_ID = '66666666-6666-4666-8666-666666666666';

interface CapturedSql {
  sql: string;
  params?: unknown[];
}

function basePass(overrides: Partial<VisitorPassPool> = {}): VisitorPassPool {
  return {
    id: PASS_ID,
    tenant_id: TENANT_ID,
    space_id: BUILDING_ID,
    space_kind: 'building',
    pass_number: '042',
    pass_type: 'standard',
    status: 'available',
    current_visitor_id: null,
    reserved_for_visitor_id: null,
    last_assigned_at: null,
    notes: null,
    created_at: '2026-04-30T08:00:00Z',
    updated_at: '2026-04-30T08:00:00Z',
    ...overrides,
  };
}

interface FakeDbOpts {
  initialPass?: VisitorPassPool;
  /** Visitor row returned by `select ... from visitors where id = $1`. */
  visitorRow?: { id: string; tenant_id: string } | null;
  /** Rows returned by `pass_pool_for_space($1)`. */
  poolForSpaceRows?: VisitorPassPool[];
  /** Rows returned by the available-passes select. */
  availableRows?: VisitorPassPool[];
  /** Rows returned by the unreturned-passes select. */
  unreturnedRows?: VisitorPassPool[];
}

function makeFakeDb(opts: FakeDbOpts = {}) {
  let pass: VisitorPassPool | null = opts.initialPass ? { ...opts.initialPass } : null;
  const visitor = opts.visitorRow ?? { id: VISITOR_ID, tenant_id: TENANT_ID };
  const captured: CapturedSql[] = [];
  const audit: Array<{ event_type: string; entity_type: string; entity_id: string | null; details: Record<string, unknown> }> = [];
  const visitorUpdates: Array<{ visitor_id: string; visitor_pass_id: string | null }> = [];
  const passUpdates: Array<{
    status?: string;
    current_visitor_id?: string | null;
    reserved_for_visitor_id?: string | null;
  }> = [];

  const client: Partial<PoolClient> & { query: jest.Mock } = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      captured.push({ sql, params });
      const trimmed = sql.trim().toLowerCase();

      // SELECT FOR UPDATE on visitor_pass_pool
      if (trimmed.startsWith('select') && trimmed.includes('from public.visitor_pass_pool')) {
        if (!pass) return { rows: [], rowCount: 0 };
        return { rows: [pass], rowCount: 1 };
      }

      // SELECT FOR UPDATE on visitors
      if (trimmed.startsWith('select') && trimmed.includes('from public.visitors')) {
        if (!visitor) return { rows: [], rowCount: 0 };
        return { rows: [visitor], rowCount: 1 };
      }

      // UPDATE visitor_pass_pool
      if (trimmed.startsWith('update public.visitor_pass_pool')) {
        const update: { status?: string; current_visitor_id?: string | null; reserved_for_visitor_id?: string | null } = {};
        // Parse SET clause naively to mutate `pass`.
        const setMatch = sql.match(/set\s+([\s\S]+?)\s+where/i);
        if (setMatch && pass) {
          // Each "col = $N" or "col = null" or "col = 'literal'"
          const assignments = setMatch[1].split(',').map((s) => s.trim());
          for (const assignment of assignments) {
            const [colRaw, valRaw] = assignment.split('=').map((p) => p.trim());
            const col = colRaw as keyof VisitorPassPool;
            if (valRaw === 'null') {
              (pass as Record<string, unknown>)[col] = null;
              if (col === 'status' || col === 'current_visitor_id' || col === 'reserved_for_visitor_id') {
                (update as Record<string, unknown>)[col] = null;
              }
            } else if (valRaw.startsWith("'") && valRaw.endsWith("'")) {
              const literal = valRaw.slice(1, -1);
              (pass as Record<string, unknown>)[col] = literal;
              if (col === 'status') update.status = literal;
            } else if (valRaw.startsWith('$')) {
              const idx = Number(valRaw.slice(1)) - 1;
              const val = params?.[idx] ?? null;
              (pass as Record<string, unknown>)[col] = val;
              if (col === 'current_visitor_id') update.current_visitor_id = val as string | null;
              if (col === 'reserved_for_visitor_id') update.reserved_for_visitor_id = val as string | null;
            }
          }
        }
        passUpdates.push(update);
        return { rows: [pass], rowCount: 1 };
      }

      // UPDATE visitors set visitor_pass_id = ...
      if (trimmed.startsWith('update public.visitors')) {
        // Two shapes:
        //   set visitor_pass_id = $1 where id = $2 and tenant_id = $3 → assignPass
        //   set visitor_pass_id = null where id = $1 and tenant_id = $2 → return/missing
        const setMatch = sql.match(/set\s+visitor_pass_id\s*=\s*([^\s,]+)\s+where\s+id\s*=\s*(\$\d+)/i);
        let passVal: string | null = null;
        let visitorVal = '';
        if (setMatch) {
          const setRhs = setMatch[1];
          const idRef = setMatch[2];
          if (setRhs === 'null') {
            passVal = null;
          } else if (setRhs.startsWith('$')) {
            const idx = Number(setRhs.slice(1)) - 1;
            passVal = (params?.[idx] as string | null) ?? null;
          }
          const idIdx = Number(idRef.slice(1)) - 1;
          visitorVal = (params?.[idIdx] as string) ?? '';
        }
        visitorUpdates.push({ visitor_id: visitorVal, visitor_pass_id: passVal });
        return { rows: [], rowCount: 1 };
      }

      // INSERT audit_events
      if (trimmed.startsWith('insert into public.audit_events')) {
        const eventType = (params?.[1] as string) ?? '';
        const entityType = (params?.[2] as string) ?? '';
        const entityId = (params?.[3] as string) ?? null;
        const rawDetails = params?.[4];
        const details =
          typeof rawDetails === 'string'
            ? (JSON.parse(rawDetails) as Record<string, unknown>)
            : ((rawDetails as Record<string, unknown> | undefined) ?? {});
        audit.push({ event_type: eventType, entity_type: entityType, entity_id: entityId, details });
        return { rows: [], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    }),
  };

  const db = {
    tx: jest.fn(async <T>(fn: (c: PoolClient) => Promise<T>): Promise<T> => fn(client as PoolClient)),
    queryMany: jest.fn(async <T>(sql: string, _params?: unknown[]): Promise<T[]> => {
      const trimmed = sql.trim().toLowerCase();
      if (trimmed.includes('pass_pool_for_space')) {
        return (opts.poolForSpaceRows ?? []) as unknown as T[];
      }
      if (trimmed.includes("status = 'available'")) {
        return (opts.availableRows ?? []) as unknown as T[];
      }
      if (trimmed.includes("status = 'lost'")) {
        return (opts.unreturnedRows ?? []) as unknown as T[];
      }
      return [] as T[];
    }),
  };

  return {
    db,
    client,
    captured,
    audit,
    visitorUpdates,
    passUpdates,
    getPass: () => pass,
  };
}

function tenantCtx() {
  return jest
    .spyOn(TenantContext, 'current')
    .mockReturnValue({ id: TENANT_ID } as never);
}

describe('VisitorPassPoolService', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('passPoolForSpace', () => {
    it('returns the building pool when one is anchored at the building', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        poolForSpaceRows: [basePass({ space_id: BUILDING_ID, space_kind: 'building' })],
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const pool = await svc.passPoolForSpace(BUILDING_ID, TENANT_ID);
      expect(pool?.space_id).toBe(BUILDING_ID);
    });

    it('returns the site-level pool when no building-level pool exists (inheritance)', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        poolForSpaceRows: [basePass({ space_id: SITE_ID, space_kind: 'site' })],
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const pool = await svc.passPoolForSpace(BUILDING_ID, TENANT_ID);
      expect(pool?.space_kind).toBe('site');
    });

    it('returns null when uses_visitor_passes=false anywhere in the ancestor chain', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ poolForSpaceRows: [] });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const pool = await svc.passPoolForSpace(BUILDING_ID, TENANT_ID);
      expect(pool).toBeNull();
    });

    it('rejects mismatched tenant context', async () => {
      tenantCtx();
      const ctx = makeFakeDb({});
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.passPoolForSpace(BUILDING_ID, OTHER_TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('assignPass', () => {
    it('available → in_use sets current_visitor_id + last_assigned_at + visitor.visitor_pass_id', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'available' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID);

      const pass = ctx.getPass();
      expect(pass?.status).toBe('in_use');
      expect(pass?.current_visitor_id).toBe(VISITOR_ID);
      expect(pass?.last_assigned_at).toBeTruthy();

      // visitors.visitor_pass_id mirrored
      const mirrored = ctx.visitorUpdates.find((u) => u.visitor_id === VISITOR_ID);
      expect(mirrored?.visitor_pass_id).toBe(PASS_ID);

      // audit
      expect(ctx.audit.find((a) => a.event_type === 'visitor.pass_assigned')).toBeTruthy();
    });

    it('reserved-for-this-visitor → in_use promotes the reservation', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({
          status: 'reserved',
          reserved_for_visitor_id: VISITOR_ID,
        }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID);

      const pass = ctx.getPass();
      expect(pass?.status).toBe('in_use');
      expect(pass?.current_visitor_id).toBe(VISITOR_ID);
      // reserved_for_visitor_id always cleared on assignment
      expect(pass?.reserved_for_visitor_id).toBeNull();
    });

    it('reserved-for-different-visitor throws ConflictException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({
          status: 'reserved',
          reserved_for_visitor_id: OTHER_VISITOR_ID,
        }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // No mutation
      expect(ctx.passUpdates).toHaveLength(0);
    });

    it('already in_use throws ConflictException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({
          status: 'in_use',
          current_visitor_id: OTHER_VISITOR_ID,
        }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('lost or retired passes throw BadRequestException', async () => {
      tenantCtx();
      const ctxLost = makeFakeDb({ initialPass: basePass({ status: 'lost' }) });
      const svc = new VisitorPassPoolService(ctxLost.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );

      const ctxRetired = makeFakeDb({ initialPass: basePass({ status: 'retired' }) });
      const svcRetired = new VisitorPassPoolService(ctxRetired.db as never);
      await expect(svcRetired.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cross-tenant pass access blocked', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({ tenant_id: OTHER_TENANT_ID, status: 'available' }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('cross-tenant visitor blocked', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({ status: 'available' }),
        visitorRow: { id: VISITOR_ID, tenant_id: OTHER_TENANT_ID },
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('missing pass throws NotFoundException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: undefined });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.assignPass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('reservePass', () => {
    it('available → reserved with reserved_for_visitor_id set', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'available' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.reservePass(PASS_ID, VISITOR_ID, TENANT_ID);

      const pass = ctx.getPass();
      expect(pass?.status).toBe('reserved');
      expect(pass?.reserved_for_visitor_id).toBe(VISITOR_ID);
      expect(ctx.audit.find((a) => a.event_type === 'visitor.pass_reserved')).toBeTruthy();
    });

    it('non-available passes throw ConflictException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({ status: 'in_use', current_visitor_id: OTHER_VISITOR_ID }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.reservePass(PASS_ID, VISITOR_ID, TENANT_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('returnPass', () => {
    it('in_use → available clears refs + visitor.visitor_pass_id', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({
          status: 'in_use',
          current_visitor_id: VISITOR_ID,
          last_assigned_at: '2026-04-30T09:00:00Z',
        }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.returnPass(PASS_ID, TENANT_ID);

      const pass = ctx.getPass();
      expect(pass?.status).toBe('available');
      expect(pass?.current_visitor_id).toBeNull();
      expect(pass?.reserved_for_visitor_id).toBeNull();

      // visitor.visitor_pass_id cleared
      const cleared = ctx.visitorUpdates.find((u) => u.visitor_id === VISITOR_ID);
      expect(cleared?.visitor_pass_id).toBeNull();

      expect(ctx.audit.find((a) => a.event_type === 'visitor.pass_returned')).toBeTruthy();
    });

    it('non-in_use throws BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'available' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.returnPass(PASS_ID, TENANT_ID)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('markPassMissing', () => {
    it('audit emits with reason metadata', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({ status: 'in_use', current_visitor_id: VISITOR_ID }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.markPassMissing(PASS_ID, TENANT_ID, 'visitor walked off');

      const evt = ctx.audit.find((a) => a.event_type === 'visitor.pass_marked_missing');
      expect(evt).toBeTruthy();
      expect(evt!.details).toMatchObject({
        pass_number: '042',
        reason: 'visitor walked off',
        from_status: 'in_use',
      });
    });

    it('clears visitor.visitor_pass_id when previously held', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        initialPass: basePass({ status: 'in_use', current_visitor_id: VISITOR_ID }),
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.markPassMissing(PASS_ID, TENANT_ID);

      const cleared = ctx.visitorUpdates.find((u) => u.visitor_id === VISITOR_ID);
      expect(cleared?.visitor_pass_id).toBeNull();

      const pass = ctx.getPass();
      expect(pass?.status).toBe('lost');
      expect(pass?.current_visitor_id).toBeNull();
    });

    it('cannot mark a retired pass missing', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'retired' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.markPassMissing(PASS_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('markPassRecovered', () => {
    it('lost → available', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'lost' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await svc.markPassRecovered(PASS_ID, TENANT_ID);

      const pass = ctx.getPass();
      expect(pass?.status).toBe('available');
      expect(ctx.audit.find((a) => a.event_type === 'visitor.pass_recovered')).toBeTruthy();
    });

    it('non-lost passes throw BadRequestException', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ initialPass: basePass({ status: 'available' }) });
      const svc = new VisitorPassPoolService(ctx.db as never);
      await expect(svc.markPassRecovered(PASS_ID, TENANT_ID)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('unreturnedPassesForBuilding', () => {
    it('returns lost passes with recent last_assigned_at', async () => {
      tenantCtx();
      const lost = basePass({ status: 'lost', last_assigned_at: '2026-04-30T16:00:00Z' });
      const ctx = makeFakeDb({
        poolForSpaceRows: [basePass({ space_id: BUILDING_ID })],
        unreturnedRows: [lost],
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const yesterday = new Date('2026-04-30T00:00:00Z');
      const rows = await svc.unreturnedPassesForBuilding(BUILDING_ID, TENANT_ID, yesterday);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('lost');
    });

    it('returns empty when no pool covers the building', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ poolForSpaceRows: [] });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const rows = await svc.unreturnedPassesForBuilding(BUILDING_ID, TENANT_ID, new Date());
      expect(rows).toEqual([]);
    });
  });

  describe('availablePassesForSpace', () => {
    it('returns sorted available rows for the resolved pool anchor', async () => {
      tenantCtx();
      const ctx = makeFakeDb({
        poolForSpaceRows: [basePass({ space_id: BUILDING_ID })],
        availableRows: [
          basePass({ id: 'a', pass_number: '001', status: 'available' }),
          basePass({ id: 'b', pass_number: '002', status: 'available' }),
        ],
      });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const rows = await svc.availablePassesForSpace(BUILDING_ID, TENANT_ID);
      expect(rows).toHaveLength(2);
    });

    it('returns empty when no pool resolves', async () => {
      tenantCtx();
      const ctx = makeFakeDb({ poolForSpaceRows: [] });
      const svc = new VisitorPassPoolService(ctx.db as never);
      const rows = await svc.availablePassesForSpace(BUILDING_ID, TENANT_ID);
      expect(rows).toEqual([]);
    });
  });
});
