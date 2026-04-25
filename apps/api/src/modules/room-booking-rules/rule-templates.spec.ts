import { BadRequestException } from '@nestjs/common';
import { getTemplate, listTemplates, RULE_TEMPLATES } from './rule-templates';
import { PredicateEngineService } from './predicate-engine.service';

describe('rule templates', () => {
  const engine = new PredicateEngineService({} as never);

  it('lists exactly 12 templates', () => {
    expect(RULE_TEMPLATES).toHaveLength(12);
    expect(listTemplates()).toHaveLength(12);
  });

  it('every template has unique id', () => {
    const ids = new Set(RULE_TEMPLATES.map((t) => t.id));
    expect(ids.size).toBe(RULE_TEMPLATES.length);
  });

  describe('compile output is a valid predicate for each template', () => {
    const cases: Array<{ id: string; params: Record<string, unknown> }> = [
      { id: 'restrict_to_roles', params: { role_ids: ['r-vp'] } },
      { id: 'restrict_to_org_subtree', params: { org_node_id: 'node-eng' } },
      { id: 'off_hours_need_approval', params: { calendar_id: 'cal-1' } },
      { id: 'min_lead_time', params: { interval_minutes: 60 } },
      { id: 'max_lead_time', params: { interval_minutes: 60 * 24 * 90 } },
      { id: 'max_duration', params: { interval_minutes: 480 } },
      { id: 'capacity_tolerance', params: { factor: 1.2, mode: 'warn' } },
      { id: 'long_bookings_need_manager_approval', params: { interval_minutes: 240 } },
      { id: 'high_capacity_needs_vp_approval', params: { attendee_threshold: 50 } },
      { id: 'capacity_floor', params: {} },
      { id: 'soft_over_capacity_warning', params: {} },
      { id: 'service_desk_override_allow', params: {} },
    ];

    for (const c of cases) {
      it(`${c.id} compiles to a valid predicate`, () => {
        const tpl = getTemplate(c.id);
        const compiled = tpl.compile(c.params);
        expect(compiled.applies_when).toBeDefined();
        expect(compiled.effect).toBeDefined();
        expect(() => engine.validate(compiled.applies_when)).not.toThrow();
      });
    }
  });

  it('throws on missing required param', () => {
    expect(() => getTemplate('restrict_to_roles').compile({})).toThrow(BadRequestException);
    expect(() => getTemplate('min_lead_time').compile({})).toThrow(BadRequestException);
  });

  it('capacity_tolerance rejects invalid mode', () => {
    expect(() => getTemplate('capacity_tolerance').compile({ factor: 1.2, mode: 'foo' })).toThrow();
  });

  it('getTemplate throws on unknown id', () => {
    expect(() => getTemplate('nope')).toThrow(BadRequestException);
  });
});
