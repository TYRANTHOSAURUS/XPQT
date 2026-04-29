import { bucketRulesBySpecificity } from './service-rule-resolver.service';
import type { ServiceRuleRow } from './dto/types';

const baseRule = (overrides: Partial<ServiceRuleRow>): ServiceRuleRow => ({
  id: overrides.id ?? `rule-${Math.random()}`,
  tenant_id: 't1',
  name: 'r',
  description: null,
  target_kind: 'tenant',
  target_id: null,
  applies_when: {},
  effect: 'warn',
  approval_config: null,
  denial_message: null,
  priority: 100,
  active: true,
  template_id: null,
  requires_internal_setup: false,
  internal_setup_lead_time_minutes: null,
  ...overrides,
});

describe('ServiceRuleResolverService', () => {
  describe('bucketRulesBySpecificity', () => {
    const line = {
      catalog_item_id: 'item-1',
      catalog_item_category: 'food_and_drinks',
      menu_id: 'menu-1',
    };

    it('puts catalog_item rules in bucket 1 when target_id matches', () => {
      const r = baseRule({ target_kind: 'catalog_item', target_id: 'item-1' });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.get(1)).toEqual([r]);
    });

    it('puts menu rules in bucket 2 when menu matches', () => {
      const r = baseRule({ target_kind: 'menu', target_id: 'menu-1' });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.get(2)).toEqual([r]);
    });

    it('puts catalog_category rules in bucket 3 when category matches', () => {
      const r = baseRule({ target_kind: 'catalog_category', target_id: 'food_and_drinks' });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.get(3)).toEqual([r]);
    });

    it('puts tenant rules in bucket 4 unconditionally', () => {
      const r = baseRule({ target_kind: 'tenant', target_id: null });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.get(4)).toEqual([r]);
    });

    it('skips inactive rules', () => {
      const r = baseRule({ target_kind: 'tenant', active: false });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.size).toBe(0);
    });

    it('catalog_item rule does not match a different item', () => {
      const r = baseRule({ target_kind: 'catalog_item', target_id: 'other-item' });
      const buckets = bucketRulesBySpecificity([r], line);
      expect(buckets.size).toBe(0);
    });

    it('menu rule does not match when line has no menu', () => {
      const r = baseRule({ target_kind: 'menu', target_id: 'menu-1' });
      const buckets = bucketRulesBySpecificity([r], { ...line, menu_id: null });
      expect(buckets.size).toBe(0);
    });

    it('catalog_category rule does not match when line category is null', () => {
      const r = baseRule({ target_kind: 'catalog_category', target_id: 'food_and_drinks' });
      const buckets = bucketRulesBySpecificity([r], { ...line, catalog_item_category: null });
      expect(buckets.size).toBe(0);
    });

    it('mixed rules land in correct buckets simultaneously', () => {
      const item = baseRule({ id: 'a', target_kind: 'catalog_item', target_id: 'item-1' });
      const menu = baseRule({ id: 'b', target_kind: 'menu', target_id: 'menu-1' });
      const cat = baseRule({ id: 'c', target_kind: 'catalog_category', target_id: 'food_and_drinks' });
      const tenant = baseRule({ id: 'd', target_kind: 'tenant' });
      const buckets = bucketRulesBySpecificity([item, menu, cat, tenant], line);
      expect(buckets.get(1)).toEqual([item]);
      expect(buckets.get(2)).toEqual([menu]);
      expect(buckets.get(3)).toEqual([cat]);
      expect(buckets.get(4)).toEqual([tenant]);
    });
  });

  // Behavioural specs that need a real Supabase client live in the integration
  // suite; these stay it.todo so they're tracked but don't run in the unit
  // pass.
  describe('resolveBulk (integration)', () => {
    it.todo('returns no-match for booking.* paths when reservation is absent');
    it.todo('honors specificity when sorting matches: item beats menu beats category beats tenant');
    it.todo('logs and returns no-match for malformed predicates');
    it.todo('aggregates effects: deny > require_approval > warn > allow_override > allow');
  });
});
