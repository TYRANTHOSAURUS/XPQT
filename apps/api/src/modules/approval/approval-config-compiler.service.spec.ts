import { AppError } from '../../common/errors';
import {
  ApprovalConfigCompilerService,
  type WorkflowGraphDefinition,
} from './approval-config-compiler.service';
import type { ApprovalConfig } from '../room-booking-rules/dto';

/**
 * Fixture matrix + parity test for the Phase 1.5 sub-step 6.A.X compiler.
 *
 * Spec: docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md
 *   §3.3 (compiled graph shape — lines 1009-1026 of the plan are the
 *   canonical reference; the parity test below asserts byte-equality
 *   against that exact shape).
 *
 * The compiler is pure (no DI), so we instantiate it directly — no Nest
 * test module needed. The SQL-side parity test (TS-compile vs migration
 * 00399 block E backfill) ships in sub-step 6.B's smoke probe; for 6.A.X
 * we assert against the hand-rolled reference jsonb from §3.3.
 */

describe('ApprovalConfigCompilerService.compile', () => {
  const svc = new ApprovalConfigCompilerService();

  describe('happy paths — fixture matrix', () => {
    it('single person approver, threshold=all', () => {
      const config: ApprovalConfig = {
        required_approvers: [{ type: 'person', id: 'p1' }],
        threshold: 'all',
      };
      const { graphDefinition, name } = svc.compile(config, {
        ruleName: 'Off-hours bookings need manager approval',
      });

      expect(name).toBe('Off-hours bookings need manager approval approval workflow');
      expect(graphDefinition).toEqual({
        nodes: [
          { id: 'trigger', type: 'trigger', config: {} },
          {
            id: 'approval_main',
            type: 'approval',
            config: {
              required_approvers: [{ type: 'person', id: 'p1' }],
              threshold: 'all',
              rule_type: 'room_booking',
            },
          },
          { id: 'end_success', type: 'end', config: { outcome: 'approved' } },
          { id: 'end_failure', type: 'end', config: { outcome: 'rejected' } },
        ],
        edges: [
          { from: 'trigger', to: 'approval_main' },
          { from: 'approval_main', to: 'end_success', condition: 'approved' },
          { from: 'approval_main', to: 'end_failure', condition: 'rejected' },
        ],
      });
    });

    it('single person approver, threshold=any', () => {
      const config: ApprovalConfig = {
        required_approvers: [{ type: 'person', id: 'p1' }],
        threshold: 'any',
      };
      const { graphDefinition } = svc.compile(config, { ruleName: 'r' });

      const approvalNode = graphDefinition.nodes.find((n) => n.id === 'approval_main');
      expect(approvalNode?.config.threshold).toBe('any');
      expect(approvalNode?.config.required_approvers).toEqual([{ type: 'person', id: 'p1' }]);
    });

    it('single team approver, default threshold (omitted → all)', () => {
      const config: ApprovalConfig = {
        required_approvers: [{ type: 'team', id: 't1' }],
      };
      const { graphDefinition } = svc.compile(config, { ruleName: 'r' });

      const approvalNode = graphDefinition.nodes.find((n) => n.id === 'approval_main');
      // Plan §3.2 block E + §3.3 edge cases: omitted threshold defaults to
      // 'all' to match the SQL coalesce in the 00399 backfill assembly.
      expect(approvalNode?.config.threshold).toBe('all');
      expect(approvalNode?.config.required_approvers).toEqual([{ type: 'team', id: 't1' }]);
    });

    it('mixed person + team, threshold=all — preserves input array order verbatim', () => {
      const config: ApprovalConfig = {
        required_approvers: [
          { type: 'person', id: 'p1' },
          { type: 'team', id: 't1' },
          { type: 'person', id: 'p2' },
        ],
        threshold: 'all',
      };
      const { graphDefinition } = svc.compile(config, { ruleName: 'r' });

      const approvalNode = graphDefinition.nodes.find((n) => n.id === 'approval_main');
      // Order MUST be verbatim — both the engine executor (sub-step 6.A)
      // and the 00399 backfill iterate the array in storage order.
      expect(approvalNode?.config.required_approvers).toEqual([
        { type: 'person', id: 'p1' },
        { type: 'team', id: 't1' },
        { type: 'person', id: 'p2' },
      ]);
    });

    it('4 approvers (mix of types), threshold=any', () => {
      const config: ApprovalConfig = {
        required_approvers: [
          { type: 'team', id: 't1' },
          { type: 'person', id: 'p1' },
          { type: 'team', id: 't2' },
          { type: 'person', id: 'p2' },
        ],
        threshold: 'any',
      };
      const { graphDefinition } = svc.compile(config, { ruleName: 'big rule' });

      const approvalNode = graphDefinition.nodes.find((n) => n.id === 'approval_main');
      expect(approvalNode?.config.threshold).toBe('any');
      expect((approvalNode?.config.required_approvers as unknown[]).length).toBe(4);
      expect(approvalNode?.config.required_approvers).toEqual(config.required_approvers);
    });

    it('rule_type defaults to "room_booking" and is threaded through node.config', () => {
      const config: ApprovalConfig = {
        required_approvers: [{ type: 'person', id: 'p1' }],
        threshold: 'all',
      };
      const defaultResult = svc.compile(config, { ruleName: 'r' });
      const defaultApprovalNode = defaultResult.graphDefinition.nodes.find(
        (n) => n.id === 'approval_main',
      );
      expect(defaultApprovalNode?.config.rule_type).toBe('room_booking');

      const serviceResult = svc.compile(config, { ruleName: 'r', ruleType: 'service' });
      const serviceApprovalNode = serviceResult.graphDefinition.nodes.find(
        (n) => n.id === 'approval_main',
      );
      expect(serviceApprovalNode?.config.rule_type).toBe('service');
    });
  });

  describe('negative cases — all throw AppError with code workflow_definition.compilation_failed', () => {
    function expectCompileFailure(
      config: unknown,
      opts: { ruleName: string } = { ruleName: 'r' },
    ): AppError {
      try {
        svc.compile(config as ApprovalConfig, opts);
        throw new Error('expected compile() to throw, but it returned');
      } catch (err) {
        expect(err).toBeInstanceOf(AppError);
        const appErr = err as AppError;
        expect(appErr.code).toBe('workflow_definition.compilation_failed');
        expect(appErr.status).toBe(422);
        return appErr;
      }
    }

    it('required_approvers: [] throws', () => {
      expectCompileFailure({ required_approvers: [], threshold: 'all' });
    });

    it('required_approvers: undefined throws', () => {
      expectCompileFailure({ threshold: 'all' });
    });

    it('required_approvers: null throws', () => {
      expectCompileFailure({ required_approvers: null, threshold: 'all' });
    });

    it('approver with type=invalid throws', () => {
      expectCompileFailure({
        required_approvers: [{ type: 'invalid', id: 'x' }],
        threshold: 'all',
      });
    });

    it('approver with empty id throws', () => {
      expectCompileFailure({
        required_approvers: [{ type: 'person', id: '' }],
        threshold: 'all',
      });
    });

    it('approver with missing id throws', () => {
      expectCompileFailure({
        required_approvers: [{ type: 'person' }],
        threshold: 'all',
      });
    });

    it('approver that is not an object throws', () => {
      expectCompileFailure({
        required_approvers: ['just-a-string'],
        threshold: 'all',
      });
    });

    it("threshold='invalid' throws", () => {
      expectCompileFailure({
        required_approvers: [{ type: 'person', id: 'p1' }],
        threshold: 'invalid',
      });
    });
  });

  describe('SQL parity — TS compile output equals plan §3.3 canonical jsonb', () => {
    /**
     * The plan's §3.3 example block (lines 1009-1026 of
     * `docs/superpowers/specs/phase-1.5-visual-approval-workflow-plan.md`)
     * is the reference shape the 00399 backfill assembly must produce
     * byte-for-byte. Parity test: hand-write the expected jsonb against
     * the documented input shape and assert `JSON.stringify` equality.
     *
     * The SQL-side parity test (TS compile vs the actual migration
     * 00399 block E backfill) ships in sub-step 6.B's smoke probe.
     */
    it('matches the §3.3 canonical example (one person + one team, threshold=all)', () => {
      const config: ApprovalConfig = {
        required_approvers: [
          { type: 'person', id: '11111111-1111-1111-1111-111111111111' },
          { type: 'team', id: '22222222-2222-2222-2222-222222222222' },
        ],
        threshold: 'all',
      };
      const { graphDefinition } = svc.compile(config, { ruleName: 'canon' });

      // The canonical shape from the plan §3.3 example block, with the
      // input ids substituted. `rule_type` is a Phase 1.5 extension over
      // the §3.3 example (threaded for the sibling service_rules spec —
      // see plan §0.3); the example block doesn't show it because it
      // was authored before the discriminator was added.
      const EXPECTED: WorkflowGraphDefinition = {
        nodes: [
          { id: 'trigger', type: 'trigger', config: {} },
          {
            id: 'approval_main',
            type: 'approval',
            config: {
              required_approvers: [
                { type: 'person', id: '11111111-1111-1111-1111-111111111111' },
                { type: 'team', id: '22222222-2222-2222-2222-222222222222' },
              ],
              threshold: 'all',
              rule_type: 'room_booking',
            },
          },
          { id: 'end_success', type: 'end', config: { outcome: 'approved' } },
          { id: 'end_failure', type: 'end', config: { outcome: 'rejected' } },
        ],
        edges: [
          { from: 'trigger', to: 'approval_main' },
          { from: 'approval_main', to: 'end_success', condition: 'approved' },
          { from: 'approval_main', to: 'end_failure', condition: 'rejected' },
        ],
      };

      // `JSON.stringify` byte-equality — this is the contract the
      // 00399 backfill assembly must hit when consuming the same input.
      expect(JSON.stringify(graphDefinition)).toBe(JSON.stringify(EXPECTED));
    });
  });
});
