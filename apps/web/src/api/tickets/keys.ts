/**
 * Query-key factory for the tickets module. Every ticket-related query in the
 * app is keyed through this factory — never inline. See
 * `docs/react-query-guidelines.md` §3.
 *
 * Hierarchy:
 *   all
 *     └─ list → list(filters)
 *     └─ detail → detail(id)
 *                   └─ activities(id)
 *                   └─ children(id)
 *                   └─ approvals(id)
 *                   └─ reclassify-preview(id, nextRequestTypeId)
 */

/**
 * Mirrors the server filter surface (`TicketService.list`). Arrays are sent as
 * repeated query keys (`?status=new&status=assigned`) which NestJS reads as
 * `string[]`. Pass `null` (not `undefined`) to express "no assignee" /
 * "no team" / "no vendor".
 */
export interface TicketListFilters {
  q?: string | null;
  /** status_category — single or multiple. */
  status?: string | string[] | null;
  priority?: string | string[] | null;
  /** `'me'` / UUID / `null` (unassigned). Resolve `'me'` before passing. */
  assignedUserId?: string | null;
  assignedTeamId?: string | null;
  assignedVendorId?: string | null;
  requesterPersonId?: string | null;
  locationId?: string | null;
  ticketKind?: 'case' | 'work_order' | null;
  slaAtRisk?: boolean | null;
  slaBreached?: boolean | null;
  page?: number | null;
}

export const ticketKeys = {
  all: ['tickets'] as const,

  lists: () => [...ticketKeys.all, 'list'] as const,
  list: (filters: TicketListFilters) => [...ticketKeys.lists(), filters] as const,

  details: () => [...ticketKeys.all, 'detail'] as const,
  detail: (id: string) => [...ticketKeys.details(), id] as const,

  activities: (id: string) => [...ticketKeys.detail(id), 'activities'] as const,
  children: (id: string) => [...ticketKeys.detail(id), 'children'] as const,
  approvals: (id: string) => [...ticketKeys.detail(id), 'approvals'] as const,

  reclassifyPreview: (id: string, nextRequestTypeId: string) =>
    [...ticketKeys.detail(id), 'reclassify-preview', nextRequestTypeId] as const,

  tagSuggestions: () => [...ticketKeys.all, 'tag-suggestions'] as const,
} as const;
