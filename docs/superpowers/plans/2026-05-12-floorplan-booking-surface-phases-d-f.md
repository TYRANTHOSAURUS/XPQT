# Floor Plan Booking Surface (Phases D–F) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the user-facing floor plan booking surfaces on top of Plan 1's designer + draft/publish data. End state: requesters book rooms/desks from a map at `/portal/book/floor`; operators toggle between time-axis and floor-plan views in `/desk/scheduler`; bookings list rows have a "View on floor" action.

**Architecture:** Reuses the `<FloorPlanCanvas>` already shipped in Plan 1 (the view-mode renderer), composes new `<TimeScrubber>` + `<FloorSwitcher>` chrome around it, plugs into the existing reservation creation flow (`booking-composer-v2`) for desktop and a fresh `<BookingSheet>` for mobile. New backend endpoint `GET /api/floors/:id/availability?from&to` computes per-polygon availability state server-side via SQL. Realtime updates via Supabase `reservations` channel filtered to the floor's child spaces.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind v4, shadcn (Dialog + Sheet + Field), TanStack Query v5, Framer Motion, Supabase Realtime, NestJS, PostgreSQL, vitest.

**Spec:** `docs/superpowers/specs/2026-05-12-floorplan-designer-and-map-booking-design.md`. Read §3.6 (realtime), §4.5–§4.7 (palette + time scrubber + floor switcher), §6.3 (availability endpoint), §7.2–§7.4 (routes).

