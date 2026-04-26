// Compile-time + structural sanity for the seven v1 service rule templates
// landed in migration 00149. The actual seed contents are not refetched
// here — see scripts/verify-service-rule-templates.sql for the runtime
// remote check (verified at deploy time).

const EXPECTED_KEYS = [
  'per_item_lead_time',
  'cost_threshold_approval',
  'external_vendor_approval',
  'cost_center_owner_approval',
  'item_blackout',
  'role_restricted_item',
  'min_attendee_for_item',
];

const EXPECTED_BY_CATEGORY: Record<string, string[]> = {
  capacity: ['per_item_lead_time', 'min_attendee_for_item'],
  approval: ['cost_threshold_approval', 'external_vendor_approval', 'cost_center_owner_approval'],
  availability: ['item_blackout', 'role_restricted_item'],
};

describe('service rule templates seed (00149)', () => {
  it('expects exactly 7 v1 templates', () => {
    expect(EXPECTED_KEYS).toHaveLength(7);
  });

  it('every key is in exactly one category bucket', () => {
    const seen = new Set<string>();
    for (const list of Object.values(EXPECTED_BY_CATEGORY)) {
      for (const k of list) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
    expect(seen.size).toBe(EXPECTED_KEYS.length);
  });

  // The remote DB pass is verified at migration apply time via the smoke
  // query in 00149 (counts and shapes). These are placeholders for an
  // integration test that hits a Supabase test instance.
  it.todo('every template`s applies_when_template is a valid Predicate (engine.validate)');
  it.todo('every template`s param_specs is a non-empty array (except cost_center_owner_approval)');
});
