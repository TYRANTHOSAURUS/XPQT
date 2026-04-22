import type { CaseOwnerPolicyDefinition, NormalizedRoutingContext } from '@prequest/shared';
import { CaseOwnerEngineService } from './case-owner-engine.service';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const RT = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const NL_COUNTRY = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';
const AMS_CAMPUS = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const FR_COUNTRY = 'e5f6a7b8-c9d0-4e1f-9012-3456789abcde';
const IT_DOMAIN = 'f6a7b8c9-d0e1-4f23-a012-3456789abcde';
const FM_DOMAIN = 'a7b8c9d0-e1f2-4345-9012-3456789abcde';

const TEAM_GLOBAL = '11111111-2222-4333-9444-555555555555';
const TEAM_NL = '22222222-3333-4444-9555-666666666666';
const TEAM_AMS = '33333333-4444-4555-9666-777777777777';
const TEAM_FR = '44444444-5555-4666-9777-888888888888';
const TEAM_AFTERHOURS = '55555555-6666-4777-9888-999999999999';

function ctx(overrides: Partial<NormalizedRoutingContext> = {}): NormalizedRoutingContext {
  return {
    tenant_id: TENANT,
    request_type_id: RT,
    domain_id: IT_DOMAIN,
    priority: 'normal',
    location_id: AMS_CAMPUS,
    asset_id: null,
    scope_source: 'selected',
    operational_scope_id: AMS_CAMPUS,
    operational_scope_chain: [AMS_CAMPUS, NL_COUNTRY],
    evaluated_at: '2026-04-21T10:00:00.000Z',
    active_support_window_id: null,
    ...overrides,
  };
}

function policy(overrides: Partial<CaseOwnerPolicyDefinition> = {}): CaseOwnerPolicyDefinition {
  return {
    schema_version: 1,
    request_type_id: RT,
    scope_source: 'selected',
    rows: [],
    default_target: { kind: 'team', team_id: TEAM_GLOBAL },
    ...overrides,
  };
}

describe('CaseOwnerEngineService', () => {
  const engine = new CaseOwnerEngineService();

  it('returns default_target when no rows match', () => {
    const result = engine.evaluate(ctx(), policy());
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_GLOBAL });
    expect(result.matched_row_id).toBe('default');
    expect(result.trace[result.trace.length - 1].step).toBe('policy_default');
  });

  it('matches on a single operational_scope_id', () => {
    const result = engine.evaluate(
      ctx(),
      policy({
        rows: [
          {
            id: 'row-nl',
            match: { operational_scope_ids: [NL_COUNTRY] },
            target: { kind: 'team', team_id: TEAM_NL },
            ordering_hint: 0,
          },
        ],
      }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_NL });
    expect(result.matched_row_id).toBe('row-nl');
  });

  it('picks most-specific row first when ordering_hint differentiates them', () => {
    // Both rows match the Amsterdam chain [AMS_CAMPUS, NL_COUNTRY].
    // Amsterdam row has ordering_hint = 0 (most specific).
    const result = engine.evaluate(
      ctx(),
      policy({
        rows: [
          {
            id: 'row-nl',
            match: { operational_scope_ids: [NL_COUNTRY] },
            target: { kind: 'team', team_id: TEAM_NL },
            ordering_hint: 10,
          },
          {
            id: 'row-ams',
            match: { operational_scope_ids: [AMS_CAMPUS] },
            target: { kind: 'team', team_id: TEAM_AMS },
            ordering_hint: 0,
          },
        ],
      }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_AMS });
    expect(result.matched_row_id).toBe('row-ams');
  });

  it('skips non-matching rows and records them in the trace', () => {
    const result = engine.evaluate(
      ctx(),
      policy({
        rows: [
          {
            id: 'row-fr',
            match: { operational_scope_ids: [FR_COUNTRY] },
            target: { kind: 'team', team_id: TEAM_FR },
            ordering_hint: 0,
          },
          {
            id: 'row-nl',
            match: { operational_scope_ids: [NL_COUNTRY] },
            target: { kind: 'team', team_id: TEAM_NL },
            ordering_hint: 1,
          },
        ],
      }),
    );
    expect(result.target).toEqual({ kind: 'team', team_id: TEAM_NL });
    const frEntry = result.trace.find((t) => t.reason.includes(FR_COUNTRY));
    expect(frEntry?.matched).toBe(false);
  });

  it('AND-combines match clauses — domain mismatch fails an otherwise-valid scope row', () => {
    const result = engine.evaluate(
      ctx({ domain_id: FM_DOMAIN }),
      policy({
        rows: [
          {
            id: 'row-nl-it',
            match: { operational_scope_ids: [NL_COUNTRY], domain_ids: [IT_DOMAIN] },
            target: { kind: 'team', team_id: TEAM_NL },
            ordering_hint: 0,
          },
        ],
      }),
    );
    // Scope matches but domain doesn't → falls through to default.
    expect(result.matched_row_id).toBe('default');
  });

  it('null context.domain_id fails any domain_ids clause (dual-run unbackfilled tenant)', () => {
    const result = engine.evaluate(
      ctx({ domain_id: null }),
      policy({
        rows: [
          {
            id: 'row-it',
            match: { domain_ids: [IT_DOMAIN] },
            target: { kind: 'team', team_id: TEAM_NL },
            ordering_hint: 0,
          },
        ],
      }),
    );
    expect(result.matched_row_id).toBe('default');
  });

  it('support_window_id drives business-hours vs after-hours ownership', () => {
    const AFTER_HOURS = 'after_hours';
    const p = policy({
      rows: [
        {
          id: 'row-ah',
          match: { operational_scope_ids: [NL_COUNTRY], support_window_id: AFTER_HOURS },
          target: { kind: 'team', team_id: TEAM_AFTERHOURS },
          ordering_hint: 0,
        },
        {
          id: 'row-bh',
          match: { operational_scope_ids: [NL_COUNTRY] },
          target: { kind: 'team', team_id: TEAM_NL },
          ordering_hint: 10,
        },
      ],
    });

    const bh = engine.evaluate(ctx({ active_support_window_id: null }), p);
    expect(bh.target).toEqual({ kind: 'team', team_id: TEAM_NL });

    const ah = engine.evaluate(ctx({ active_support_window_id: AFTER_HOURS }), p);
    expect(ah.target).toEqual({ kind: 'team', team_id: TEAM_AFTERHOURS });
  });

  it('trace is chronological — non-match entries appear before the winning match', () => {
    const result = engine.evaluate(
      ctx(),
      policy({
        rows: [
          { id: 'miss-1', match: { operational_scope_ids: [FR_COUNTRY] }, target: { kind: 'team', team_id: TEAM_FR }, ordering_hint: 0 },
          { id: 'miss-2', match: { domain_ids: [FM_DOMAIN] }, target: { kind: 'team', team_id: TEAM_GLOBAL }, ordering_hint: 1 },
          { id: 'hit', match: { operational_scope_ids: [NL_COUNTRY] }, target: { kind: 'team', team_id: TEAM_NL }, ordering_hint: 2 },
        ],
      }),
    );
    expect(result.trace.map((t) => t.matched)).toEqual([false, false, true]);
    expect(result.trace[2].target).toEqual({ kind: 'team', team_id: TEAM_NL });
  });
});
