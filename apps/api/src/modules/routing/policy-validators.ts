// Workstream A / task WA-1: runtime validators for routing policy definitions.
// Schemas here are the canonical runtime check for anything stored in
// public.config_versions.definition for the routing-studio config types.
//
// Lives in apps/api (not @prequest/shared) because zod v4 is an ESM-only
// package. Re-exporting it from shared/src/index.ts flipped Node's loader
// into ESM mode for the whole monorepo and broke the API's CJS require
// chain (extensionless re-exports of './types/enums' fail ESM resolution).
// Types stay in @prequest/shared; validators live here.
//
// Types in @prequest/shared/types/routing.ts are hand-authored; we assert
// via generic constraints below that the inferred zod output is compatible.

import { z } from 'zod';

// Matches PostgreSQL's uuid type (8-4-4-4-12 hex, any version). Zod v4's
// `z.uuid()` is strict RFC 4122 — rejects version-nibble 0 and above 5 —
// but the existing seed data in this codebase uses placeholder UUIDs like
// '30000000-0000-0000-0000-000000000005' that Postgres accepts. The DB
// is the authority on what's a valid identifier, not RFC 4122.
const uuidString = () =>
  z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid uuid');
import type {
  CaseOwnerPolicyDefinition,
  ChildDispatchPolicyDefinition,
  SpaceLevelsDefinition,
} from '@prequest/shared';

const TeamTarget = z.object({
  kind: z.literal('team'),
  team_id: uuidString(),
});

const TeamOrVendorTarget = z.object({
  kind: z.enum(['team', 'vendor']),
  id: uuidString(),
});

const ScopeSource = z.enum([
  'requester_home',
  'selected',
  'asset_location',
  'business_unit',
  'legal_entity',
  'manual',
]);

// ─── Case owner policy ───────────────────────────────────────────────────────

export const CaseOwnerPolicyDefinitionSchema = z.object({
  schema_version: z.literal(1),
  request_type_id: uuidString(),
  scope_source: ScopeSource,
  rows: z.array(
    z.object({
      id: uuidString(),
      match: z.object({
        operational_scope_ids: z.array(uuidString()).optional(),
        domain_ids: z.array(uuidString()).optional(),
        support_window_id: z.string().nullable().optional(),
      }),
      target: TeamTarget,
      ordering_hint: z.number().int(),
    }),
  ),
  default_target: TeamTarget,
});

// ─── Child dispatch policy ───────────────────────────────────────────────────

export const ChildDispatchPolicyDefinitionSchema = z.object({
  schema_version: z.literal(1),
  request_type_id: uuidString(),
  dispatch_mode: z.enum(['none', 'optional', 'always', 'multi_template']),
  split_strategy: z.enum(['single', 'per_location', 'per_asset', 'per_vendor_service']),
  execution_routing: z.enum([
    'fixed',
    'by_asset',
    'by_location',
    'by_asset_then_location',
    'workflow',
  ]),
  fixed_target: TeamOrVendorTarget.optional(),
  fallback_target: TeamOrVendorTarget.optional(),
});

// ─── Space levels (Artifact B) ───────────────────────────────────────────────

export const SpaceLevelsDefinitionSchema = z.object({
  schema_version: z.literal(1),
  levels: z.array(
    z.object({
      depth: z.number().int().min(0),
      key: z.string().min(1),
      display_name: z.string().min(1),
      is_operational_scope: z.boolean(),
    }),
  ),
});

// ─── Domain registry payload ─────────────────────────────────────────────────
// The registry itself is a table (public.domains); the `domain_registry` config
// entity is a tenant-level meta entry that records default/root domains and
// which keys are canonical. Payload is intentionally minimal right now — the
// heavy lifting is in the SQL registry, not the policy blob.

export const DomainRegistryDefinitionSchema = z.object({
  schema_version: z.literal(1),
  default_domain_id: uuidString().nullable(),
  // Canonical display order for the Routing Map columns. All ids must exist
  // in public.domains; PolicyStoreService enforces this at write time.
  column_order: z.array(uuidString()),
});

// ─── Dispatch map ────────────────────────────────────────────────────────────

export const ROUTING_STUDIO_SCHEMAS = {
  case_owner_policy: CaseOwnerPolicyDefinitionSchema,
  child_dispatch_policy: ChildDispatchPolicyDefinitionSchema,
  space_levels: SpaceLevelsDefinitionSchema,
  domain_registry: DomainRegistryDefinitionSchema,
} as const;

export type RoutingStudioConfigType = keyof typeof ROUTING_STUDIO_SCHEMAS;

/**
 * Validate an arbitrary JSON payload as the definition for a given
 * routing-studio config type. Throws ZodError on mismatch.
 */
export function parsePolicyDefinition<T extends RoutingStudioConfigType>(
  config_type: T,
  payload: unknown,
): z.output<(typeof ROUTING_STUDIO_SCHEMAS)[T]> {
  const schema = ROUTING_STUDIO_SCHEMAS[config_type];
  return schema.parse(payload) as z.output<(typeof ROUTING_STUDIO_SCHEMAS)[T]>;
}

// ─── TS ↔ zod compatibility assertions ───────────────────────────────────────
// If a contract change breaks alignment, these fail to compile before runtime.

type _AssertCaseOwner = z.infer<typeof CaseOwnerPolicyDefinitionSchema> extends CaseOwnerPolicyDefinition
  ? CaseOwnerPolicyDefinition extends z.infer<typeof CaseOwnerPolicyDefinitionSchema>
    ? true
    : false
  : false;
type _AssertChildDispatch = z.infer<typeof ChildDispatchPolicyDefinitionSchema> extends ChildDispatchPolicyDefinition
  ? ChildDispatchPolicyDefinition extends z.infer<typeof ChildDispatchPolicyDefinitionSchema>
    ? true
    : false
  : false;
type _AssertSpaceLevels = z.infer<typeof SpaceLevelsDefinitionSchema> extends SpaceLevelsDefinition
  ? SpaceLevelsDefinition extends z.infer<typeof SpaceLevelsDefinitionSchema>
    ? true
    : false
  : false;

const _case: _AssertCaseOwner = true;
const _dispatch: _AssertChildDispatch = true;
const _space: _AssertSpaceLevels = true;
// Reference them so unused-vars doesn't strip the assertions.
void [_case, _dispatch, _space];
