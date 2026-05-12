/**
 * Unit tests for `../edit-plan-helpers` (B.4 step 2D-C).
 *
 * Coverage:
 *   - `computeCostFromHours` — null rate, valid window, zero/negative
 *     window, NUMERIC(10,2) string round-trip preserved.
 *   - `canonicalApproverSort` — sort stability, non-mutation, type then id
 *     ordering.
 *   - `chainConfigsEqual` — null/null, null/non-null, threshold flip,
 *     order-only difference (must equal), member difference, default
 *     threshold (`'all'`).
 *   - `loadCurrentApprovalChain` — empty rows → null, single chain, two
 *     chains pick newest, parallel_group → 'all' vs 'any', error → null.
 *   - `computeRuleOutcomeFingerprint` — deterministic, key reorder
 *     stable, effect change flips, approver order does NOT flip.
 */

import {
  canonicalApproverSort,
  chainConfigsEqual,
  computeCostFromHours,
  computeRuleOutcomeFingerprint,
  loadCurrentApprovalChain,
  type Approver,
} from '../edit-plan-helpers';
import type { ApprovalConfig } from '../../room-booking-rules/dto';
import type { ResolveOutcome } from '../../room-booking-rules/rule-resolver.service';

// ─────────────────────────────────────────────────────────────────────────
// computeCostFromHours
// ─────────────────────────────────────────────────────────────────────────

