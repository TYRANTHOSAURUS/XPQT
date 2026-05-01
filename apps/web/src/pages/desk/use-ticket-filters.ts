import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '@/providers/auth-provider';
import type { TicketListFilters } from '@/api/tickets/keys';

/**
 * URL-backed ticket filter state. The desk /tickets page uses this as the
 * single source of truth — toolbar search, sidebar views, and the chip bar
 * all read/write here. Sharing the URL means a filtered view is a copy-paste
 * link.
 *
 * Conventions:
 * - Multi-value filters (status, priority) live in the URL as a comma-separated
 *   string, not repeated keys — shorter URLs and easier to read.
 * - Assignee/team/vendor can be a UUID, the literal "me" (resolved below to
 *   the current user), or "unassigned" (mapped to `null` ⇒ IS NULL server-side).
 * - `view` is a label only. Clicking a sidebar view replaces every param with
 *   that preset's set. Editing a chip after that does NOT un-set `view`, so
 *   the sidebar still highlights the origin view (Linear-style).
 */

export type ViewId = 'me' | 'unassigned' | 'sla_at_risk' | 'all' | 'recent';

export const OPEN_STATUSES = ['new', 'assigned', 'in_progress', 'waiting', 'pending_approval'] as const;

interface ViewPreset {
  label: string;
  /** Produces the raw URL param set. `me` here means literal "me" — the hook
   *  resolves it to the current user id when building the API filters. */
  params: () => Record<string, string>;
}

export const viewPresets: Record<ViewId, ViewPreset> = {
  me: {
    label: 'Assigned to me',
    params: () => ({ view: 'me', assignee: 'me', status: OPEN_STATUSES.join(',') }),
  },
  unassigned: {
    label: 'Unassigned',
    params: () => ({
      view: 'unassigned',
      assignee: 'unassigned',
      status: OPEN_STATUSES.join(','),
    }),
  },
  sla_at_risk: {
    label: 'SLA at risk',
    params: () => ({ view: 'sla_at_risk', sla: 'at_risk' }),
  },
  all: {
    label: 'All tickets',
    params: () => ({ view: 'all' }),
  },
  recent: {
    label: 'Recent',
    // Server already orders by created_at desc, so "Recent" == "All" for v1.
    // Keeping the distinct view so the sidebar can highlight it correctly.
    params: () => ({ view: 'recent' }),
  },
};

export const VIEW_ORDER: ViewId[] = ['me', 'all', 'unassigned', 'sla_at_risk', 'recent'];

export interface RawFilters {
  q: string;
  view: ViewId | null;
  status: string[];
  priority: string[];
  team: string | null;
  assignee: string | null;
  requester: string | null;
  location: string | null;
  sla: 'at_risk' | 'breached' | null;
}

const splitList = (v: string | null): string[] =>
  v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const joinList = (v: string[]): string | undefined => (v.length ? v.join(',') : undefined);

export function useTicketFilters() {
  const [params, setParams] = useSearchParams();
  const { appUser } = useAuth();
  const currentUserId = appUser?.id ?? null;

  const raw: RawFilters = useMemo(
    () => ({
      q: params.get('q') ?? '',
      view: (params.get('view') as ViewId | null) ?? null,
      status: splitList(params.get('status')),
      priority: splitList(params.get('priority')),
      team: params.get('team'),
      assignee: params.get('assignee'),
      requester: params.get('requester'),
      location: params.get('location'),
      sla: (params.get('sla') as RawFilters['sla']) ?? null,
    }),
    [params],
  );

  // API-shaped filters (consumed by useTicketList). Resolves "me" ⇒ userId,
  // "unassigned" ⇒ null.
  const filters: TicketListFilters = useMemo(() => {
    const resolveAssignee = (v: string | null): string | null | undefined => {
      if (!v) return undefined;
      if (v === 'unassigned') return null;
      if (v === 'me') return currentUserId ?? undefined; // if not signed in, no-op
      return v;
    };
    const resolveNullable = (v: string | null): string | null | undefined => {
      if (!v) return undefined;
      if (v === 'unassigned') return null;
      return v;
    };

    return {
      q: raw.q || null,
      status: raw.status.length ? raw.status : null,
      priority: raw.priority.length ? raw.priority : null,
      assignedUserId: resolveAssignee(raw.assignee),
      assignedTeamId: resolveNullable(raw.team),
      requesterPersonId: raw.requester ?? null,
      locationId: raw.location ?? null,
      slaAtRisk: raw.sla === 'at_risk' ? true : null,
      slaBreached: raw.sla === 'breached' ? true : null,
    };
  }, [raw, currentUserId]);

  const patch = useCallback(
    (next: Partial<Record<keyof RawFilters, string | string[] | null>>) => {
      setParams(
        (prev) => {
          const copy = new URLSearchParams(prev);
          for (const [key, value] of Object.entries(next)) {
            if (value === null || value === undefined || value === '' ||
                (Array.isArray(value) && value.length === 0)) {
              copy.delete(key);
            } else if (Array.isArray(value)) {
              const joined = joinList(value);
              if (joined) copy.set(key, joined);
              else copy.delete(key);
            } else {
              copy.set(key, value);
            }
          }
          return copy;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const applyView = useCallback(
    (id: ViewId) => {
      const preset = viewPresets[id].params();
      setParams(new URLSearchParams(preset), { replace: false });
    },
    [setParams],
  );

  const clearAll = useCallback(() => {
    setParams(new URLSearchParams(), { replace: false });
  }, [setParams]);

  const activeCount = useMemo(() => {
    let n = 0;
    if (raw.status.length) n++;
    if (raw.priority.length) n++;
    if (raw.team) n++;
    if (raw.assignee) n++;
    if (raw.requester) n++;
    if (raw.location) n++;
    if (raw.sla) n++;
    return n;
  }, [raw]);

  return {
    raw,
    filters,
    currentUserId,
    patch,
    applyView,
    clearAll,
    activeCount,
    viewPresets,
  };
}
