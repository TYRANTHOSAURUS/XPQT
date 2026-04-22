# React Query Guidelines (Prequest)

The operational contract for server-state management on the web app. Source of truth: [TanStack Query v5 docs](https://tanstack.com/query/latest). When this document and the TanStack docs disagree, TanStack wins — but update this doc in the same PR.

> **Status:** The codebase currently uses the hand-rolled `useApi` hook. React Query is the target. This doc describes how to write new code and how to migrate existing code.

---

## 0. Why React Query, scoped

React Query is for **server state** — anything that lives on the server and needs fetching, caching, invalidation, optimistic updates, background refetching. It is **not** for client state (form values, UI toggles, modal open/closed). Use `useState` / context / Zustand for those.

We chose it over the homegrown `useApi` because:

1. `isLoading` vs `isFetching` split — no full-screen spinner on every refetch.
2. Shared cache — two components asking for `/teams` fire one request.
3. `invalidateQueries` from any mutation, no `refetch` prop-drilling.
4. Built-in optimistic updates with rollback.
5. Deduping, stale-while-revalidate, retries, window-focus refetch.

---

## 1. Setup

### 1.1 Install

```bash
pnpm --filter web add @tanstack/react-query
pnpm --filter web add -D @tanstack/eslint-plugin-query @tanstack/react-query-devtools
```

Enable the ESLint plugin — it catches missing deps in query keys and enforces `queryOptions`:

```js
// eslint config
'@tanstack/query/exhaustive-deps': 'error',
'@tanstack/query/prefer-query-options': 'error',
'@tanstack/query/no-rest-destructuring': 'warn',
```

### 1.2 Root provider

`apps/web/src/main.tsx`:

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,              // 30s — tune per query where needed
      gcTime: 5 * 60_000,             // 5 min
      refetchOnWindowFocus: true,     // matches our multi-agent desk model
      retry: (failureCount, error) => {
        // Don't retry auth/permission errors — apiFetch throws with status on err
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403 || status === 404) return false;
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

<QueryClientProvider client={queryClient}>
  <BrowserRouter>
    <App />
  </BrowserRouter>
  <ReactQueryDevtools initialIsOpen={false} />
</QueryClientProvider>
```

One `QueryClient` per app, created at module scope. Never create it inside a component.

---

## 2. Folder structure

One **API module** per domain concept, colocating the key factory, fetchers, hooks, and types:

```
apps/web/src/api/
├── index.ts                     // re-exports `queryKeys` from every module
├── query-client.ts              // exports the shared QueryClient
├── tickets/
│   ├── keys.ts                  // ticketKeys factory (§3)
│   ├── queries.ts               // useTicketDetail, useTicketList, ticketDetailOptions
│   ├── mutations.ts             // useUpdateTicket, useReassignTicket, etc.
│   ├── types.ts                 // TicketDetail, TicketListItem, UpdateTicketPayload
│   └── index.ts                 // barrel
├── teams/
├── users/
├── request-types/
├── routing-rules/
├── sla-policies/
├── workflows/
├── approvals/
├── assets/
├── locations/
├── vendors/
├── webhooks/
└── ...
```

Rules:

- **One module per top-level domain entity**, matching the backend module names in `apps/api/src/modules/`. If the backend has a `routing` module, the web has `src/api/routing/`.
- **Hooks live with their factory**, not in `src/hooks/`. `src/hooks/` is for pure-client hooks (`use-theme`, `use-mobile`, `use-reclassify` flow state).
- **Types imported from `@prequest/shared` when available**, otherwise defined in `types.ts` of the module.
- **No cross-module imports of keys** — if `tickets` needs to invalidate `approvals`, import `approvalKeys` explicitly. Don't bundle everything into one mega-factory.

---

## 3. Query key factories — the one pattern

Every module defines **exactly one** key factory object. Keys are **hierarchical arrays**, never strings.

### 3.1 The shape (tkdodo pattern)

```ts
// src/api/tickets/keys.ts
import type { TicketListFilters } from './types';

export const ticketKeys = {
  all: ['tickets'] as const,

  lists: () => [...ticketKeys.all, 'list'] as const,
  list: (filters: TicketListFilters) => [...ticketKeys.lists(), filters] as const,

  details: () => [...ticketKeys.all, 'detail'] as const,
  detail: (id: string) => [...ticketKeys.details(), id] as const,

  // Sub-resources hang off detail(id) — never off all
  activities: (id: string) => [...ticketKeys.detail(id), 'activities'] as const,
  children: (id: string) => [...ticketKeys.detail(id), 'children'] as const,
  approvals: (id: string) => [...ticketKeys.detail(id), 'approvals'] as const,
  preview: (id: string, nextRequestTypeId: string) =>
    [...ticketKeys.detail(id), 'reclassify-preview', nextRequestTypeId] as const,
} as const;
```

Why this shape:

- Every key starts with `['tickets']`, so `invalidateQueries({ queryKey: ticketKeys.all })` nukes the entire module's cache in one call.
- `lists()` and `details()` are **groups**, not fetchable keys — they exist so you can invalidate all lists without touching details (common pattern after a create/delete).
- `list(filters)` and `detail(id)` are **leaves** — these are the keys actually used in `useQuery`.
- Sub-resources nest under `detail(id)` so invalidating a single ticket also invalidates its activities/children.

### 3.2 Naming rules

| Level | Name | Example |
|---|---|---|
| Root | `all` | `['tickets']` |
| Group (lists) | `lists()` | `['tickets', 'list']` |
| Leaf list | `list(filters)` | `['tickets', 'list', { status: 'open' }]` |
| Group (details) | `details()` | `['tickets', 'detail']` |
| Leaf detail | `detail(id)` | `['tickets', 'detail', 'abc-123']` |
| Sub-resource | `<resource>(id)` | `['tickets', 'detail', 'abc-123', 'activities']` |

- **Use the entity's module name** as the root string, not a plural synonym. `['tickets']` not `['ticket']` or `['ticketList']`.
- **Filters go last**, always as a plain object, never spread into the array. Filter objects are deep-equal-compared by React Query.
- **No camelCase in key strings** — lowercase, hyphenated: `'reclassify-preview'`, not `'reclassifyPreview'`.
- **No version numbers or timestamps in keys** — bust the cache by invalidating, don't rename the key.

### 3.3 Filter objects — shape discipline

Filters in list keys must be **stable and serializable**:

```ts
// ✅ Good — sorted keys, primitives, null for "all"
ticketKeys.list({ assignedTeamId: null, priority: 'high', q: null, status: 'open' });

// ❌ Bad — undefined values create cache misses on re-render
ticketKeys.list({ status: 'open', priority: undefined });

// ❌ Bad — Date object, functions, class instances all break key equality
ticketKeys.list({ createdAfter: new Date() });
```

Convert `undefined` to `null` or omit the key entirely. Pass ISO strings for dates.

---

## 4. `queryOptions` helper — always use it

Every reusable query is defined via `queryOptions`, never as an inline object inside `useQuery`. This gives you type-safe reuse across `useQuery`, `useQueries`, `prefetchQuery`, `setQueryData`, and `getQueryData`.

```ts
// src/api/tickets/queries.ts
import { queryOptions, useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from './keys';
import type { TicketDetail, TicketListFilters, TicketListItem } from './types';

export function ticketDetailOptions(id: string) {
  return queryOptions({
    queryKey: ticketKeys.detail(id),
    queryFn: ({ signal }) => apiFetch<TicketDetail>(`/tickets/${id}`, { signal }),
    staleTime: 10_000,
    enabled: Boolean(id),
  });
}

export function ticketListOptions(filters: TicketListFilters) {
  return queryOptions({
    queryKey: ticketKeys.list(filters),
    queryFn: ({ signal }) => apiFetch<TicketListItem[]>('/tickets', { signal, query: filters }),
    staleTime: 30_000,
  });
}

// Hooks are thin wrappers — they exist so pages don't reach into api/ internals
export function useTicketDetail(id: string) {
  return useQuery(ticketDetailOptions(id));
}

export function useTicketList(filters: TicketListFilters) {
  return useQuery(ticketListOptions(filters));
}
```

Why `queryOptions`:

- **One source of truth** per query — key, fetcher, `staleTime`, `select`, all colocated.
- **`queryClient.setQueryData(ticketDetailOptions(id).queryKey, newData)`** is type-safe.
- **Prefetching** from a list row on hover becomes `queryClient.prefetchQuery(ticketDetailOptions(id))` — no key construction mistakes.

### 4.1 `signal` support

Always thread `signal` through to `apiFetch`. React Query cancels in-flight requests when keys change or components unmount — `signal` makes that actually stop the network call.

`apiFetch` should accept `{ signal }` in its options and pass it to `fetch`. If it doesn't today, add it before the first React Query migration.

---

## 5. Mutations

### 5.1 Structure

Mutations live in `mutations.ts` next to the key factory:

```ts
// src/api/tickets/mutations.ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { ticketKeys } from './keys';
import type { TicketDetail, UpdateTicketPayload } from './types';

export function useUpdateTicket(id: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (updates: UpdateTicketPayload) =>
      apiFetch<TicketDetail>(`/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),

    // Optimistic update
    onMutate: async (updates) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), { ...previous, ...updates });
      }
      return { previous };
    },

    onError: (_err, _updates, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    // Invalidate at the right level (see §6)
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ticketKeys.detail(id) });
      qc.invalidateQueries({ queryKey: ticketKeys.lists() });
    },
  });
}
```

### 5.2 Rules

- **Always `cancelQueries` before `setQueryData`** in `onMutate` — prevents a stale in-flight fetch overwriting your optimistic update.
- **Return previous snapshot from `onMutate`** — `onError` uses it to roll back.
- **Invalidate in `onSettled`**, not `onSuccess` — runs on both success and error, guarantees the cache reconciles with the server.
- **Type the mutation variable explicitly** — `useMutation<Response, Error, Variables, Context>` when TypeScript can't infer `Context`.
- **Mutation hooks are named `useXxx` verbs** — `useUpdateTicket`, `useReassignTicket`, `useDispatchWorkOrder`, not `useTicketUpdate`.

### 5.3 Toast and error feedback

Toast on error from the **component** calling `mutation.mutate`, not inside the hook. The hook stays pure; the UI decides feedback. Exception: if every caller shows the same toast, put it in the hook via `onError` — but prefer explicit over implicit.

---

## 6. Invalidation — invalidate as high as correct

The golden rule: **invalidate the smallest subtree that contains all stale data, not lower.**

| Action | Invalidate |
|---|---|
| Edit a ticket field | `ticketKeys.detail(id)` + `ticketKeys.lists()` |
| Delete a ticket | `ticketKeys.lists()` + `qc.removeQueries({ queryKey: ticketKeys.detail(id) })` |
| Create a ticket | `ticketKeys.lists()` only — detail doesn't exist yet |
| Add an activity | `ticketKeys.activities(id)` only (detail doesn't change) |
| Reassign team | `ticketKeys.detail(id)` + `ticketKeys.lists()` + `ticketKeys.activities(id)` (activity feed gets a new entry) |
| Cross-module: ticket change that affects approvals | also `approvalKeys.lists()` — import from the approvals module |

Prefix matching: `invalidateQueries({ queryKey: ticketKeys.all })` invalidates **everything** under `['tickets', ...]`. Use sparingly — correct but over-invalidates.

---

## 7. Cache tiers & freshness policy

Every query belongs to a **tier** that dictates its `staleTime` and `gcTime`. Pick the tier when defining `queryOptions`, not ad hoc in components. Getting this right is 80% of React Query performance work.

### 7.1 The five tiers

| Tier | `staleTime` | `gcTime` | Refetch on mount | Refetch on focus | Used for |
|---|---|---|---|---|---|
| **T0 — Live** | `0` | 2 min | yes | yes | SLA timers, countdowns, anything a user watches tick |
| **T1 — Short** | `10s` | 5 min | yes | yes | Open ticket detail, activity feed, work-order children, approvals list |
| **T2 — Medium** | `30s–60s` | 5 min | yes | yes | Ticket lists, dashboards, my-requests, reports |
| **T3 — Long** | `5 min` | 30 min | no | no | Teams, users, vendors, roles, locations, space tree |
| **T4 — Session-stable** | `Infinity` | `Infinity` | no | no | Request types, workflow definitions, form schemas, SLA policies, business hours, tenant config |

The tenancy model here — request types, workflows, and catalog data change via admin UI, not in-flight — means T4 is safe as long as **admin mutations invalidate them** (see §7.3).

### 7.2 Per-entity cache tier map

Define this once, in each module's `queries.ts`. Keep the mapping here in sync:

| Module | Entity | Tier | Notes |
|---|---|---|---|
| `tickets` | detail (open ticket) | **T1** | High churn — assignments, status, activities. |
| `tickets` | list (queue view) | **T2** | 30s. Optimistic updates from mutations keep it fresh between refetches. |
| `tickets` | activities | **T1** | Append-only from server side; polling OK, realtime preferred. |
| `tickets` | children (work orders) | **T1** | Rolled up into parent status — keep fresh. |
| `tickets` | SLA timer fields | **T0** | Or compute client-side from `due_at` and don't refetch — see §7.4. |
| `approvals` | pending list | **T1** | Agents act on this — staleness is confusing. |
| `approvals` | history | **T3** | Immutable once decided. |
| `routing` | rules | **T4** | Admin-edited. Invalidate on any `routing_rules` mutation. |
| `routing` | decisions for a ticket | **T3** | Immutable audit log, but tied to ticket lifetime → gcTime short enough to free memory. |
| `request-types` | list | **T4** | Used on every portal submit + desk form. Must be cached hard. |
| `request-types` | detail | **T4** | Invalidate on admin edit. |
| `form-schemas` | by request type | **T4** | Same as above. |
| `workflows` | definition | **T4** | Keyed by id; rarely changes. |
| `workflows` | instance (live) | **T1** | Changes as steps advance. |
| `sla-policies` | list | **T4** | Admin-edited. |
| `sla-policies` | timers per ticket | **T0** | Live countdown — see §7.4. |
| `teams` | list | **T3** | Admin-edited occasionally. |
| `users` | list | **T3** | Same. |
| `users` | me (current user + permissions) | **T4** | Loaded at auth boundary, kept for the session. |
| `vendors` | list | **T3** | |
| `locations` | space tree | **T4** | Structural. Invalidate on org-chart edit. |
| `assets` | list | **T2** | More volatile than locations. |
| `assets` | detail | **T2** | |
| `webhooks` | list/detail | **T3** | |
| `business-hours` | calendar | **T4** | Config data. |
| `tenant` | config/theme | **T4** | Loaded once per session. |

### 7.3 Invalidation of T4 entries

The whole point of T4 is to **never refetch automatically**. The contract is: **every admin mutation that edits a T4 entity must invalidate it**. If a mutation forgets, the admin sees a stale UI until reload — that's a bug.

```ts
// src/api/request-types/mutations.ts
export function useUpdateRequestType(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch) => apiFetch(`/request-types/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: requestTypeKeys.detail(id) });
      qc.invalidateQueries({ queryKey: requestTypeKeys.lists() });
      // This entity is used to build forms on the portal — nuke form-schema cache too
      qc.invalidateQueries({ queryKey: formSchemaKeys.all });
    },
  });
}
```

Cross-module invalidation belongs in `onSettled` — never rely on the admin to reload.

### 7.4 Live countdowns — don't poll

SLA timers are T0 but that doesn't mean "fetch every second". The server returns `sla_resolution_due_at` as an ISO timestamp. Cache it at T1 with the rest of the ticket, and render the countdown **client-side** with `requestAnimationFrame` or a 1s interval:

```tsx
// Good: one network call, ticking UI
const ticket = useTicketDetail(id).data;  // T1 cache
<SlaTimer dueAt={ticket.sla_resolution_due_at} />  // computes remaining locally
```

If a push event (realtime, websocket) or mutation changes the deadline, update the cache via `setQueryData`. Never set `refetchInterval: 1000` on a ticket query — it will cost you 3600 requests/hour per open ticket, per user.

### 7.5 Network mode considerations

We don't support offline. Keep default `networkMode: 'online'`. Don't use `'offlineFirst'` — it makes failure modes confusing when the backend returns 403/409.

---

## 8. Loading states — the taxonomy

Use the right flag for the right UI. Confusing them is why the app feels janky.

### 8.1 Query flags

| Flag | Meaning | Use for |
|---|---|---|
| `isPending` | No data has ever been fetched | First-load skeleton or full-view spinner |
| `isLoading` | `isPending && isFetching` (first fetch in progress) | Same as `isPending` in practice |
| `isFetching` | Any request in flight (initial, refetch, background) | Subtle top-bar indicator, NOT a full-screen spinner |
| `isRefetching` | Refetch happening after initial load | Same as above |
| `isPlaceholderData` | Showing stale data while new data loads | Disable paginate-forward button (§10) |
| `isError` / `error` | Last fetch failed | Error UI, with `refetch` offered |
| `isSuccess` | At least one successful fetch | Normal render |

### 8.2 The rule that fixes today's ticket-detail problem

**Full-screen spinner only on `isPending`**, never on `isFetching`. Refetches must keep the previous UI visible:

```tsx
// ✅ Correct
const { data: ticket, isPending, isFetching, error } = useTicketDetail(id);

