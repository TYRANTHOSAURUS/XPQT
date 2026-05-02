/**
 * Query-key factory for the desk-shell rail-badge counts. Keys are kept in
 * a dedicated `nav` namespace so cache invalidation from realtime pushes can
 * target counts without touching the underlying module's data.
 *
 *   nav
 *     └─ counts
 *         ├─ inbox
 *         ├─ approvals
 *         └─ visitors(buildingId)
 *
 * The `visitors` key is parameterised by building because the count is
 * always per-building (matches the receptionist's current scope).
 */
export const navKeys = {
  all: ['nav'] as const,

  counts: () => [...navKeys.all, 'counts'] as const,
  inboxCount: () => [...navKeys.counts(), 'inbox'] as const,
  approvalsCount: () => [...navKeys.counts(), 'approvals'] as const,
  visitorsCount: (buildingId: string | null) =>
    [...navKeys.counts(), 'visitors', buildingId] as const,
} as const;
