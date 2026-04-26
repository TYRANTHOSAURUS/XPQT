import { mergeScopeInto, mergeBreakdown } from './approval-routing.service';

describe('approval-routing scope merging', () => {
  describe('mergeScopeInto', () => {
    it('concats arrays per key (the bug raw jsonb || would cause)', () => {
      const target = { reservation_ids: ['r1'] };
      const addition = { reservation_ids: ['r2'] };
      mergeScopeInto(target, addition);
      expect(target.reservation_ids).toEqual(['r1', 'r2']);
    });

    it('dedupes ids inside the array', () => {
      const target = { order_line_item_ids: ['oli-1', 'oli-2'] };
      const addition = { order_line_item_ids: ['oli-2', 'oli-3'] };
      mergeScopeInto(target, addition);
      expect(target.order_line_item_ids).toEqual(['oli-1', 'oli-2', 'oli-3']);
    });

    it('handles a missing key on either side', () => {
      const target: { reservation_ids?: string[] } = {};
      const addition = { reservation_ids: ['r1'] };
      mergeScopeInto(target, addition);
      expect(target.reservation_ids).toEqual(['r1']);
    });

    it('skips when the addition is empty', () => {
      const target = { ticket_ids: ['t1'] };
      const addition = { ticket_ids: [] as string[] };
      mergeScopeInto(target, addition);
      expect(target.ticket_ids).toEqual(['t1']);
    });
  });

  describe('mergeBreakdown', () => {
    it('merges all entity arrays + reasons (rule_id deduped)', () => {
      const existing = {
        reservation_ids: ['r1'],
        reasons: [{ rule_id: 'rule-a', denial_message: 'msg A' }],
      };
      const addition = {
        reservation_ids: ['r2'],
        reasons: [{ rule_id: 'rule-b', denial_message: 'msg B' }],
      };
      const merged = mergeBreakdown(existing, addition);
      expect(merged.reservation_ids).toEqual(['r1', 'r2']);
      expect(merged.reasons).toEqual([
        { rule_id: 'rule-a', denial_message: 'msg A' },
        { rule_id: 'rule-b', denial_message: 'msg B' },
      ]);
    });

    it('does not duplicate reasons when the same rule fires twice', () => {
      const existing = {
        reasons: [{ rule_id: 'rule-a', denial_message: 'msg A' }],
      };
      const addition = {
        reasons: [{ rule_id: 'rule-a', denial_message: 'msg A again' }],
      };
      const merged = mergeBreakdown(existing, addition);
      expect(merged.reasons).toEqual([{ rule_id: 'rule-a', denial_message: 'msg A' }]);
    });
  });
});

describe('ApprovalRoutingService.assemble (integration)', () => {
  it.todo('expands a role approver to all active members');
  it.todo('dedupes pending approval rows by (target, approver) inside one transaction');
  it.todo('retries on 23505 when a concurrent insert wins the race');
  it.todo('resolves cost_center.default_approver via the bundle context');
  it.todo('skips unknown derived expressions with a warning (returns no rows)');
});