if (isPending) return <TicketDetailSkeleton />;
if (error) return <ErrorState error={error} />;

return (
  <>
    {isFetching && <TopBarProgress />}   {/* subtle — a 2px bar or nothing */}
    <TicketDetailView ticket={ticket} />
  </>
);
```

### 8.3 Skeletons vs spinners

| Situation | Use | Why |
|---|---|---|
| First load of a **content view** (ticket detail, list page) | **Skeleton** matching the layout | Avoids layout shift, shorter perceived wait |
| First load of a **small control** (picker, combobox) | **Spinner inside the trigger** | Skeletons on tiny surfaces look like broken layout |
| Action in progress (button click) | **Disabled button + inline spinner** | Feedback tied to the action, not the whole screen |
| Background refetch | **Nothing**, or a 2px top bar | User didn't ask for this — don't interrupt them |
| Navigating to a detail you've seen before | **Instant render from cache + `isFetching` bar** | Stale-while-revalidate |
| Paginate next page | **Keep previous data visible + `isPlaceholderData` on next button** | No jarring empty state |

Always render a skeleton with the same shape as the final content (header, sidebar, body). Tailwind's `animate-pulse` + `bg-muted` rounded divs is the baseline. Put skeletons next to the component they mimic: `ticket-detail-skeleton.tsx` beside `ticket-detail.tsx`.

### 8.4 Mutation flags

| Flag | Use |
|---|---|
| `isPending` | Disable the button, show inline spinner |
| `isError` | Show field-level error (`FieldError`) for field mutations, toast for one-shot actions |
| `isSuccess` | Close modals, show toast only for destructive/irreversible actions |
| `variables` | Read the in-flight payload to render "Saving X..." copy |

```tsx
const update = useUpdateTicket(id);

