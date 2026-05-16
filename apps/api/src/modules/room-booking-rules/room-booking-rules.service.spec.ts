import { AppError } from '../../common/errors';
import { RoomBookingRulesService } from './room-booking-rules.service';
import { ApprovalConfigCompilerService } from '../approval/approval-config-compiler.service';
import { TenantContext } from '../../common/tenant-context';
import type { CreateRuleDto, UpdateRuleDto } from './dto';

/**
 * Phase 1.5 — codex IMPORTANT x2 closure spec.
 *
 * Covers the TS half of the two findings fixed in
 * 00406_room_booking_rule_with_workflow_rpcs.sql + room-booking-rules.service.ts:
 *
 *   Finding 1 (fail-closed create) — enforced in SQL (raise P0001 when
 *     approval_config is non-null but p_graph_definition is NULL). The TS
 *     contract that *prevents that path from ever being hit* is: create()
 *     ALWAYS pre-compiles + passes the graph when approval_config is
 *     non-null. Asserted here.
 *
 *   Finding 2 (create/update validation symmetry + byte-equality) — update()
 *     now pre-flights the SAME ApprovalConfigCompilerService.compile() that
 *     create() uses, so (a) a malformed config throws the 422 BEFORE any DB
 *     write on BOTH paths, and (b) for the same approval_config both paths
 *     pass a byte-identical graph to their RPC. Asserted by capturing the
 *     `p_graph_definition` rpc arg from each path and deep-equality + JSON
 *     byte-equality comparing them. The compiler is REAL (pure, no DB) so
 *     the parity assertion is genuine, not mock-defined.
 *
 * supabase.admin is mocked: .rpc captures (fn, args); .from('audit_events')
 * + version reads are best-effort no-ops (the service swallows their errors).
 */

const TENANT = { id: 'T-1', slug: 't', tier: 'standard' as const };
const RULE_ID = 'R-1';

type RpcCall = { fn: string; args: Record<string, unknown> };

function makeSupabase(opts?: {
  rpcResponse?: { data: unknown; error: unknown };
  /** Row returned by findOne()/before-read in update(). */
  beforeRow?: Record<string, unknown> | null;
}) {
  const calls: { rpc: RpcCall[] } = { rpc: [] };
  const rpcResponse =
    opts?.rpcResponse ?? {
      data: { rule: { id: RULE_ID, name: 'r', effect: 'require_approval', target_scope: 'tenant' } },
      error: null,
    };
  const beforeRow =
    opts?.beforeRow === undefined
      ? { id: RULE_ID, name: 'Existing rule', effect: 'require_approval', target_scope: 'tenant', active: true, approval_config: null }
      : opts.beforeRow;

  const admin = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      calls.rpc.push({ fn, args });
      return Promise.resolve(rpcResponse);
    },
    from: (table: string) => {
      if (table === 'room_booking_rules') {
        // findOne(): .select('*').eq('id').eq('tenant_id').maybeSingle()
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () => Promise.resolve({ data: beforeRow, error: null }),
              }),
            }),
          }),
        };
      }
      if (table === 'room_booking_rule_versions') {
        // writeVersion(): version read + insert (both best-effort)
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: () => ({
                  maybeSingle: () => Promise.resolve({ data: null, error: null }),
                }),
              }),
            }),
          }),
          insert: () => Promise.resolve({ error: null }),
        };
      }
      if (table === 'audit_events') {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return { supabase: { admin } as never, calls };
}

function makeEngine() {
  return { validate: jest.fn() } as never;
}

function makeService(supabase: never, engine: never) {
  // REAL compiler — byte-equality parity must be genuine, not mock-defined.
  return new RoomBookingRulesService(
    supabase,
    engine,
    new ApprovalConfigCompilerService(),
  );
}

const APPROVAL_CONFIG = {
  required_approvers: [
    { type: 'person' as const, id: 'p-1' },
    { type: 'team' as const, id: 't-9' },
  ],
  threshold: 'any' as const,
};

function baseCreateDto(over?: Partial<CreateRuleDto>): CreateRuleDto {
  return {
    name: 'Off-hours need approval',
    target_scope: 'tenant',
    applies_when: { op: 'eq', left: 1, right: 1 },
    effect: 'require_approval',
    approval_config: APPROVAL_CONFIG,
    ...over,
  };
}

