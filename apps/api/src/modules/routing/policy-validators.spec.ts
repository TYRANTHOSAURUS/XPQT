import {
  parsePolicyDefinition,
  CaseOwnerPolicyDefinitionSchema,
  ChildDispatchPolicyDefinitionSchema,
  SpaceLevelsDefinitionSchema,
} from './policy-validators';

describe('routing policy validators', () => {
  // Valid RFC 4122 v4 UUIDs (strict zod check requires real version nibble).
  const uuid = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
  const uuid2 = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
  const uuid3 = 'c3d4e5f6-a7b8-4c9d-9ef0-123456789abc';

  describe('case_owner_policy', () => {
    it('accepts a minimal valid policy (default target only)', () => {
      const result = parsePolicyDefinition('case_owner_policy', {
        schema_version: 1,
        request_type_id: uuid,
        scope_source: 'requester_home',
        rows: [],
        default_target: { kind: 'team', team_id: uuid2 },
      });
      expect(result.default_target.team_id).toBe(uuid2);
    });

    it('rejects unknown scope_source', () => {
      expect(() =>
        parsePolicyDefinition('case_owner_policy', {
          schema_version: 1,
          request_type_id: uuid,
          scope_source: 'made_up',
          rows: [],
          default_target: { kind: 'team', team_id: uuid2 },
        }),
      ).toThrow();
    });

    it('rejects row whose target kind is not "team"', () => {
      // Vendors cannot own the parent case per the plan's design principle #2.
      expect(() =>
        CaseOwnerPolicyDefinitionSchema.parse({
          schema_version: 1,
          request_type_id: uuid,
          scope_source: 'selected',
          rows: [
            {
              id: uuid3,
              match: {},
              target: { kind: 'vendor', vendor_id: uuid2 },
              ordering_hint: 0,
            },
          ],
          default_target: { kind: 'team', team_id: uuid2 },
        }),
      ).toThrow();
    });

    it('rejects malformed UUID', () => {
      expect(() =>
        parsePolicyDefinition('case_owner_policy', {
          schema_version: 1,
          request_type_id: 'not-a-uuid',
          scope_source: 'requester_home',
          rows: [],
          default_target: { kind: 'team', team_id: uuid2 },
        }),
      ).toThrow();
    });
  });

  describe('child_dispatch_policy', () => {
    it('accepts fixed dispatch with team target', () => {
      const result = parsePolicyDefinition('child_dispatch_policy', {
        schema_version: 1,
        request_type_id: uuid,
        dispatch_mode: 'always',
        split_strategy: 'single',
        execution_routing: 'fixed',
        fixed_target: { kind: 'team', id: uuid2 },
      });
      expect(result.execution_routing).toBe('fixed');
    });

    it('accepts vendor execution target — vendors are first-class for child dispatch', () => {
      const result = ChildDispatchPolicyDefinitionSchema.parse({
        schema_version: 1,
        request_type_id: uuid,
        dispatch_mode: 'always',
        split_strategy: 'per_vendor_service',
        execution_routing: 'fixed',
        fixed_target: { kind: 'vendor', id: uuid2 },
      });
      expect(result.fixed_target?.kind).toBe('vendor');
    });

    it('rejects unknown split_strategy', () => {
      expect(() =>
        parsePolicyDefinition('child_dispatch_policy', {
          schema_version: 1,
          request_type_id: uuid,
          dispatch_mode: 'always',
          split_strategy: 'per_galaxy',
          execution_routing: 'fixed',
        }),
      ).toThrow();
    });
  });

  describe('space_levels', () => {
    it('accepts typical 5-level tree', () => {
      const result = SpaceLevelsDefinitionSchema.parse({
        schema_version: 1,
        levels: [
          { depth: 0, key: 'country', display_name: 'Country', is_operational_scope: true },
          { depth: 1, key: 'campus', display_name: 'Campus', is_operational_scope: true },
          { depth: 2, key: 'building', display_name: 'Building', is_operational_scope: true },
          { depth: 3, key: 'floor', display_name: 'Floor', is_operational_scope: false },
          { depth: 4, key: 'room', display_name: 'Room', is_operational_scope: false },
        ],
      });
      expect(result.levels).toHaveLength(5);
    });

    it('rejects negative depth', () => {
      expect(() =>
        parsePolicyDefinition('space_levels', {
          schema_version: 1,
          levels: [{ depth: -1, key: 'x', display_name: 'x', is_operational_scope: true }],
        }),
      ).toThrow();
    });
  });
});
