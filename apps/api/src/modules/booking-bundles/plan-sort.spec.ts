import {
  comparePlanApprovals,
  comparePlanAssetReservations,
  comparePlanOrderLineItems,
  comparePlanOrders,
  comparePlanSlots,
  planSort,
} from './plan-sort';

describe('planSort canonical comparators', () => {
  describe('slots', () => {
    it('sorts by display_order ascending', () => {
      const input = [
        { display_order: 2, space_id: 'a', start_at: '2026-05-04T11:00:00Z' },
        { display_order: 0, space_id: 'a', start_at: '2026-05-04T10:00:00Z' },
        { display_order: 1, space_id: 'a', start_at: '2026-05-04T10:30:00Z' },
      ];
      const sorted = [...input].sort(comparePlanSlots);
      expect(sorted.map((s) => s.display_order)).toEqual([0, 1, 2]);
    });

    it('breaks ties on (space_id, start_at)', () => {
      const input = [
        { display_order: 0, space_id: 'b', start_at: '2026-05-04T10:00:00Z' },
        { display_order: 0, space_id: 'a', start_at: '2026-05-04T11:00:00Z' },
        { display_order: 0, space_id: 'a', start_at: '2026-05-04T10:00:00Z' },
      ];
      const sorted = [...input].sort(comparePlanSlots);
      expect(sorted.map((s) => `${s.space_id}|${s.start_at}`)).toEqual([
        'a|2026-05-04T10:00:00Z',
        'a|2026-05-04T11:00:00Z',
        'b|2026-05-04T10:00:00Z',
      ]);
    });
  });

  describe('orders', () => {
    it('sorts by service_type alphabetically', () => {
      const input = [
        { service_type: 'catering' },
        { service_type: 'av_setup' },
        { service_type: 'parking' },
      ];
      const sorted = [...input].sort(comparePlanOrders);
      expect(sorted.map((o) => o.service_type)).toEqual(['av_setup', 'catering', 'parking']);
    });
  });

  describe('order_line_items', () => {
    it('sorts by client_line_id', () => {
      const input = [
        { client_line_id: 'line-c' },
        { client_line_id: 'line-a' },
        { client_line_id: 'line-b' },
      ];
      const sorted = [...input].sort(comparePlanOrderLineItems);
      expect(sorted.map((l) => l.client_line_id)).toEqual(['line-a', 'line-b', 'line-c']);
    });

    it('throws when any client_line_id is missing', () => {
      const a = { client_line_id: 'line-a' };
      const empty = { client_line_id: '' };
      expect(() => comparePlanOrderLineItems(a, empty)).toThrow(/client_line_id_required/);
      expect(() => comparePlanOrderLineItems(empty, a)).toThrow(/client_line_id_required/);
    });
  });

  describe('asset_reservations', () => {
    it('sorts by client_line_id (the OLI it attaches to)', () => {
      const input = [
        { client_line_id: 'line-z' },
        { client_line_id: 'line-a' },
      ];
      const sorted = [...input].sort(comparePlanAssetReservations);
      expect(sorted.map((a) => a.client_line_id)).toEqual(['line-a', 'line-z']);
    });

    it('throws when any client_line_id is missing', () => {
      const a = { client_line_id: 'line-a' };
      const empty = { client_line_id: '' };
      expect(() => comparePlanAssetReservations(a, empty)).toThrow(/client_line_id_required/);
    });
  });

  describe('approvals', () => {
    it('sorts by approver_person_id', () => {
      const input = [
        { approver_person_id: 'person-z' },
        { approver_person_id: 'person-a' },
        { approver_person_id: 'person-m' },
      ];
      const sorted = [...input].sort(comparePlanApprovals);
      expect(sorted.map((a) => a.approver_person_id)).toEqual(['person-a', 'person-m', 'person-z']);
    });
  });

  describe('determinism — shuffled input → identical sorted output', () => {
    it('OLIs sorted identically regardless of input order', () => {
      const lines = [
        { client_line_id: 'line-a' },
        { client_line_id: 'line-b' },
        { client_line_id: 'line-c' },
        { client_line_id: 'line-d' },
      ];
      const sortedA = [...lines].sort(comparePlanOrderLineItems);
      const sortedB = [...lines].reverse().sort(comparePlanOrderLineItems);
      const sortedC = [lines[2], lines[0], lines[3], lines[1]].sort(comparePlanOrderLineItems);
      expect(sortedA).toEqual(sortedB);
      expect(sortedA).toEqual(sortedC);
    });

    it('orders sorted identically regardless of input order', () => {
      const orders = [
        { service_type: 'catering' },
        { service_type: 'av_setup' },
        { service_type: 'parking' },
      ];
      const sortedA = [...orders].sort(comparePlanOrders);
      const sortedB = [...orders].reverse().sort(comparePlanOrders);
      expect(sortedA).toEqual(sortedB);
    });
  });

  describe('planSort namespace', () => {
    it('exposes every comparator', () => {
      expect(planSort.slots).toBe(comparePlanSlots);
      expect(planSort.orders).toBe(comparePlanOrders);
      expect(planSort.olis).toBe(comparePlanOrderLineItems);
      expect(planSort.assetReservations).toBe(comparePlanAssetReservations);
      expect(planSort.approvals).toBe(comparePlanApprovals);
    });
  });
});