<Button disabled={update.isPending} onClick={() => update.mutate({ priority: 'high' })}>
  {update.isPending ? 'Saving…' : 'Save'}
</Button>
```

### 8.5 Error boundaries — opt in per query

Set `throwOnError: true` on queries whose failure should break the whole view (e.g. ticket detail 404). Wrap in a React error boundary at the page level. Don't default this — most queries should return `error` and let the component render a local error state.

```ts
ticketDetailOptions(id) // → add `throwOnError: (err) => err.status >= 500`
```

Server errors throw; 403/404 render a local "not found" state.

---

## 9. Fetching order & prefetching

### 9.1 Rule: eliminate waterfalls

A waterfall = "component renders → fetches A → waits → renders → fetches B → waits → renders". React Query makes this explicit — you can see waterfalls in the Devtools Network panel.

**Kill them with one of three tools:**

1. **Parallel with `useQueries`** — when queries are independent.
2. **Dependent with `enabled`** — when B truly needs A's data.
3. **Nested prefetch** — inside A's `queryFn`, prefetch B for items you know you'll need.

### 9.2 Parallel fetching — default when possible

Ticket detail needs: ticket, activities, children, approvals, pending mentions. These are independent. Fire them in parallel from the component — React Query dedupes and shares state across hooks:

```tsx
function TicketDetail({ id }) {
  const ticket = useTicketDetail(id);         // T1
  const activities = useTicketActivities(id); // T1
  const children = useTicketChildren(id);     // T1
  const approvals = useTicketApprovals(id);   // T1

  // Render as soon as `ticket` resolves — others backfill
  if (ticket.isPending) return <Skeleton />;
  return <TicketView ticket={ticket.data} activities={activities.data} ... />;
}
```

Four hooks = four requests going out at the same time, not a waterfall.

For a dynamic list of parallel queries, use `useQueries`:

```ts
const results = useQueries({
  queries: childIds.map((id) => ticketDetailOptions(id)),
});
```

### 9.3 Dependent queries — use `enabled`

Only when B genuinely needs A's result:

```ts
const ticket = useTicketDetail(id);
const requestType = useQuery({
  ...requestTypeDetailOptions(ticket.data?.request_type_id ?? ''),
  enabled: Boolean(ticket.data?.request_type_id),
});
```

If the "dependency" is just an id you already have in the URL — **it's not a dependent query**. Fire in parallel.

### 9.4 Render priority — render fast, backfill

Don't block the primary content on secondary data. Ticket detail should paint as soon as the ticket itself arrives; the sidebar's `teams` list can populate a frame later.

```tsx
// Primary — blocks render
if (ticket.isPending) return <Skeleton />;