**Depends on:** Plan 1 shipped (PR #13). Don't start Plan 2 work until Plan 1 is merged to main OR continues on the same `worktree-floorplanner` branch.

---

## Pre-flight

- [ ] **Step 0: Confirm Plan 1 state**

Run from the worktree root:
```bash
git log --oneline origin/main..HEAD | head -5
ls apps/web/src/components/floor-plan*
```
Plan 1's deliverables must be present: `apps/web/src/components/floor-plan/` (canvas + polygon + zoom), `apps/web/src/components/floor-plan-designer/` (designer), `apps/web/src/api/floor-plans/` (hooks + keys + types), `apps/api/src/modules/floor-plan/` (backend module).

- [ ] **Step 0b: Confirm baseline builds**

```bash
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
pnpm --filter @prequest/api test floor-plan
```
All green. The Plan 1 smoke gate (`API_BASE=http://localhost:3099 pnpm smoke:floor-plans`) should still pass too.

- [ ] **Step 0c: Survey existing booking creation surface**

```bash
ls apps/web/src/components/booking-composer-v2 | head -10
grep -rn "useCreateBooking\|create-booking\|POST.*reservations" apps/web/src/api 2>/dev/null | head -10
```
Plan 2 calls into the existing booking-composer-v2 for the **desktop** booking flow on click; mobile uses a new lightweight `<BookingSheet>`. Confirm where the create-booking mutation hook lives.

---

# Phase D — Booking Surface + Portal + Realtime

Goal: ship `/portal/book/floor` and the live map. End state: a requester can open the portal, see a building/floor switcher with mini-occupancy bars, scrub through the day with a crowd heatmap, see colored polygons updating in real-time as other people's bookings land, tap a room → bottom sheet → confirm → reservation created. Mobile-first; desktop reuses the existing booking modal on click.

### Task D.1: `GET /api/floors/:id/availability` endpoint

**Files:**
- Create: `supabase/migrations/00375_floor_availability_rpc.sql` (PL/pgSQL RPC for fast aggregation)
- Modify: `apps/api/src/modules/floor-plan/floor-plan.service.ts` (add `getAvailability`)
- Modify: `apps/api/src/modules/floor-plan/floor-plan.controller.ts` (add `GET /availability` endpoint)
- Modify: `packages/shared/src/error-codes.ts` (add `floor_plan.availability.invalid_window`)
- Modify: `apps/api/src/common/errors/messages.en.ts` + `messages.nl.ts`

- [ ] **Step 1: Write the migration**

```sql
-- 00375_floor_availability_rpc.sql
-- Returns per-polygon availability state for a time window, with crowd heatmap.
-- One SQL call instead of N+1 queries from TS. Spec §6.3.

create or replace function public.floor_availability(
  p_floor_space_id uuid,
  p_window_start timestamptz,
  p_window_end timestamptz,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_tenant_id uuid := public.current_tenant_id();
  v_spaces jsonb;
  v_heatmap jsonb;
  v_day_start timestamptz;
begin
  if p_window_start >= p_window_end then
    raise exception 'floor_plan.availability.invalid_window' using errcode = '22023';
  end if;

  -- Aggregate per-polygon state for the window.
  with child_spaces as (
    select s.id, s.name, s.type, s.capacity, s.amenities,
           s.floor_plan_polygon, s.floor_plan_render_hint
      from public.spaces s
     where s.parent_id = p_floor_space_id
       and s.tenant_id = v_tenant_id
       and s.floor_plan_polygon is not null
  ),
  overlapping_reservations as (
    select r.space_id, r.id as reservation_id, r.start_at, r.end_at,
           r.requester_user_id, r.title
      from public.reservations r
      join child_spaces cs on cs.id = r.space_id
     where r.start_at < p_window_end
       and r.end_at > p_window_start
       and r.status not in ('cancelled', 'declined')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',           cs.id,
    'name',         cs.name,
    'type',         cs.type,
    'capacity',     cs.capacity,
    'amenities',    cs.amenities,
    'polygon',      cs.floor_plan_polygon,
    'render_hint',  cs.floor_plan_render_hint,
    'state',        case
                      when not exists (
                        select 1 from overlapping_reservations o where o.space_id = cs.id
                      ) then 'available'
                      when exists (
                        select 1 from overlapping_reservations o
                         where o.space_id = cs.id and o.requester_user_id = p_user_id
                      ) then 'mine'
                      when (
                        select count(*) from overlapping_reservations o
                         where o.space_id = cs.id
                           and o.start_at <= p_window_start
                           and o.end_at >= p_window_end
                      ) > 0 then 'booked'
                      else 'partial'
                    end,
    'free_at',      (
                      select min(o.end_at)
                        from overlapping_reservations o
                       where o.space_id = cs.id
                         and o.end_at > now()
                    ),
    'current_booking', (
                      select jsonb_build_object('id', o.reservation_id, 'title', o.title)
                        from overlapping_reservations o
                       where o.space_id = cs.id
                       order by o.start_at
                       limit 1
                    )
  )), '[]'::jsonb)
    into v_spaces
    from child_spaces cs;

  -- Crowd heatmap: % bookable rooms with overlap per hour from 7–19 on the selected day.
  v_day_start := date_trunc('day', p_window_start);
  with hours as (
    select generate_series(0, 12)::int as h
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'hour', h.h + 7,
    'occupancy', (
      select case when count(*) = 0 then 0
                  else (
                    sum(case when exists (
                      select 1 from public.reservations r
                       where r.space_id = cs.id
                         and r.tenant_id = v_tenant_id
                         and r.start_at < v_day_start + ((h.h + 8) || ' hours')::interval
                         and r.end_at > v_day_start + ((h.h + 7) || ' hours')::interval
                         and r.status not in ('cancelled', 'declined')
                    ) then 1.0 else 0.0 end) / count(*)
                  )
             end
        from public.spaces cs
       where cs.parent_id = p_floor_space_id
         and cs.tenant_id = v_tenant_id
         and cs.floor_plan_polygon is not null
    )
  )), '[]'::jsonb)
    into v_heatmap
    from hours h;

  return jsonb_build_object(
    'floor_space_id', p_floor_space_id,
    'window', jsonb_build_object('start', p_window_start, 'end', p_window_end),
    'spaces', v_spaces,
    'crowd_heatmap', v_heatmap
  );
end;
$$;

revoke all on function public.floor_availability(uuid, timestamptz, timestamptz, uuid) from public;
grant execute on function public.floor_availability(uuid, timestamptz, timestamptz, uuid) to authenticated;

notify pgrst, 'reload schema';
```

Note: this assumes `reservations` has columns `(space_id, start_at, end_at, status, requester_user_id, title, tenant_id)`. Verify with `\d public.reservations` before applying. If column names differ, adjust the JOIN.

- [ ] **Step 2: Apply locally + push to remote**

```bash
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f supabase/migrations/00375_floor_availability_rpc.sql
source .env
PGPASSWORD="$SUPABASE_DB_PASS" psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00375_floor_availability_rpc.sql
```

- [ ] **Step 3: Backend service + endpoint**

In `floor-plan.service.ts`:

```ts
async getAvailability(floorSpaceId: string, tenantId: string, userId: string, windowStart: string, windowEnd: string) {
  const client = this.supabase.admin;
  const { data, error } = await client.rpc('floor_availability', {
    p_floor_space_id: floorSpaceId,
    p_window_start: windowStart,
    p_window_end: windowEnd,
    p_user_id: userId,
  });
  if (error) {
    const code = (error as { code?: string }).code ?? '';
    if (code === '22023') throw AppErrors.validationFailed('floor_plan.availability.invalid_window');
    throw AppErrors.server('floor_plan.availability_failed');
  }
  // Resolve image_url to a fresh signed URL if a published floor plan exists.
  const { data: floor } = await client
    .from('floor_plans')
    .select('image_url, width_px, height_px')
    .eq('space_id', floorSpaceId)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  const floorMeta = floor
    ? { image_url: await this.signFloorPlanImage(floor.image_url), width_px: floor.width_px, height_px: floor.height_px }
    : null;
  return { ...data, floor: floorMeta };
}
```

In `floor-plan.controller.ts`, add a public-read endpoint (no admin permission):

```ts
@Get('availability')
async getAvailability(
  @Param('floorSpaceId') id: string,
  @Query('from') from: string,
  @Query('to') to: string,
  @Req() req: Request,
) {
  const tenantId = TenantContext.current().id;
  const userId = (req as { user?: { id: string } }).user?.id ?? '';
  return this.plan.getAvailability(id, tenantId, userId, from, to);
}
```

Add `@Public()` if needed to match the `getPublished` pattern (visibility filter is applied at the SQL layer for reservations).

- [ ] **Step 4: Register error code**

In `packages/shared/src/error-codes.ts`, add `'floor_plan.availability.invalid_window'` and `'floor_plan.availability_failed'`. Add EN+NL messages.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/00375_floor_availability_rpc.sql apps/api/src/modules/floor-plan packages/shared/src/error-codes.ts apps/api/src/common/errors
git commit -m "feat(floor-plan): 00375 floor_availability RPC + GET /availability endpoint (D.1)"
```

### Task D.2: React Query hook for availability + realtime invalidation

**Files:**
- Modify: `apps/web/src/api/floor-plans/types.ts` (add `FloorAvailability`, `SpaceAvailability`)
- Modify: `apps/web/src/api/floor-plans/keys.ts` (add `.availability(id, windowKey)`)
- Modify: `apps/web/src/api/floor-plans/hooks.ts` (add `useFloorAvailability` + `useFloorAvailabilityRealtime`)

- [ ] **Step 1: Types**

```ts
// Add to types.ts
export type AvailabilityState = 'available' | 'partial' | 'booked' | 'mine' | 'pending' | 'not_bookable';

export type SpaceAvailability = {
  id: string;
  name: string;
  type: string;
  capacity: number | null;
  amenities: string[];
  polygon: { points: Point[] };
  render_hint: RenderHint;
  state: AvailabilityState;
  free_at: string | null;
  current_booking: { id: string; title: string } | null;
};

export type CrowdHeatmapBucket = { hour: number; occupancy: number };

export type FloorAvailability = {
  floor_space_id: string;
  window: { start: string; end: string };
  spaces: SpaceAvailability[];
  crowd_heatmap: CrowdHeatmapBucket[];
  floor: { image_url: string | null; width_px: number; height_px: number } | null;
};
```

- [ ] **Step 2: Keys**

```ts
// Add to keys.ts
floorAvailability: (floorSpaceId: string, windowStart: string, windowEnd: string) =>
  [...floorPlanKeys.floor(floorSpaceId), 'availability', windowStart, windowEnd] as const,
```

- [ ] **Step 3: Hooks**

```ts
// Add to hooks.ts
export function floorAvailabilityOptions(floorSpaceId: string, windowStart: string, windowEnd: string) {
  return queryOptions({
    queryKey: floorPlanKeys.floorAvailability(floorSpaceId, windowStart, windowEnd),
    queryFn: () => apiFetch<FloorAvailability>(
      `/api/floors/${floorSpaceId}/plan/availability?from=${encodeURIComponent(windowStart)}&to=${encodeURIComponent(windowEnd)}`,
    ),
    staleTime: 30_000,
  });
}

export function useFloorAvailability(floorSpaceId: string, windowStart: string, windowEnd: string) {
  return usePageQuery(floorAvailabilityOptions(floorSpaceId, windowStart, windowEnd));
}
```

- [ ] **Step 4: Realtime invalidation hook**

```ts
// Add to hooks.ts
export function useFloorAvailabilityRealtime(floorSpaceId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const supa = getSupabaseClient(); // import from @/lib/supabase
    const channel = supa
      .channel(`floor-${floorSpaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, () => {
        qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      })
      .subscribe();
    return () => { void supa.removeChannel(channel); };
  }, [floorSpaceId, qc]);
}
```

The simple version invalidates on any reservation change. A more targeted version filters server-side by floor's child spaces, but at v1 scale (200 reservations/day per tenant) the over-fetch is negligible. Optimize if perf measurements show it's needed.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/floor-plans
git commit -m "feat(floor-plan): availability hook + realtime invalidation (D.2)"
```

### Task D.3: `<TimeScrubber>` component

**Files:**
- Create: `apps/web/src/components/floor-plan/time-scrubber.tsx`
- Create: `apps/web/src/components/floor-plan/__tests__/time-scrubber.test.tsx`

- [ ] **Step 1: Component**

Build per spec §4.6. Props:
```ts
type Props = {
  value: { start: Date; end: Date };
  onChange: (next: { start: Date; end: Date }) => void;
  heatmap: CrowdHeatmapBucket[];
  rangeStart?: number;  // default 7
  rangeEnd?: number;    // default 19
};
```

Render an SVG strip:
- 12 per-hour vertical bars with height = `occupancy * MAX_HEIGHT`. Color via the heatmap gradient (green → amber → red).
- Dashed vertical line at "now".
- Solid dark thumb at `value.start`. Drag-to-move (Pointer events).
- Smaller handle on the right of the thumb at `value.end - value.start` (duration). Drag-to-resize.
- Hour ticks under the bars with tabular-nums labels.
- Live readout to the right of the title: `selected: 14:30 → 15:30`.

State: `dragging: 'start' | 'duration' | null`. On `pointerdown` capture, on `pointermove` update; on `pointerup` release. Snap to 15-minute increments.

- [ ] **Step 2: Test (vitest + RTL)**

Render with a fixture heatmap, verify the right number of bars and a thumb at the right horizontal offset.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan/time-scrubber.tsx apps/web/src/components/floor-plan/__tests__/time-scrubber.test.tsx
git commit -m "feat(floor-plan): TimeScrubber component (D.3)"
```

### Task D.4: `<FloorSwitcher>` component

**Files:**
- Create: `apps/web/src/components/floor-plan/floor-switcher.tsx`
- Modify: `apps/api/src/modules/floor-plan/floor-plan.service.ts` (add `listBuildingFloors`)
- Modify: `apps/api/src/modules/floor-plan/floor-plan.controller.ts` (or admin controller — pick the right path; add `GET /api/buildings/:buildingId/floors`)

Per spec §4.7. Layout: building pill (dropdown if >1 building) · floor pills with mini-occupancy bars · zoom/fit controls. Hidden building pill when tenant has 1 building.

- [ ] **Step 1: Backend endpoint**

```ts
// in floor-plan.service.ts
async listBuildingFloors(buildingId: string, tenantId: string) {
  const client = this.supabase.admin;
  const { data } = await client
    .from('spaces')
    .select('id, name, code')
    .eq('parent_id', buildingId)
    .eq('tenant_id', tenantId)
    .eq('type', 'floor')
    .order('name');
  return data ?? [];
}
```

Controller endpoint at `/api/buildings/:buildingId/floors` — needs a separate `BuildingFloorsController` (path collision with per-floor controller). Or add to the admin controller with a different base path.

- [ ] **Step 2: Frontend component**

```tsx
type Props = {
  buildingId: string;
  selectedFloorId: string;
  onFloorChange: (id: string) => void;
  occupancyByFloorId: Record<string, number>; // mini-bar widths
  buildings?: Array<{ id: string; name: string }>; // if undefined → hide building pill
  selectedBuildingId?: string;
  onBuildingChange?: (id: string) => void;
};
```

Render pill row. Each floor pill shows the floor label (`G`, `1`, `2`, …) + a thin bar at the bottom = occupancy. Selected pill `bg-foreground text-background`. Floors with no published plan render dashed border + muted.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan/floor-switcher.tsx apps/api/src/modules/floor-plan
git commit -m "feat(floor-plan): FloorSwitcher component + buildings/floors endpoint (D.4)"
```

### Task D.5: Portal route `/portal/book/floor`

**Files:**
- Create: `apps/web/src/pages/portal/book-floor/index.tsx`
- Create: `apps/web/src/pages/portal/book-floor/booking-sheet.tsx`
- Modify: `apps/web/src/App.tsx` (add route wrapped in `RouteErrorBoundary`)

- [ ] **Step 1: Page**

Mobile-first layout (Tailwind responsive). Top: status bar + page header ("Amsterdam HQ" / "Book a room"). Floor pills (horizontal scrolling on mobile). `<TimeScrubber>`. `<FloorPlanCanvas>` view-mode wrapped in `<ZoomPanLayer>`. Fit-to-screen FAB bottom-right.

Default state:
- Building = user's `persons.default_location` building (or first building if none).
- Floor = user's default floor (or first floor with a published plan).
- Time window = now + 60 min.

Hooks:
- `useFloorAvailability(floorSpaceId, windowStart, windowEnd)` (drives polygon colors + scrubber heatmap)
- `useFloorAvailabilityRealtime(floorSpaceId)` (auto-invalidates)

On polygon click:
- On mobile (< 768px): open `<BookingSheet>` bottom sheet.
- On desktop: open the existing `<BookingComposerModal>` pre-filled with the space + window.

- [ ] **Step 2: `<BookingSheet>` (mobile bottom sheet)**

Use shadcn `<Sheet>` with `side="bottom"`. Header: status dot + room name + floor. Amenity icon row. Quick time pills: `Now` / `in 30m` / `this PM` / `Custom`. Selected window readout. Primary CTA `Book <Room>` calls into the existing reservation mutation. On success: `toastCreated('Booking', { onView: () => navigate(`/portal/me-bookings/${id}`) })`.

For "Custom" time, open a sub-dialog or expand inline date+time pickers.

- [ ] **Step 3: Wire route + commit**

In `App.tsx`:
```tsx
<Route path="/portal/book/floor" element={<RouteErrorBoundary><PortalBookFloor /></RouteErrorBoundary>} />
<Route path="/portal/book/floor/:floorSpaceId" element={<RouteErrorBoundary><PortalBookFloor /></RouteErrorBoundary>} />
```

```bash
git add apps/web/src/pages/portal/book-floor apps/web/src/App.tsx
git commit -m "feat(floor-plan): /portal/book/floor mobile-first map booking page (D.5)"
```

### Task D.6: Free-in-N-min badge logic + state mapping

**Files:**
- Modify: `apps/web/src/components/floor-plan/polygon-shape.tsx` (extend props to accept `freeAt` + render subtext)
- Modify: `apps/web/src/components/floor-plan/floor-plan-canvas.tsx` (pass `freeAt` through to PolygonShape)

When `state === 'booked'` and `free_at - now <= 30 min`, render the room as booked but with subtext `"free in <N>m"`. Use `useNow()` hook (Plan 1 added at `apps/web/src/lib/use-now.ts` per memory — confirm; if absent, write one that returns `Date.now()` ticking every 60s).

- [ ] **Step 1: Extend PolygonShape**

Add optional props `freeAt?: string | null` and `currentBookingTitle?: string | null`. Inside, compute the "free in N" string when appropriate. For the labeled-rectangle render, add a small subtitle line below the room name. For the seat-circle render, skip (too small).

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan
git commit -m "feat(floor-plan): free-in-N-min badge + state-driven polygon rendering (D.6)"
```

### Task D.7: Realtime status integration

**Files:**
- Modify: `apps/web/src/pages/portal/book-floor/index.tsx` (use `useRealtimeStatus()` hook)

If `useRealtimeStatus` doesn't exist yet (the error-handling spec references it but no commits ship it), defer and document. Render a 6×6 colored dot in the page header per the spec rule. Hidden in `open` state for first 30s; amber on `reconnecting`; red + write-disabled on `broken`.

- [ ] **Step 1: Implement minimal `useRealtimeStatus` if absent**

```ts
// apps/web/src/lib/use-realtime-status.ts
import { useEffect, useState } from 'react';
import { getSupabaseClient } from './supabase';

export type RealtimeStatus = 'open' | 'reconnecting' | 'broken';

export function useRealtimeStatus(): RealtimeStatus {
  const [status, setStatus] = useState<RealtimeStatus>('reconnecting');
  useEffect(() => {
    const supa = getSupabaseClient();
    const channel = supa.channel('_realtime_status').subscribe((s) => {
      if (s === 'SUBSCRIBED') setStatus('open');
      else if (s === 'CLOSED' || s === 'CHANNEL_ERROR') setStatus('broken');
      else setStatus('reconnecting');
    });
    return () => { void supa.removeChannel(channel); };
  }, []);
  return status;
}
```

- [ ] **Step 2: Wire dot into page header + commit**

```bash
git add apps/web/src/lib/use-realtime-status.ts apps/web/src/pages/portal/book-floor
git commit -m "feat(floor-plan): realtime status dot in portal map header (D.7)"
```

### Task D.8: Cross-tenant + happy-path tests

**Files:**
- Create: `apps/api/src/modules/floor-plan/availability.spec.ts`

Cover:
- Window with no overlapping reservations → all spaces `available`.
- One booking for the user → that space `mine`.
- One booking for another user covering the whole window → that space `booked`.
- One booking partially overlapping → that space `partial`.
- Invalid window (start >= end) → 422.
- Cross-tenant: tenant B can't read tenant A's floor availability.

```bash
git add apps/api/src/modules/floor-plan/availability.spec.ts
git commit -m "test(floor-plan): availability RPC happy + cross-tenant (D.8)"
```

### Task D.9: Smoke gate extension

**Files:**
- Modify: `apps/api/scripts/smoke-floor-plans.mjs` (add probes 21–25)

New probes:
- P21: `GET /availability` happy path with valid window → 200 with `spaces` + `crowd_heatmap`.
- P22: `GET /availability` with start >= end → 422.
- P23: After publishing one polygon + booking that space, `state` of that space is `mine` for the booker.
- P24: After cancelling the booking, the state flips back to `available`.
- P25: Crowd-heatmap returns 13 buckets (hours 7–19).

```bash
pnpm dev:api  # in another terminal, on port 3099
API_BASE=http://localhost:3099 pnpm smoke:floor-plans
```
Expected: 22 pass / 0 fail / 3 skip.

```bash
git add apps/api/scripts/smoke-floor-plans.mjs
git commit -m "test(floor-plan): smoke gate +5 availability probes (D.9)"
```

**Phase D done.** Portal map booking surface ships. Realtime updates flow. Mobile bottom sheet creates reservations.

---

# Phase E — Scheduler + Bookings List Integration

Goal: `/desk/scheduler` gets a Timeline | Floor plan view toggle. `/desk/bookings` rows get a "View on floor" action.

### Task E.1: Scheduler view toggle

**Files:**
- Modify: `apps/web/src/pages/desk/scheduler/index.tsx` (add view toggle)
- Create: `apps/web/src/pages/desk/scheduler/components/scheduler-floor-view.tsx` (embeds canvas with operator scope)

- [ ] **Step 1: View toggle**

Add a `<ToggleGroup>` to the scheduler page header: `Timeline | Floor plan`. Persist selection in `localStorage` under `scheduler-view-mode`. When `floor-plan`, render `<SchedulerFloorView floor={selectedFloor} window={selectedWindow}>` instead of the existing timeline grid.

- [ ] **Step 2: SchedulerFloorView**

Embed `<FloorPlanCanvas>` + `<TimeScrubber>` + `<FloorSwitcher>` inside the scheduler's existing chrome. State (selected building/floor/window) lives in scheduler's URL params, same as Timeline view.

On polygon click: open the existing `<BookingDetail>` drawer (operator scope, no booking-creation flow on this surface — operators create from the explicit "+ New booking" button).

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/desk/scheduler
git commit -m "feat(floor-plan): scheduler Timeline | Floor plan view toggle (E.1)"
```

### Task E.2: "View on floor" action in `/desk/bookings`

**Files:**
- Modify: `apps/web/src/pages/desk/bookings.tsx` (add row action)
- Create: `apps/web/src/pages/desk/components/booking-floor-dialog.tsx` (dialog wrapping the canvas, centered on the booking's space)

- [ ] **Step 1: Row action**

In the bookings table's context menu, add `<DropdownMenuItem>` "View on floor" — disabled if the booking's space has no `floor_plan_polygon`. On click, open `<BookingFloorDialog>`.

- [ ] **Step 2: Dialog**

Render `<FloorPlanCanvas>` in view mode, focused (zoom + pan) to the booking's polygon. Show booking metadata in a small panel. Close button returns to the list.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/pages/desk
git commit -m "feat(floor-plan): View on floor action on bookings list rows (E.2)"
```

**Phase E done.** Operators have spatial visibility alongside the time-axis grid.

---

# Phase F — Polish + Accessibility + Performance

Goal: production-grade polish. Keyboard nav works end-to-end. ARIA labels are useful. Reduced-motion respected. Mobile responsive at 320–428px. Perf verified at 500-polygon load.

### Task F.1: Keyboard navigation in view mode

**Files:**
- Modify: `apps/web/src/components/floor-plan/polygon-shape.tsx` (Tab order, ARIA polished)
- Modify: `apps/web/src/components/floor-plan/floor-plan-canvas.tsx` (focus management)

- [ ] **Step 1: Tab order**

Each `<PolygonShape>` is already focusable (Tab + Enter from Plan 1). Verify the Tab order matches the natural reading direction (top-to-bottom, left-to-right by centroid). Sort polygons in `FloorPlanCanvas` by centroid Y then X before rendering.

- [ ] **Step 2: ARIA polish**

Each polygon's `aria-label` should be: `"Aurora, 8 seats, available"` — name + capacity + state. The canvas itself gets `role="region"` + `aria-label="Floor plan: <floor name>"`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/floor-plan
git commit -m "feat(floor-plan): keyboard a11y + ARIA polish (F.1)"
```

### Task F.2: Reduced motion + mobile tuning

**Files:**
- Modify: `apps/web/src/components/floor-plan/zoom-pan-layer.tsx` (clamp scale animation)
- Modify: `apps/web/src/pages/portal/book-floor/index.tsx` (verify 320–428px layout)

- [ ] **Step 1: Reduced motion**

The global rule already clamps all CSS animations to 0.001ms. Verify the zoom transitions use CSS transform (which respects the global rule), not JS-driven animation. Audit `useEffect` springs.

- [ ] **Step 2: Mobile QA**

Resize the browser to 320px. Verify:
- Time scrubber fits without horizontal scroll.
- Floor pills scroll horizontally.
- Polygons remain clickable (44×44px hit target minimum on touch).
- Bottom sheet half-height fits content.
- Primary CTA stays in safe-area-inset-bottom.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components
git commit -m "feat(floor-plan): mobile QA at 320px + reduced-motion verification (F.2)"
```

### Task F.3: Performance verification at 500 polygons

**Files:**
- Create: `apps/web/src/components/floor-plan/__tests__/perf-large-floor.test.tsx`

- [ ] **Step 1: Synthetic 500-polygon fixture**

Generate a 500-polygon fixture in the test. Render `<FloorPlanCanvas plan={fixture}>`. Use React's profiler (or just `performance.now()` around the render) to measure. Target: < 200ms render, ≥ 30fps during pan/zoom (simulated via wheel events).

If perf < target → file a followup to switch the polygon layer to Konva (canvas). Do not block Phase F shipping.

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/floor-plan/__tests__/perf-large-floor.test.tsx
git commit -m "perf(floor-plan): 500-polygon render budget verification (F.3)"
```

### Task F.4: Final smoke + spec coverage + PR update

- [ ] **Step 1: Full builds + tests**

```bash
pnpm --filter @prequest/api build
pnpm --filter @prequest/web build
pnpm --filter @prequest/shared test
pnpm --filter @prequest/api test floor-plan
pnpm --filter @prequest/web test floor-plan
```

- [ ] **Step 2: Smoke gate**

```bash
# dev API on :3099
API_BASE=http://localhost:3099 pnpm smoke:floor-plans
```
Expected: 22 pass / 0 fail / 3 skip.

- [ ] **Step 3: Push + update PR**

```bash
git push origin worktree-floorplanner
```

If PR #13 is still open (Plan 1 wasn't merged yet), edit its description to note Plan 2 is now also in the branch. If PR was merged and Plan 2 is on a new branch, open a fresh PR.

**Plan 2 done.** Floor plan designer + booking surface ship together.

---

## Followups to track (do NOT block Plan 2)

1. Realtime status `broken`-state writes-disabled UI (current implementation reads only).
2. Multi-touch pinch zoom on mobile (single-touch + scroll works).
3. Reservation creation from polygon click on desktop uses BookingComposerModal — verify the modal pre-fill API supports `{space_id, start_at, end_at}` as initial state.
4. Floor switcher's mini-occupancy bars compute server-side (currently 1 RPC per visible floor — fine at 5 floors, expensive at 50).
5. "Custom" time picker in mobile bottom sheet — full-screen pickers vs inline.
6. AI suggested rooms (roadmap A10) — out of scope for Plan 2.
7. Outlook deep-link integration (roadmap A8 / MS Graph spec) — out of scope for Plan 2.
