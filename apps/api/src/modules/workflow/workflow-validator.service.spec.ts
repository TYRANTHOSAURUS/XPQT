import { WorkflowValidatorService } from './workflow-validator.service';

describe('WorkflowValidatorService', () => {
  const svc = new WorkflowValidatorService();

  const mkNode = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, config });

  it('errors when no trigger', () => {
    const res = svc.validate({ nodes: [mkNode('e', 'end')], edges: [] });
    expect(res.ok).toBe(false);
    expect(res.errors.find((e) => e.code === 'NO_TRIGGER')).toBeDefined();
  });

  it('errors when no end', () => {
    const res = svc.validate({ nodes: [mkNode('t', 'trigger')], edges: [] });
    expect(res.errors.find((e) => e.code === 'NO_END')).toBeDefined();
  });

  it('errors on dangling edges', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'ghost' }],
    });
    expect(res.errors.find((e) => e.code === 'DANGLING_EDGE_TO')).toBeDefined();
  });

  it('errors on unreachable node', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('x', 'assign', { team_id: 'team1' }), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'UNREACHABLE')).toBeDefined();
  });

  it('requires true and false edges on condition nodes', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('c', 'condition', { field: 'priority', operator: 'equals', value: 'high' }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'c' }, { from: 'c', to: 'e', condition: 'true' }],
    });
    expect(res.errors.find((e) => e.code === 'MISSING_FALSE_EDGE')).toBeDefined();
  });

  it('passes a minimal valid graph', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('a', 'assign', { team_id: 'team1' }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it('errors on assign without team or user', () => {
    const res = svc.validate({
      nodes: [mkNode('t', 'trigger'), mkNode('a', 'assign', {}), mkNode('e', 'end')],
      edges: [{ from: 't', to: 'a' }, { from: 'a', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'ASSIGN_TARGET')).toBeDefined();
  });

  it('errors on timer with delay_minutes = 0', () => {
    const res = svc.validate({
      nodes: [
        mkNode('t', 'trigger'),
        mkNode('tm', 'timer', { delay_minutes: 0 }),
        mkNode('e', 'end'),
      ],
      edges: [{ from: 't', to: 'tm' }, { from: 'tm', to: 'e' }],
    });
    expect(res.errors.find((e) => e.code === 'TIMER_DELAY')).toBeDefined();
  });
});