// Secondary — inline loading inside the sidebar, not a full-view block
<InlineProperty label="Team">
  {teams.isPending ? <SmallSpinner /> : <EntityPicker options={teams.data} ... />}
</InlineProperty>
```

### 9.5 Prefetch on hover / intent

For navigation to a ticket from a row, prefetch on `onMouseEnter` (desktop) and `onFocus` (keyboard):

```tsx
// src/api/tickets/prefetch.ts
export function usePrefetchTicket() {
  const qc = useQueryClient();
  return (id: string) => {
    qc.prefetchQuery({ ...ticketDetailOptions(id), staleTime: 30_000 });
    // Prefetch sub-resources too if the detail view will render them on arrival
    qc.prefetchQuery({ ...ticketActivitiesOptions(id), staleTime: 30_000 });
  };
}

// In the list row:
const prefetch = usePrefetchTicket();
<tr onMouseEnter={() => prefetch(ticket.id)} onFocus={() => prefetch(ticket.id)}>
```

The `staleTime` inside `prefetchQuery` is **"don't prefetch if fresher than this"**. Without it, hover flickers the network tab.

### 9.6 Prime the cache from list data

When the list endpoint returns enough fields to populate the detail view for "above the fold" content, seed the detail cache so navigation is instant:

```tsx
// After `useTicketList` resolves:
const qc = useQueryClient();
useEffect(() => {
  if (!list.data) return;
  for (const t of list.data) {
    qc.setQueryData<TicketDetail>(
      ticketKeys.detail(t.id),
      (prev) => prev ?? (t as unknown as TicketDetail),   // only seed if empty
    );
  }
}, [list.data]);
```

The guard `prev ?? …` prevents list data (often a narrower projection) from overwriting a fuller detail payload.

### 9.7 Prefetch at the router level

When using route loaders (React Router v6.4+ or Data Router), call `queryClient.ensureQueryData` in the loader so the view renders with data already in cache. This is the fastest path for first paint — even faster than hover prefetch, because it starts during navigation transition.

---

## 10. Pagination & infinite queries

### 10.1 Offset/page-based — `placeholderData: keepPreviousData`

Prevents the list from flashing empty between pages:

```ts
export function ticketListPageOptions(filters: TicketListFilters, page: number) {
  return queryOptions({
    queryKey: ticketKeys.list({ ...filters, page }),
    queryFn: ({ signal }) => apiFetch<TicketListPage>('/tickets', { signal, query: { ...filters, page } }),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}
```

Then disable "next page" while `isPlaceholderData` is true — it signals the new page's meta (`hasMore`) isn't trusted yet.

### 10.2 Cursor-based — `useInfiniteQuery`

Prefer this for activity feeds and ticket queues. `infiniteQueryOptions` mirrors `queryOptions`:

```ts
export function ticketActivitiesInfiniteOptions(ticketId: string) {
  return infiniteQueryOptions({
    queryKey: ticketKeys.activities(ticketId),
    queryFn: ({ pageParam, signal }) =>
      apiFetch<ActivitiesPage>(`/tickets/${ticketId}/activities`, {
        signal,
        query: { cursor: pageParam },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 10_000,
  });
}
```

Prefetch page 2 on mount for "above the fold" perceived speed.

---

## 11. Realtime — write to cache, don't invalidate

When Supabase realtime (or a websocket) emits a ticket-updated event, **call `setQueryData`** to patch the cache, rather than `invalidateQueries`. Invalidation triggers a refetch and causes a frame of `isFetching`; `setQueryData` is instant and doesn't hit the network.

```ts
// src/api/tickets/realtime.ts
supabase
  .channel(`ticket:${id}`)
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'tickets', filter: `id=eq.${id}` },
    (payload) => {
      queryClient.setQueryData<TicketDetail>(
        ticketKeys.detail(id),
        (prev) => (prev ? { ...prev, ...payload.new } : prev),
      );
      // For list views, patch all matching list caches
      queryClient.setQueriesData<TicketListItem[]>(
        { queryKey: ticketKeys.lists() },
        (old) => old?.map((t) => (t.id === id ? { ...t, ...payload.new } : t)),
      );
    },
  )
  .subscribe();
```

Only invalidate when the server event doesn't carry enough data to patch the cache (rare).

Use `setQueriesData` (plural) with a prefix key to patch **all** list variants at once.

---

## 12. Avoiding re-renders with `select`

By default, a `useQuery` caller re-renders on **any** change to the cached value. For large objects (a ticket with 30+ fields) that's wasteful when the component only reads one field.

Use `select` to project the slice you care about — the component only re-renders when the selected slice changes:

```ts
// Generic hook
export const useTicketDetailSelect = <T,>(id: string, selector: (t: TicketDetail) => T) =>
  useQuery({ ...ticketDetailOptions(id), select: selector });

// Specific projections — component-only subscriptions
export const useTicketStatus = (id: string) =>
  useTicketDetailSelect(id, (t) => t.status_category);

export const useTicketAssignedTeam = (id: string) =>
  useTicketDetailSelect(id, (t) => t.assigned_team);
```

Rules:

- **Keep selectors stable** (module-scope functions, or `useCallback`ed). An inline arrow recreates each render and defeats the optimization.
- **Prefer `select` over deriving in render** for anything that loops or does heavy computation.
- **Don't `select` in the main hook** (`useTicketDetail`) — keep that returning the full object. Add `useTicketXxx` variants for slices.

### 12.1 Structural sharing

React Query returns the **same object reference** between refetches if the data is deep-equal. Components using `===` comparisons (memoization, `useEffect` deps) don't re-run when the server returns identical data. Don't fight this by deep-cloning in `queryFn` or `select`.

---

## 13. Naming conventions (summary)

| Thing | Convention | Example |
|---|---|---|
| Key factory | `<entity>Keys` | `ticketKeys`, `teamKeys`, `requestTypeKeys` |
| Query options fn | `<entity><Scope>Options` | `ticketDetailOptions(id)`, `ticketListOptions(filters)` |
| Query hook | `use<Entity><Scope>` | `useTicketDetail(id)`, `useTicketList(filters)` |
| Mutation hook | `use<Verb><Entity>` | `useUpdateTicket`, `useReassignTicket`, `useDispatchWorkOrder` |
| File | kebab-case matching hook | `queries.ts`, `mutations.ts`, `keys.ts` |
| Module folder | matches backend module | `src/api/tickets/` ↔ `apps/api/src/modules/ticket/` |

---

## 14. Error handling

Errors fall into four classes. Each gets a different treatment — don't lump them together.

### 14.1 Error taxonomy

| Class | HTTP status | Example | UI treatment |
|---|---|---|---|
| **Transient** | network error, 500, 502, 503, 504 | Backend blip, cold start | Auto-retry (default: 2x with exponential backoff), inline "retry" action if all retries fail |
| **Client / permission** | 400, 401, 403, 404, 409, 422 | Missing perm, stale version, validation failure | Never retry — render specific UI per status |
| **Auth expired** | 401 globally | JWT timed out | Kick to login; handled once at `apiFetch` layer |
| **Mutation conflict** | 409, 412 | Optimistic concurrency, stale update | Roll back, refetch, show conflict toast with "view latest" action |

### 14.2 Retry policy (query-level)

Global defaults are already scoped in §1.2 — **do not retry 401/403/404**. For a specific query, override only when necessary:

```ts
export function routingPreviewOptions(ctx: RoutingPreviewCtx) {
  return queryOptions({
    queryKey: routingKeys.preview(ctx),
    queryFn: ({ signal }) => apiFetch('/routing/preview', { signal, body: JSON.stringify(ctx), method: 'POST' }),
    retry: false, // User-triggered preview — failure should surface immediately
    staleTime: 0,
  });
}
```

### 14.3 Typed errors from `apiFetch`

`apiFetch` must throw an instance of a dedicated error class carrying `status`, `code`, and `message`. Without this, every caller writes fragile string matching (`/403|forbidden/i.test(err.message)` — which `ticket-detail.tsx:427` currently does).

```ts
// src/lib/api.ts — target shape
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,  // machine-readable backend code, when provided
    message: string,
    public readonly details?: unknown,     // zod errors, field-level messages, etc.
  ) { super(message); this.name = 'ApiError'; }
}
```

Then consumers discriminate cleanly:

```tsx
if (error instanceof ApiError && error.status === 403) return <NoAccessState />;
if (error instanceof ApiError && error.status === 404) return <NotFoundState />;
return <GenericError onRetry={refetch} />;
```

Migrate `apiFetch` to throw `ApiError` **before** moving `ticket-detail.tsx` to React Query — otherwise the error-branch regresses.

### 14.4 Where to show errors

| Surface | Error render location |
|---|---|
| Page-level query (ticket detail, list page) | Full-view error state, with refetch button |
| Secondary query (sidebar data) | Inline empty/error in that panel; don't block the main view |
| Mutation on a field | `FieldError` below the input — **never** a toast for field errors |
| Mutation on an action button (dispatch, reassign) | Toast with the action name + error message |
| Destructive irreversible action failure | Toast + inline banner until user dismisses |
| Auth expired | Global handler (at `apiFetch` or `QueryCache` error listener) — redirect |

### 14.5 Global error listener

For truly cross-cutting handling (auth expiry, maintenance mode, banner-level errors), attach listeners to the `QueryClient`'s caches, not scattered `onError` callbacks:

```ts
new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        authStore.logout();
      }
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof ApiError && error.status === 401) {
        authStore.logout();
      }
      // Don't toast here — mutation components handle their own UX
    },
  }),
});
```

One place, one rule, no duplication.

### 14.6 Error boundary escalation

Only queries that **represent the primary resource of a page** should set `throwOnError` for 5xx. Everything else returns the error and renders locally.

```ts
ticketDetailOptions(id) // throws on 5xx so the route-level boundary catches it
ticketActivitiesOptions(id) // returns error; activity panel shows inline retry
```

Wrap each route with an error boundary at the layout level; never one global boundary that eats every error.

### 14.7 Don't swallow errors

- Never `catch` in a `queryFn` and return `null`. React Query can't distinguish "no data" from "failed" after that.
- Never `throw` custom values — throw `Error` subclasses. React Query's `error` is typed as `Error`.
- Never `console.log` and continue — log to Sentry (or whatever observability layer) via the global `QueryCache.onError`.

---

## 15. Settlement handling — the mutation lifecycle

A mutation moves through four hook points. Getting the ordering right is why optimistic UX feels solid instead of janky.

### 15.1 The lifecycle

```
            user clicks
                │
          mutate(variables)
                │
                ▼
           [onMutate]         ← cancel in-flight, snapshot, apply optimistic
                │
         network request
          ┌─────┴──────┐
          ▼            ▼
     [onSuccess]    [onError]     ← branch on server response
          │            │          onError uses snapshot to roll back
          └─────┬──────┘
                ▼
            [onSettled]           ← runs in both branches. Invalidate here.
                │
                ▼
        promise resolves          ← component sees isPending=false
