/**
 * Visitor module — shared key factory + minimal shared types.
 *
 * Lives in its own file (not `index.ts`) so that submodules
 * (`reception.ts`, `admin.ts`, `kiosk.ts`) can import the key factory
 * without creating a runtime cycle through `index.ts`'s `export * from
 * './reception'` / `'./admin'` re-exports. The previous arrangement —
 * factory declared in `index.ts`, submodules importing from `'./index'`
 * — produced a "Cannot access 'visitorKeys' before initialization" TDZ
 * error at portal mount because the re-export evaluation order put
 * `reception.ts` ahead of the `visitorKeys` declaration line.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2.
 * Pattern: docs/react-query-guidelines.md (one factory per module,
 * hierarchical: `all → lists/details/expected/types`).
 */

export type VisitorStatus =
  | 'pending_approval'
  | 'expected'
  | 'arrived'
  | 'in_meeting'
  | 'checked_out'
  | 'no_show'
  | 'cancelled';

export interface VisitorType {
  id: string;
  type_key: string;
  display_name: string;
  description?: string | null;
  requires_approval?: boolean;
  allow_walk_up?: boolean;
  default_expected_until_offset_minutes?: number;
  active?: boolean;
}

export const visitorKeys = {
  all: ['visitors'] as const,
  lists: () => [...visitorKeys.all, 'list'] as const,
  list: (filters: Record<string, unknown>) => [...visitorKeys.lists(), filters] as const,
  details: () => [...visitorKeys.all, 'detail'] as const,
  detail: (id: string) => [...visitorKeys.details(), id] as const,
  /** Host's "my upcoming visitors" — distinct from a generic list because
   *  the server filters by visitor_hosts membership, not by query params. */
  expected: () => [...visitorKeys.all, 'expected'] as const,
  /** Visitor types lookup — admin-gated for now; cache aggressively. */
  types: () => [...visitorKeys.all, 'types'] as const,
} as const;