describe('computeCostFromHours', () => {
  it('returns null when costPerHour is null', () => {
    expect(computeCostFromHours(null, '2026-05-12T09:00:00Z', '2026-05-12T10:00:00Z')).toBeNull();
  });

  it('returns null when costPerHour is empty string', () => {
    expect(computeCostFromHours('', '2026-05-12T09:00:00Z', '2026-05-12T10:00:00Z')).toBeNull();
  });

  it('computes hourly cost rounded to 2dp string', () => {
    expect(computeCostFromHours('60', '2026-05-12T09:00:00Z', '2026-05-12T10:00:00Z')).toBe('60.00');
  });

  it('computes 30-minute cost (half-hour proration)', () => {
    expect(computeCostFromHours('60', '2026-05-12T09:00:00Z', '2026-05-12T09:30:00Z')).toBe('30.00');
  });

  it('handles fractional rate (mirrors JS toFixed behaviour)', () => {
    // 12.34 * (45 / 60) = 9.255 in math, but the IEEE-754 product is just
    // shy of 9.255, so toFixed(2) rounds DOWN to '9.25'. We pin the exact
    // string the create path produces (booking-flow.service.ts:1252) so
    // the edit path matches its byte-for-byte snapshot.
    expect(computeCostFromHours('12.34', '2026-05-12T09:00:00Z', '2026-05-12T09:45:00Z')).toBe('9.25');
  });

  it('returns null on inverted window (end <= start)', () => {
    expect(computeCostFromHours('60', '2026-05-12T10:00:00Z', '2026-05-12T09:00:00Z')).toBeNull();
    expect(computeCostFromHours('60', '2026-05-12T10:00:00Z', '2026-05-12T10:00:00Z')).toBeNull();
  });

  it('returns null on unparseable ISO', () => {
    expect(computeCostFromHours('60', 'not-a-date', '2026-05-12T10:00:00Z')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// canonicalApproverSort
// ─────────────────────────────────────────────────────────────────────────

describe('canonicalApproverSort', () => {
  it('returns a new array (does not mutate input)', () => {
    const input: Approver[] = [
      { type: 'team', id: 'b' },
      { type: 'person', id: 'a' },
    ];
    const sorted = canonicalApproverSort(input);
    expect(sorted).not.toBe(input);
    expect(input[0]).toEqual({ type: 'team', id: 'b' });
  });

  it('orders person before team', () => {
    const sorted = canonicalApproverSort([
      { type: 'team', id: 'a' },
      { type: 'person', id: 'a' },
    ]);
    expect(sorted).toEqual([
      { type: 'person', id: 'a' },
      { type: 'team', id: 'a' },
    ]);
  });

  it('within type, orders by id lexicographically', () => {
    const sorted = canonicalApproverSort([
      { type: 'person', id: 'c' },
      { type: 'person', id: 'a' },
      { type: 'person', id: 'b' },
    ]);
    expect(sorted.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('handles empty input', () => {
    expect(canonicalApproverSort([])).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// chainConfigsEqual
// ─────────────────────────────────────────────────────────────────────────

describe('chainConfigsEqual', () => {
  it('null vs null is equal', () => {
    expect(chainConfigsEqual(null, null)).toBe(true);
  });

  it('null vs non-null is different', () => {
    expect(
      chainConfigsEqual(null, { required_approvers: [{ type: 'person', id: 'a' }], threshold: 'all' }),
    ).toBe(false);
    expect(
      chainConfigsEqual({ required_approvers: [{ type: 'person', id: 'a' }], threshold: 'all' }, null),
    ).toBe(false);
  });

  it('same approvers in different order are equal', () => {
    const a: ApprovalConfig = {
      required_approvers: [
        { type: 'team', id: 'beta' },
        { type: 'person', id: 'alpha' },
      ],
      threshold: 'all',
    };
    const b: ApprovalConfig = {
      required_approvers: [
        { type: 'person', id: 'alpha' },
        { type: 'team', id: 'beta' },
      ],
      threshold: 'all',
    };
    expect(chainConfigsEqual(a, b)).toBe(true);
  });

  it('threshold flip is different', () => {
    const a: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'x' }],
      threshold: 'all',
    };
    const b: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'x' }],
      threshold: 'any',
    };
    expect(chainConfigsEqual(a, b)).toBe(false);
  });

  it('different approver set is different', () => {
    const a: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'a' }],
      threshold: 'all',
    };
    const b: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'b' }],
      threshold: 'all',
    };
    expect(chainConfigsEqual(a, b)).toBe(false);
  });

  it('treats missing threshold as default "all"', () => {
    const a: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'x' }],
    };
    const b: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'x' }],
      threshold: 'all',
    };
    expect(chainConfigsEqual(a, b)).toBe(true);
  });

  it('different cardinality is different', () => {
    const a: ApprovalConfig = {
      required_approvers: [{ type: 'person', id: 'x' }],
      threshold: 'all',
    };
    const b: ApprovalConfig = {
      required_approvers: [
        { type: 'person', id: 'x' },
        { type: 'person', id: 'y' },
      ],
      threshold: 'all',
    };
    expect(chainConfigsEqual(a, b)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// loadCurrentApprovalChain
// ─────────────────────────────────────────────────────────────────────────

describe('loadCurrentApprovalChain', () => {
  const TENANT = 't1';
  const BOOKING = '4d4d4d4d-4d4d-4d4d-4d4d-4d4d4d4d4d4d';

  function makeSupabase(rows: unknown[] | { error: { message: string } }) {
    const select = jest.fn().mockReturnThis();
    const builder: Record<string, jest.Mock> = {
      select,
      eq: jest.fn().mockReturnThis(),
    };
    // Final await consumes the "thenable" — return data/error per the rows arg.
    (builder as unknown as PromiseLike<unknown>).then = (resolve: (v: unknown) => unknown) => {
      if ('error' in (rows as object)) {
        return Promise.resolve(resolve({ data: null, error: (rows as { error: unknown }).error }));
      }
      return Promise.resolve(resolve({ data: rows, error: null }));
    };
    const admin = {
      from: jest.fn(() => builder),
    };
    return { admin } as never;
  }

  it('returns null when no rows', async () => {
    const sb = makeSupabase([]);
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    expect(result).toBeNull();
  });

  it('returns null on supabase error', async () => {
    const sb = makeSupabase({ error: { message: 'rls denied' } });
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    expect(result).toBeNull();
  });

  it('aggregates a single chain with parallel_group → threshold "all"', async () => {
    const sb = makeSupabase([
      {
        approval_chain_id: 'chain-1',
        parallel_group: `parallel-${BOOKING}`,
        approver_person_id: 'p1',
        approver_team_id: null,
        created_at: '2026-05-12T09:00:00Z',
        status: 'pending',
      },
      {
        approval_chain_id: 'chain-1',
        parallel_group: `parallel-${BOOKING}`,
        approver_person_id: null,
        approver_team_id: 't1',
        created_at: '2026-05-12T09:00:00Z',
        status: 'pending',
      },
    ]);
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    expect(result).not.toBeNull();
    expect(result?.threshold).toBe('all');
    expect(result?.required_approvers).toEqual(
      expect.arrayContaining([
        { type: 'person', id: 'p1' },
        { type: 'team', id: 't1' },
      ]),
    );
    expect(result?.required_approvers).toHaveLength(2);
  });

  it('aggregates a single chain with NULL parallel_group → threshold "any"', async () => {
    const sb = makeSupabase([
      {
        approval_chain_id: 'chain-1',
        parallel_group: null,
        approver_person_id: 'p1',
        approver_team_id: null,
        created_at: '2026-05-12T09:00:00Z',
        status: 'pending',
      },
    ]);
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    expect(result?.threshold).toBe('any');
    expect(result?.required_approvers).toEqual([{ type: 'person', id: 'p1' }]);
  });

  it('picks the newest chain when two chains exist (older one expired)', async () => {
    const sb = makeSupabase([
      {
        approval_chain_id: 'old-chain',
        parallel_group: null,
        approver_person_id: 'p_old',
        approver_team_id: null,
        created_at: '2026-05-10T09:00:00Z',
        status: 'expired',
      },
      {
        approval_chain_id: 'new-chain',
        parallel_group: null,
        approver_person_id: 'p_new',
        approver_team_id: null,
        created_at: '2026-05-12T09:00:00Z',
        status: 'pending',
      },
    ]);
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    expect(result?.required_approvers).toEqual([{ type: 'person', id: 'p_new' }]);
  });

  it('skips rows with neither approver set (corrupted row)', async () => {
    const sb = makeSupabase([
      {
        approval_chain_id: 'chain-1',
        parallel_group: null,
        approver_person_id: null,
        approver_team_id: null,
        created_at: '2026-05-12T09:00:00Z',
        status: 'pending',
      },
    ]);
    const result = await loadCurrentApprovalChain(sb, BOOKING, TENANT);
    // All rows skipped → required_approvers empty → returns null
    expect(result).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// computeRuleOutcomeFingerprint
// ─────────────────────────────────────────────────────────────────────────

describe('computeRuleOutcomeFingerprint', () => {
  function makeOutcome(overrides: Partial<ResolveOutcome> = {}): ResolveOutcome {
    return {
      effects: [],
      matchedRules: [],
      warnings: [],
      denialMessages: [],
      overridable: false,
      approvalConfig: null,
      final: 'allow',
      ...overrides,
    };
  }

  it('returns a 64-char hex digest', () => {
    const fp = computeRuleOutcomeFingerprint(makeOutcome());
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same outcome', () => {
    const a = computeRuleOutcomeFingerprint(makeOutcome({ final: 'require_approval' }));
    const b = computeRuleOutcomeFingerprint(makeOutcome({ final: 'require_approval' }));
    expect(a).toBe(b);
  });

  it('is stable when matched rule order differs', () => {
    const a = computeRuleOutcomeFingerprint(
      makeOutcome({
        matchedRules: [
          { id: 'r1' } as never,
          { id: 'r2' } as never,
        ],
      }),
    );
    const b = computeRuleOutcomeFingerprint(
      makeOutcome({
        matchedRules: [
          { id: 'r2' } as never,
          { id: 'r1' } as never,
        ],
      }),
    );
    expect(a).toBe(b);
  });

  it('is stable when approver order differs', () => {
    const a = computeRuleOutcomeFingerprint(
      makeOutcome({
        approvalConfig: {
          required_approvers: [
            { type: 'team', id: 'b' },
            { type: 'person', id: 'a' },
          ],
          threshold: 'all',
        },
      }),
    );
    const b = computeRuleOutcomeFingerprint(
      makeOutcome({
        approvalConfig: {
          required_approvers: [
            { type: 'person', id: 'a' },
            { type: 'team', id: 'b' },
          ],
          threshold: 'all',
        },
      }),
    );
    expect(a).toBe(b);
  });

  it('flips when final outcome changes', () => {
    const a = computeRuleOutcomeFingerprint(makeOutcome({ final: 'allow' }));
    const b = computeRuleOutcomeFingerprint(makeOutcome({ final: 'require_approval' }));
    expect(a).not.toBe(b);
  });

  it('flips when threshold changes', () => {
    const a = computeRuleOutcomeFingerprint(
      makeOutcome({
        approvalConfig: { required_approvers: [{ type: 'person', id: 'x' }], threshold: 'all' },
      }),
    );
    const b = computeRuleOutcomeFingerprint(
      makeOutcome({
        approvalConfig: { required_approvers: [{ type: 'person', id: 'x' }], threshold: 'any' },
      }),
    );
    expect(a).not.toBe(b);
  });

  it('flips when effects set changes', () => {
    const a = computeRuleOutcomeFingerprint(makeOutcome({ effects: ['warn'] }));
    const b = computeRuleOutcomeFingerprint(makeOutcome({ effects: ['deny'] }));
    expect(a).not.toBe(b);
  });

  it('is stable when effect order changes (set semantics)', () => {
    const a = computeRuleOutcomeFingerprint(makeOutcome({ effects: ['warn', 'allow_override'] }));
    const b = computeRuleOutcomeFingerprint(makeOutcome({ effects: ['allow_override', 'warn'] }));
    expect(a).toBe(b);
  });
});
