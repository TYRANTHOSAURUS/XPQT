import { BadRequestException, ConflictException } from '@nestjs/common';
import { ServiceRoutingService } from './service-routing.service';
import { TenantContext } from '../../common/tenant-context';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface InsertCapture {
  payload: Record<string, unknown>;
}

function makeFakeDb(opts: {
  insertError?: { code?: string; message?: string };
  insertReturn?: Record<string, unknown>;
  updateReturn?: Record<string, unknown>;
} = {}) {
  const inserts: InsertCapture[] = [];
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  const supabase = {
    admin: {
      from: jest.fn(() => ({
        select: () => ({
          eq: () => ({
            order: () => ({
              order: async () => ({ data: [], error: null }),
            }),
            eq: () => ({
              maybeSingle: async () => ({
                data: opts.updateReturn ?? null,
                error: null,
              }),
            }),
          }),
        }),
        insert: (payload: Record<string, unknown>) => {
          inserts.push({ payload });
          return {
            select: () => ({
              single: async () => {
                if (opts.insertError) return { data: null, error: opts.insertError };
                return {
                  data: opts.insertReturn ?? { id: 'new-id', ...payload },
                  error: null,
                };
              },
            }),
          };
        },
        update: (patch: Record<string, unknown>) => {
          return {
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => {
                    updates.push({ id: 'existing-id', patch });
                    return {
                      data: opts.updateReturn ?? { id: 'existing-id', ...patch },
                      error: null,
                    };
                  },
                }),
              }),
            }),
          };
        },
        delete: () => ({
          eq: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      })),
    },
  };

  return { supabase, inserts, updates };
}

function withTenant<T>(fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: TENANT, subdomain: 't1' }, fn);
}

describe('ServiceRoutingService', () => {
  describe('create', () => {
    it('rejects an invalid service_category', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          svc.create({
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            service_category: 'not_a_real_category' as any,
            internal_team_id: 't1',
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a negative lead time', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          svc.create({
            service_category: 'catering',
            default_lead_time_minutes: -5,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a lead time over 24h (1440 min)', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          svc.create({
            service_category: 'catering',
            default_lead_time_minutes: 1500,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a non-integer lead time', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          svc.create({
            service_category: 'catering',
            default_lead_time_minutes: 30.5,
          }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('passes a valid payload through and inserts tenant_id from context', async () => {
      const { supabase, inserts } = makeFakeDb({
        insertReturn: { id: 'new', tenant_id: TENANT, service_category: 'catering' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await withTenant(() =>
        svc.create({
          service_category: 'av_equipment',
          internal_team_id: 'team-xyz',
          default_lead_time_minutes: 60,
        }),
      );

      expect(inserts).toHaveLength(1);
      expect(inserts[0].payload.tenant_id).toBe(TENANT);
      expect(inserts[0].payload.service_category).toBe('av_equipment');
      expect(inserts[0].payload.internal_team_id).toBe('team-xyz');
      expect(inserts[0].payload.default_lead_time_minutes).toBe(60);
    });

    it('defaults lead time to 30 when omitted', async () => {
      const { supabase, inserts } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await withTenant(() =>
        svc.create({ service_category: 'cleaning' }),
      );
      expect(inserts[0].payload.default_lead_time_minutes).toBe(30);
    });

    it('defaults active to true when omitted', async () => {
      const { supabase, inserts } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await withTenant(() => svc.create({ service_category: 'cleaning' }));
      expect(inserts[0].payload.active).toBe(true);
    });

    it('maps Postgres 23505 (unique violation) to a 409 with a friendly code', async () => {
      const { supabase } = makeFakeDb({
        insertError: { code: '23505', message: 'duplicate key value...' },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          svc.create({
            service_category: 'catering',
            internal_team_id: 'team-1',
          }),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('treats null location_id (tenant default) the same as a per-location row in payload shape', async () => {
      const { supabase, inserts } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await withTenant(() =>
        svc.create({
          service_category: 'catering',
          location_id: null,
          internal_team_id: 'team-tenant-default',
        }),
      );

      expect(inserts[0].payload.location_id).toBeNull();
    });
  });

  describe('update', () => {
    it('refuses to update service_category (immutable routing key)', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() =>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          svc.update('some-id', { service_category: 'cleaning' as any }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to update location_id (immutable routing key)', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() => svc.update('some-id', { location_id: 'new-loc' })),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects an invalid lead time on update', async () => {
      const { supabase } = makeFakeDb();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await expect(
        withTenant(() => svc.update('some-id', { default_lead_time_minutes: -10 })),
      ).rejects.toThrow(BadRequestException);
    });

    it('passes a valid lead time + team change through', async () => {
      const { supabase, updates } = makeFakeDb({
        updateReturn: {
          id: 'existing-id',
          tenant_id: TENANT,
          service_category: 'catering',
          internal_team_id: 'new-team',
          default_lead_time_minutes: 45,
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const svc = new ServiceRoutingService(supabase as any);

      await withTenant(() =>
        svc.update('existing-id', {
          internal_team_id: 'new-team',
          default_lead_time_minutes: 45,
        }),
      );

      expect(updates).toHaveLength(1);
      expect(updates[0].patch.internal_team_id).toBe('new-team');
      expect(updates[0].patch.default_lead_time_minutes).toBe(45);
    });
  });
});