describe('RoomBookingRulesService — codex IMPORTANT x2', () => {
  describe('Finding 1 — create() always supplies the compiled graph when approval_config is non-null', () => {
    it('passes a non-null p_graph_definition to create RPC (no orphan-rule path)', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      await TenantContext.run(TENANT, () =>
        svc.create(baseCreateDto(), 'actor-1'),
      );

      const rpc = calls.rpc.find((c) => c.fn === 'create_room_booking_rule_with_workflow');
      expect(rpc).toBeDefined();
      expect(rpc!.args.p_graph_definition).not.toBeNull();
      expect(rpc!.args.p_tenant_id).toBe(TENANT.id);
    });

    it('passes p_graph_definition=null when there is no approval_config (no workflow needed)', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      await TenantContext.run(TENANT, () =>
        svc.create(baseCreateDto({ approval_config: null, effect: 'deny' }), 'actor-1'),
      );

      const rpc = calls.rpc.find((c) => c.fn === 'create_room_booking_rule_with_workflow');
      expect(rpc!.args.p_graph_definition).toBeNull();
    });

    it('throws 422 workflow_definition.compilation_failed for a malformed config BEFORE any RPC', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      await expect(
        TenantContext.run(TENANT, () =>
          svc.create(
            baseCreateDto({ approval_config: { required_approvers: [] } }),
            'actor-1',
          ),
        ),
      ).rejects.toMatchObject({
        code: 'workflow_definition.compilation_failed',
        status: 422,
      });
      // Fail-closed in TS: no DB write attempted at all.
      expect(calls.rpc).toHaveLength(0);
    });
  });

  describe('Finding 2 — update() is symmetric with create()', () => {
    it('rejects a malformed patched approval_config with 422 BEFORE any RPC', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      const patch: UpdateRuleDto = { approval_config: { required_approvers: [] } };
      await expect(
        TenantContext.run(TENANT, () => svc.update(RULE_ID, patch, 'actor-1')),
      ).rejects.toMatchObject({
        code: 'workflow_definition.compilation_failed',
        status: 422,
      });
      // No update RPC fired — the bad config never reached the DB.
      expect(calls.rpc.find((c) => c.fn === 'update_room_booking_rule_with_workflow')).toBeUndefined();
    });

    it('passes the compiled p_graph_definition + recompile=true when approval_config is patched', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      await TenantContext.run(TENANT, () =>
        svc.update(RULE_ID, { approval_config: APPROVAL_CONFIG }, 'actor-1'),
      );

      const rpc = calls.rpc.find((c) => c.fn === 'update_room_booking_rule_with_workflow');
      expect(rpc).toBeDefined();
      expect(rpc!.args.p_recompile).toBe(true);
      expect(rpc!.args.p_graph_definition).not.toBeNull();
    });

    it('uses the EFFECTIVE (current-row) approval_config when only the name is patched', async () => {
      const { supabase, calls } = makeSupabase({
        beforeRow: {
          id: RULE_ID,
          name: 'Old name',
          effect: 'require_approval',
          target_scope: 'tenant',
          active: true,
          approval_config: APPROVAL_CONFIG,
        },
      });
      const svc = makeService(supabase, makeEngine());

      await TenantContext.run(TENANT, () =>
        svc.update(RULE_ID, { name: 'New name' }, 'actor-1'),
      );

      const rpc = calls.rpc.find((c) => c.fn === 'update_room_booking_rule_with_workflow');
      expect(rpc!.args.p_recompile).toBe(true);
      // Effective config came from the current row → graph is non-null.
      expect(rpc!.args.p_graph_definition).not.toBeNull();
    });

    it('passes p_graph_definition=null + recompile=false when nothing approval-relevant changed', async () => {
      const { supabase, calls } = makeSupabase();
      const svc = makeService(supabase, makeEngine());

      await TenantContext.run(TENANT, () =>
        svc.update(RULE_ID, { priority: 5 }, 'actor-1'),
      );

      const rpc = calls.rpc.find((c) => c.fn === 'update_room_booking_rule_with_workflow');
      expect(rpc!.args.p_recompile).toBe(false);
      expect(rpc!.args.p_graph_definition).toBeNull();
    });
  });

  describe('byte-equality — create() and update() mint an identical graph for the same approval_config', () => {
    it('the p_graph_definition jsonb is byte-identical across both write paths', async () => {
      // create()
      const createSb = makeSupabase();
      const createSvc = makeService(createSb.supabase, makeEngine());
      await TenantContext.run(TENANT, () =>
        createSvc.create(baseCreateDto({ approval_config: APPROVAL_CONFIG }), 'a'),
      );
      const createGraph = createSb.calls.rpc.find(
        (c) => c.fn === 'create_room_booking_rule_with_workflow',
      )!.args.p_graph_definition;

      // update() — same approval_config patched
      const updateSb = makeSupabase();
      const updateSvc = makeService(updateSb.supabase, makeEngine());
      await TenantContext.run(TENANT, () =>
        updateSvc.update(RULE_ID, { approval_config: APPROVAL_CONFIG }, 'a'),
      );
      const updateGraph = updateSb.calls.rpc.find(
        (c) => c.fn === 'update_room_booking_rule_with_workflow',
      )!.args.p_graph_definition;

      expect(createGraph).not.toBeNull();
      expect(updateGraph).toEqual(createGraph);
      // Stronger: byte-identical JSON serialisation (key order included),
      // because the RPC inserts this jsonb verbatim into
      // workflow_definitions.graph_definition.
      expect(JSON.stringify(updateGraph)).toBe(JSON.stringify(createGraph));
    });
  });
});

// Sanity: the AppError shape the 422 assertions rely on is real.
it('AppError exposes code + status', () => {
  const e = new AppError('workflow_definition.compilation_failed', 422, {});
  expect(e.code).toBe('workflow_definition.compilation_failed');
  expect(e.status).toBe(422);
});