```

### 15.2 What goes in each hook — the rules

| Hook | Always | Sometimes | Never |
|---|---|---|---|
| `onMutate` | Cancel queries, snapshot, apply optimistic update, return context | Derive optimistic payload from `variables` | Fetch anything; call the network |
| `onSuccess` | Nothing (prefer `onSettled`) | Replace optimistic placeholder with server result if IDs differ (temp id → real id); trigger follow-on actions that only make sense on success (e.g. close a dialog) | Invalidate — use `onSettled` |
| `onError` | Roll back using the snapshot from `onMutate` | Surface an error toast or re-throw | Retry — rely on `useMutation`'s `retry` config |
| `onSettled` | Invalidate the affected keys | Return a promise — RQ will await it before the mutation resolves (useful to keep button disabled until cache is fresh) | Read `data` without also handling `error` being truthy |

### 15.3 The canonical mutation shape

```ts
export function useUpdateTicket(id: string) {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (updates: UpdateTicketPayload) =>
      apiFetch<TicketDetail>(`/tickets/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(updates),
      }),

    onMutate: async (updates) => {
      await qc.cancelQueries({ queryKey: ticketKeys.detail(id) });
      const previous = qc.getQueryData<TicketDetail>(ticketKeys.detail(id));
      if (previous) {
        qc.setQueryData<TicketDetail>(ticketKeys.detail(id), { ...previous, ...updates });
      }
      return { previous };
    },

    onError: (_err, _updates, ctx) => {
      if (ctx?.previous) qc.setQueryData(ticketKeys.detail(id), ctx.previous);
    },

    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
        qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
      ]),
  });
}
```

Returning the `Promise.all` from `onSettled` means `mutation.isPending` stays true until the invalidation refetches complete — the Save button stays disabled until the UI is reconciled. Without it, the button re-enables while stale data is still on screen for a frame.

### 15.4 Multiple invalidations — await them all

Always `await` or return the invalidation promises. One forgotten `await` is a race condition that only surfaces at the worst moment:

```ts
// ❌ Race — button re-enables before lists refresh
onSettled: () => {
  qc.invalidateQueries({ queryKey: ticketKeys.detail(id) });
  qc.invalidateQueries({ queryKey: ticketKeys.lists() });
},

// ✅ Deterministic
onSettled: () =>
  Promise.all([
    qc.invalidateQueries({ queryKey: ticketKeys.detail(id) }),
    qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
  ]),
```

### 15.5 `mutate` vs `mutateAsync`

- **`mutate(vars)`** — fire-and-forget. Side effects via `onSuccess`/`onError`. Preferred for most UI.
- **`mutateAsync(vars)`** — returns a promise you can await. Only use when the calling code needs the result *inline* (e.g. chained mutations, closing a wizard after save completes). Async unhandled rejections are easy to forget — always wrap in try/catch.

```ts
// ✅ mutate — canonical for button clicks
update.mutate({ priority: 'high' });

// ✅ mutateAsync — only when we need the server result to drive the next step
const handleCreateAndDispatch = async () => {
  try {
    const ticket = await createTicket.mutateAsync(payload);
    await dispatch.mutateAsync({ parentId: ticket.id, ...dispatchPayload });
    navigate(`/tickets/${ticket.id}`);
  } catch (err) {
    // onError handlers already ran — surface final state here
  }
};
```

### 15.6 Optimistic with unknown-id — temp → real swap

When creating an entity, the server mints the id. Use a temp id in `onMutate`, swap in `onSuccess`:

```ts
onMutate: (newTicket) => {
  const tempId = `temp-${crypto.randomUUID()}`;
  qc.setQueryData<TicketListItem[]>(ticketKeys.lists(), (old) => [
    ...(old ?? []),
    { ...newTicket, id: tempId },
  ]);
  return { tempId };
},
onSuccess: (serverTicket, _vars, ctx) => {
  qc.setQueryData<TicketListItem[]>(ticketKeys.lists(), (old) =>
    old?.map((t) => (t.id === ctx.tempId ? serverTicket : t)),
  );
},
onError: (_err, _vars, ctx) => {
  qc.setQueryData<TicketListItem[]>(ticketKeys.lists(), (old) =>
    old?.filter((t) => t.id !== ctx?.tempId),
  );
},
onSettled: () => qc.invalidateQueries({ queryKey: ticketKeys.lists() }),
```

### 15.7 Concurrency guards — don't clobber in-flight mutations

If the user mashes a status dropdown three times, three mutations race. Options:

1. **Accept the last-write-wins default.** Good enough for status/priority.
2. **Cancel in-flight with `mutationKey` + `qc.getMutationCache().find(...)`.** Needed when every keystroke triggers a save (rare — debounce instead).
3. **Serialize.** Use a local `useRef` queue or upgrade to a server-side optimistic-concurrency token (`If-Match`).

Don't build #2 or #3 unless actual bugs show up.

### 15.8 Settlement when navigating away

If the user clicks "Save" and immediately closes the ticket, the mutation keeps running (it's scheduled on the `QueryClient`, not the component). `onSettled` still fires, `invalidateQueries` still runs — that's correct behavior, not a leak.

**But**: if the component re-opens before the mutation settles, `onMutate`'s optimistic update targets the cache that the new mount will read. This is the intended behavior; don't work around it.

### 15.9 Toasts — at the call site, not in the hook

```tsx
// ✅ Component decides the message
update.mutate(
  { status: 'closed' },
  {
    onSuccess: () => toast.success('Ticket closed'),
    onError: (err) => toast.error(`Couldn't close ticket: ${err.message}`),
  },
);
```

Passing callbacks to `mutate()` runs them **after** the hook's own `onSuccess`/`onError`. Keeps generic rollback logic in the hook and surface-specific messaging at the call site.

### 15.10 Settlement checklist

Before merging any mutation, verify:

- [ ] `onMutate` cancels, snapshots, and returns context.
- [ ] `onError` rolls back using the context.
- [ ] `onSettled` invalidates every affected key, with `Promise.all` so button state reflects reconciliation.
- [ ] `mutationFn` throws on non-2xx (via `apiFetch`), so `onError` actually fires.
- [ ] If the mutation creates cross-module effects (ticket update → approval state → activity feed), every affected module's keys are invalidated.
- [ ] Loading/success/error copy is driven at the call site, not buried in the hook.

---

## 16. Anti-patterns (do NOT do)

| Anti-pattern | Why it's bad | Correct |
|---|---|---|
| `queryKey: ['ticket-' + id]` | String keys lose hierarchy — can't invalidate groups | `ticketKeys.detail(id)` |
| `queryKey: ['tickets', 'detail', id]` inline in a component | Drift from the factory; typos break cache | Use `ticketDetailOptions(id)` |
| Creating `new QueryClient()` inside a component | New cache per render — breaks everything | Single client at app root |
| Calling `refetch()` after a mutation | Works but fragile and component-coupled | `queryClient.invalidateQueries` |
| Putting `undefined` in filter objects | Creates cache-miss churn | Use `null` or omit the key |
| Storing form state in React Query | RQ is server state | `useState` / `react-hook-form` |
| `staleTime: 0` everywhere | Refetches on every mount — defeats caching | Tune per query per §7 |
| Spreading filters into the key array | Loses deep-equal behavior, order-sensitive | `['tickets', 'list', filters]` |
| One giant `queryKeys` object for the whole app | Can't delete a module without grep hell | One factory per module |
| Full-screen spinner on `isFetching` | Causes the "entire screen reloads" UX bug | Render on `isPending` only |
| `setQueryData` in `onSuccess` and also `invalidateQueries` in `onSettled` | Double-fetch race; optimistic flash | Pick one strategy per mutation |
| Not `await`ing `cancelQueries` in `onMutate` | Stale fetch can overwrite optimistic update | `await qc.cancelQueries(...)` |
| `refetchInterval: 1000` for SLA timers | 3600 req/hour/user/ticket | Compute countdown client-side from `due_at` |
| Inline arrow selectors (`select: (d) => d.x`) | Defeats re-render optimization | Module-scope selector or `useCallback` |
| Catching errors inside `queryFn` and returning `null` | `error` never fires, UI can't distinguish | Let it throw |
| Mapping string errors (`/403|forbidden/i.test(msg)`) | Breaks on backend copy changes | `ApiError` class with `.status` |
| `mutateAsync` without try/catch | Unhandled rejection | Always wrap, or use `mutate` |
| Invalidating too broadly (`queryKey: ['tickets']`) for every mutation | Refetches unrelated list/detail pairs | Invalidate at the right level per §6 |

---

## 17. Migration playbook — from `useApi` to React Query

Per file, in this order:

1. **Find the entity** the file fetches. If it's `GET /tickets/:id`, the entity is `tickets`.
2. **Create or extend the module** at `src/api/<entity>/`. Add keys, options, hook.
3. **Replace `const { data, loading, refetch } = useApi<T>(path)`** with `const { data, isLoading, isFetching } = useXxx(id)`.
4. **Replace `refetch()` calls** with `queryClient.invalidateQueries({ queryKey: <factory>.detail(id) })` — or delete them entirely if a mutation's `onSettled` already handles it.
5. **Replace bespoke optimistic overlays** (like `useTicketMutation`'s `onOptimistic`) with `onMutate`/`onError` rollback.
6. **Test the full-page spinner behavior** — should now only show on first load, not on refetch.
7. **Delete dead code** from the old hook if it's the last consumer.

Don't migrate a file unless you're already touching it for other reasons, or it's on the priority list in §10. We don't want half-migrated churn.

---

## 18. Migration status — priority surfaces

### ✅ Done (shipped on `feat/react-query-migration`)

1. **`apiFetch` → typed `ApiError`** (commit `7ea5547`). `apps/web/src/lib/api.ts`. Adds `status`/`code`/`details`, `signal` threading for cancellation, `query` builder, 204 handling. Pre-req for everything below.
2. **`QueryClientProvider` at app root** (commit `a23156d`). `apps/web/src/main.tsx` + `apps/web/src/lib/query-client.ts`. Global `QueryCache`/`MutationCache` `onError` listeners warn on 401; retry policy skips 4xx client errors.
3. **`api/tickets/` module** (commit `4e68657`). Key factory + `queryOptions` helpers (`ticketDetailOptions`, `ticketActivitiesOptions`, `ticketTagSuggestionsOptions`) + mutations (`useUpdateTicket`, `useReassignTicket`, `useAddActivity`) + types.
4. **Eight shared API modules** (commit `8c6ce20`): `teams`, `users`, `vendors`, `persons` (+ `usePersonsSearch`), `sla-policies`, `request-types`, `config-entities`, `workflows`. Cache tiers per §7.2.
5. **`ticket-detail.tsx` fully migrated** (commits `d1c8ca7` + `a54bad6`). Zero `useApi`, zero raw `apiFetch`. Fixes the full-screen reload bug. `use-ticket-mutation.ts` deleted.
6. **Review fixes** (commit `4388839`) — mention debounce regression, T4 cache staleness, key-factory normalization, activity over-invalidation.

### ⬜ Next priorities

In order of value (unchanged from original plan):

1. **`tickets.tsx` list page** — biggest remaining UX win. Shared `ticketKeys.detail(id)` cache with the already-migrated detail view means clicking a row renders instantly. Adds `ticketListOptions(filters)` with `keepPreviousData` for paginate-forward.
2. **`use-work-orders.ts`** — already has caller-driven refetch. Move to `api/tickets/queries.ts` → `useTicketChildren(parentId)` under `ticketKeys.children(parentId)`.
3. **Admin mutation sites** (MUST do to raise T4 caches back to `Infinity`):
   - `apps/web/src/components/admin/request-type-dialog.tsx` → `useCreateRequestType` / `useUpdateRequestType` → invalidate `requestTypeKeys.lists()` + `requestTypeKeys.detail(id)`.
   - `apps/web/src/pages/admin/form-schemas.tsx` → `useUpdateFormSchema` → invalidate `configEntityKeys.detail(id)`.
   - `apps/web/src/pages/admin/sla-policies.tsx` → `useCreateSlaPolicy` / `useUpdateSlaPolicy` / `useDeleteSlaPolicy` → invalidate `slaPolicyKeys.lists()` + `slaPolicyKeys.detail(id)`.
   - Once these are done, raise `staleTime` back to `Infinity` in `api/request-types`, `api/config-entities`, `api/sla-policies`.
4. **Admin list pages** that share entities (`teams`, `users`, `vendors`, `persons`, `routing-rules`, `location-teams`, `domain-parents`, `space-groups`, `notifications`, `delegations`, `webhooks`, `business-hours`, `workflow-templates`, `assets`, `locations`, `catalog-hierarchy`, `vendor-menus`, `vendor-menu-detail`) — each gets mutation hooks in its module.
5. **Routing-studio surfaces** (`apps/web/src/components/admin/routing-studio/*`) — simulator, coverage-matrix, child-dispatch-editor, case-ownership-editor, domain-fallbacks-editor, location-teams-editor, domains-editor, routing-rules-editor, space-groups-editor, edit-cell-dialog, audit-tab, routing-map. Create `api/routing/` with `routingRuleKeys`, `routingDecisionKeys`, `coverageKeys`, `simulatorKeys`.
6. **Portal pages** last (`home`, `submit-request`, `my-requests`, `catalog-category`) — usually read-only, lowest pain. Add `api/catalog/` + `api/approvals/` modules.

### Known cleanups (LOW-priority follow-ups)

- **Type drift in `ticket-detail.tsx`** — local `Activity` + `MentionPerson` interfaces duplicate `TicketActivity` (`api/tickets/types.ts`) and `Person` (`api/persons/index.ts`). Currently bridged by `as { data: ... }` casts. Delete the local interfaces, import the module types.
- **`ReactQueryDevtools` ships to prod** — guard the import with `import.meta.env.DEV` in `main.tsx`.
- **Vestigial `displayedTicket = ticket` alias** in `ticket-detail.tsx` — leftover from the old overlay pattern. Inline `ticket`, drop the alias.
- **Sequential mutation in `useAddActivity`** — if attachment upload succeeds and activity POST fails, attachments are orphaned on the server. Identical to pre-migration behavior, but worth a server-side cleanup endpoint or a two-stage saga.
- **Chunk size** — bundle is 1672KB (495KB gzipped), up ~2KB post-migration. `build.rollupOptions.output.manualChunks` should split `@tanstack/*` out.
- **`vercel.json`** — review once Vercel deploy is confirmed working.

### Roll-up metric

```
Files importing `@/hooks/use-api` before this PR: 50
Files importing `@/hooks/use-api` after  this PR: 49
```

This PR is a **foundation + first real migration**. The next PRs should cost proportionally less per file because the API modules are reusable.

---

## 19. When this doc should be updated

**Any PR that touches `src/api/**` must update this doc if:**

- A new module is added — list it in §2 and §7.2.
- A new cache tier or entity classification changes — update §7.2.
- A new key pattern appears that isn't covered by §3 (e.g. infinite queries, paginated lists with cursors).
- A new anti-pattern is discovered — add to §16 with the reason.
- The `QueryClient` defaults change — update §1.2.
- A new error class surfaces (e.g. domain-specific backend codes) — update §14.

Silent drift here turns into cache bugs that are hell to debug.

---

## 20. References

- [TanStack Query — Query Keys](https://tanstack.com/query/latest/docs/framework/react/guides/query-keys)
- [TanStack Query — queryOptions](https://tanstack.com/query/latest/docs/framework/react/reference/queryOptions)
- [TanStack Query — Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
- [TanStack Query — Query Invalidation](https://tanstack.com/query/latest/docs/framework/react/guides/query-invalidation)
- [TanStack Query — Prefetching](https://tanstack.com/query/latest/docs/framework/react/guides/prefetching)
- [TanStack Query — Render Optimizations](https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations)
- [TanStack Query — Dependent Queries](https://tanstack.com/query/latest/docs/framework/react/guides/dependent-queries)
- [TanStack Query — Paginated & Infinite Queries](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries)
- [TanStack Query — Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)
- [TkDodo — Effective React Query Keys](https://tkdodo.eu/blog/effective-react-query-keys)
- [TkDodo — Mastering Mutations](https://tkdodo.eu/blog/mastering-mutations-in-react-query)
