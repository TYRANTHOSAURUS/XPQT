import type { ReactNode } from 'react';

/**
 * Loose query-options shape that adapters return + the picker passes
 * straight to `useQuery()`. Adapters build these as plain object literals
 * (not via the `queryOptions()` helper) so the queryKey tuple stays
 * variant-friendly between adapters.
 */
export interface EntityQueryOptions<TData> {
  queryKey: readonly unknown[];
  queryFn: (ctx: { signal: AbortSignal }) => Promise<TData>;
  staleTime?: number;
  gcTime?: number;
  enabled?: boolean;
}

/**
 * Built-in entity types. Sprint 1A ships a handful; subsequent sweeps add
 * more (location, vendor, asset_type, role, approval_chain, etc.).
 *
 * Keep the union narrow — adding a new type requires an adapter. The TS
 * narrowing flags missing adapters at the call site.
 */
export type EntityType =
  | 'person'
  | 'catalog_item'
  | 'request_type'
  | 'cost_center';

/**
 * Per-entity adapter. Decouples the picker shell from the API + render
 * details so we never re-derive list-vs-detail caching behaviour at the
 * call site.
 *
 * - `searchQueryOptions(q, filter)` returns React Query options for an
 *   async search; the picker passes them to `useQuery` directly.
 * - `detailQueryOptions(id)` returns options for the eager id-only fetch
 *   used to render the trigger label when a value is set externally
 *   (e.g. URL state, parent form). Without this the trigger would flash
 *   the raw UUID until the dropdown opens.
 * - `renderListItem(item)` is the row in the dropdown — usually a name +
 *   sublabel pair, sometimes with an icon or avatar.
 * - `renderSelected(item)` is what the trigger button shows. Often a
 *   shorter form than `renderListItem` (e.g. just the name, no sublabel).
 */
export interface EntityAdapter<T extends { id: string }> {
  type: EntityType;
  /** What the user is picking, used for empty-state + placeholder text. */
  noun: string;
  /** "Search persons…" / "Search catalog items…" — placeholder for the input. */
  searchPlaceholder: string;

  searchQueryOptions(query: string, filter?: Record<string, unknown>): EntityQueryOptions<T[]>;
  detailQueryOptions(id: string): EntityQueryOptions<T | null>;

  renderListItem(item: T): ReactNode;
  renderSelected(item: T): ReactNode;
  /** Plain-text label for the selected item — used for the input value when the popover is closed. Defaults to renderSelected when omitted. */
  itemLabel?(item: T): string;
}
