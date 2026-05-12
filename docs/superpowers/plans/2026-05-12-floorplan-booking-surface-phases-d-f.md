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

**Schema reality check (per plan-review):** the legacy `reservations` table was DROPPED in the 2026-05-02 booking-canonicalization rewrite (migration 00280). The canonical model is `bookings` + `booking_slots` (migration 00277). Use those.

- `bookings(id, tenant_id, title, description, requester_person_id, host_person_id, booked_by_user_id, location_id, start_at, end_at, timezone, status, ...)`
- `booking_slots(id, tenant_id, booking_id, slot_type, space_id, start_at, end_at, setup_buffer_minutes, teardown_buffer_minutes, effective_start_at, effective_end_at, time_range, ...)`
- `bookings.status` enum: `('draft','pending_approval','confirmed','checked_in','released','cancelled','completed')`. Exclude `draft` and `cancelled` for availability — everything else holds space.
- The space anchor is on **`booking_slots.space_id`**, NOT `bookings.location_id`. Multiple slots per booking (compound bookings).
- Use `booking_slots.time_range && tstzrange(start, end, '[)')` — already indexed (00123 GiST).

**Visibility:** no SQL function `booking_visibility_ids` exists today (the legacy `reservation_visibility_ids` was dropped in 00280; nothing replaced it at SQL). RLS on `bookings` is tenant_isolation only. So:
- DON'T return `current_booking.title` or any per-booking identity in this RPC — that would bypass app-layer visibility entirely. If the requester wants details on the booking blocking a polygon, the UI calls `GET /api/bookings/:id` separately, which can be gated server-side.
- The aggregated `state` ('booked', 'partial', etc.) is anonymized and safe to compute from raw bookings (no leak of identity).
- `'mine'` is safe because we only return it when the caller's own person_id matches — no leak of OTHER users' bookings.

```sql
-- 00375_floor_availability_rpc.sql
-- Returns per-polygon availability state for a time window, with crowd heatmap.
-- Reads from canonical bookings + booking_slots (post-00277). One SQL call.
-- Spec §6.3.
--
-- Visibility model: state is anonymized aggregate (no per-booking identity in
-- this response). The 'mine' branch matches caller's person_id and only the
-- caller can see their own bookings here. UI must call GET /api/bookings/:id
-- (gated) for booking details if needed.

create or replace function public.floor_availability(
  p_tenant_id uuid,
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
  v_tenant_id uuid := p_tenant_id;
  v_caller_person_id uuid;
  v_spaces jsonb;
  v_heatmap jsonb;
  v_day_start timestamptz;
begin
  -- Tenant is passed from the API layer (server-side TenantContext). The RPC is
  -- granted only to service_role, so callers can't forge p_tenant_id or p_user_id.
  if p_tenant_id is null or p_floor_space_id is null then
    raise exception 'floor_plan.availability.invalid_args' using errcode = '22023';
  end if;
  if p_window_start >= p_window_end then
    raise exception 'floor_plan.availability.invalid_window' using errcode = '22023';
  end if;

  -- Resolve caller's person_id (used for 'mine' state). Null when caller has no person link.
  select u.person_id into v_caller_person_id
    from public.users u
   where u.id = p_user_id
     and u.tenant_id = v_tenant_id;

  -- Aggregate per-polygon state for the window.
  with child_spaces as (
    select s.id, s.name, s.type, s.capacity, s.amenities,
           s.floor_plan_polygon, s.floor_plan_render_hint
      from public.spaces s
     where s.parent_id = p_floor_space_id
       and s.tenant_id = v_tenant_id
       and s.floor_plan_polygon is not null
  ),
  overlapping as (
    -- Slot-level status is the canonical holding predicate (codex C6).
    -- 'confirmed' + 'checked_in' + 'pending_approval' hold space; everything
    -- else (draft/cancelled/released/completed) does not.
    select bs.space_id,
           b.id as booking_id,
           bs.start_at, bs.end_at,
           b.requester_person_id, b.host_person_id, b.booked_by_user_id
      from public.bookings b
      join public.booking_slots bs on bs.booking_id = b.id
      join child_spaces cs on cs.id = bs.space_id
     where b.tenant_id = v_tenant_id
       and bs.tenant_id = v_tenant_id
       and bs.time_range && tstzrange(p_window_start, p_window_end, '[)')
       and bs.status in ('confirmed', 'checked_in', 'pending_approval')
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
                        select 1 from overlapping o where o.space_id = cs.id
                      ) then 'available'
                      when v_caller_person_id is not null and exists (
                        select 1 from overlapping o
                         where o.space_id = cs.id
                           and (o.requester_person_id = v_caller_person_id
                                or o.host_person_id = v_caller_person_id
                                or o.booked_by_user_id = p_user_id)
                      ) then 'mine'
                      when exists (
                        select 1 from overlapping o
                         where o.space_id = cs.id
                           and o.start_at <= p_window_start
                           and o.end_at >= p_window_end
                      ) then 'booked'
                      else 'partial'
                    end,
    'free_at',      (
                      select min(o.end_at)
                        from overlapping o
                       where o.space_id = cs.id
                         and o.end_at > now()
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
                      select 1
                        from public.bookings b
                        join public.booking_slots bs on bs.booking_id = b.id
                       where bs.space_id = cs.id
                         and bs.tenant_id = v_tenant_id
                         and b.tenant_id = v_tenant_id
                         and bs.time_range && tstzrange(
                             v_day_start + ((h.h + 7) || ' hours')::interval,
                             v_day_start + ((h.h + 8) || ' hours')::interval,
                             '[)')
                         and bs.status in ('confirmed', 'checked_in', 'pending_approval')
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

-- Grant to service_role only (codex C7). The API must call via admin/service-role
-- client with server-side resolved tenant_id + user_id. authenticated users CANNOT
-- forge p_tenant_id or p_user_id.
revoke all on function public.floor_availability(uuid, uuid, timestamptz, timestamptz, uuid) from public, authenticated;
grant execute on function public.floor_availability(uuid, uuid, timestamptz, timestamptz, uuid) to service_role;

notify pgrst, 'reload schema';
```

Note: queries `bookings` + `booking_slots` (canonical post-00277). Verified column set: `users.person_id`, `bookings.{title, description, requester_person_id, host_person_id, booked_by_user_id, status}`, `booking_slots.{tenant_id NOT NULL, space_id, time_range, status, ...}`. The time_range conflict guard uses the existing `booking_slots_no_overlap` GiST exclusion index.

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
  // p_tenant_id is server-resolved (TenantContext); RPC trusts the param because
  // it's granted only to service_role (codex C5 + C7).
  const { data, error } = await client.rpc('floor_availability', {
    p_tenant_id: tenantId,
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

Add `@Public()` only if anonymous reads are needed. For an authenticated portal, leave it gated — the page primary `useFloorPlanPublished` already requires auth. Availability is a secondary call from an authenticated session.

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
  // No current_booking detail returned at this layer — visibility-anonymized.
  // UI fetches GET /api/bookings/:id (gated) for details if the user clicks.
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

// Secondary query — uses plain useQuery + handleQueryError (NOT usePageQuery), per plan-review I3.
// The page's primary is useFloorPlanPublished (page-class errors take the user to the right
// "no floor plan yet" empty state, not the RouteErrorBoundary).
export function useFloorAvailability(floorSpaceId: string, windowStart: string, windowEnd: string) {
  const query = useQuery(floorAvailabilityOptions(floorSpaceId, windowStart, windowEnd));
  useEffect(() => {
    if (query.error) handleQueryError(query.error, { callSite: 'mutation' });
  }, [query.error]);
  return query;
}
```

- [ ] **Step 4: Realtime invalidation hook**

Confirm `bookings` is in the Supabase realtime publication:
```bash
grep -rn "alter publication supabase_realtime.*bookings\b" supabase/migrations/*.sql | head -3
```
If absent, add a one-line migration `alter publication supabase_realtime add table public.bookings;`.

```ts
// Add to hooks.ts
export function useFloorAvailabilityRealtime(floorSpaceId: string) {
  const qc = useQueryClient();
  useEffect(() => {
    const supa = getSupabaseClient(); // import from @/lib/supabase
    // Subscribe to bookings + booking_slots changes (the canonical model post-00277).
    // Naive: invalidate on ANY change in this tenant. Acceptable at v1 scale (<1k bookings/day);
    // optimize later by filtering server-side on bs.space_id IN (childSpaceIds).
    const channel = supa
      .channel(`floor-${floorSpaceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, () => {
        qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_slots' }, () => {
        qc.invalidateQueries({ queryKey: floorPlanKeys.floor(floorSpaceId) });
      })
      .subscribe();
    return () => { void supa.removeChannel(channel); };
  }, [floorSpaceId, qc]);
}
```

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
- **Primary (`usePageQuery`):** `useFloorPlanPublished(floorSpaceId)` — drives the "no floor plan yet" empty state for unpublished floors. Page-class errors throw to RouteErrorBoundary.
- **Secondary (`useQuery`):** `useFloorAvailability(floorSpaceId, windowStart, windowEnd)` — drives polygon colors + heatmap. Errors handled via `handleQueryError(query.error, { callSite: 'mutation' })`.
- `useFloorAvailabilityRealtime(floorSpaceId)` — auto-invalidates on booking changes.

On polygon click:
- On mobile (< 768px): open `<BookingSheet>` bottom sheet.
- On tablet/desktop (≥ 768px): open the existing `<BookingComposerModal>` pre-filled with `{ space_id, start_at, end_at }`. **Spike required before D.5 step 2:** verify booking-composer-v2 exposes a way to open pre-filled. Likely entry point is `useBookingDraft` (search `apps/web/src/components/booking-composer-v2/`). If pre-fill API is non-trivial, scope this as its own task before continuing D.5.

- [ ] **Step 2: `<BookingSheet>` (mobile bottom sheet)**

**Pre-spike (REQUIRED):** locate the create-booking mutation that BookingComposerModal uses today.
```bash
grep -rn "useCreateBooking\|useMutation.*bookings\|POST.*bookings" apps/web/src/components/booking-composer-v2 apps/web/src/api 2>/dev/null | head -10
```
If the mutation is bundled into a UI component (not a standalone hook), extract it to a shared hook in `apps/web/src/api/bookings/mutations.ts` FIRST as its own commit. Then the sheet imports the hook cleanly.

Use shadcn `<Sheet>` with `side="bottom"`. Header: status dot + room name + floor. Amenity icon row. Quick time pills: `Now` / `in 30m` / `this PM` / `Custom`. Selected window readout. Primary CTA `Book <Room>`.

**Form conventions (per CLAUDE.md):**
- All inputs (the Custom-time picker) use shadcn `Field` primitives — no raw labels/inputs.
- Mutation wraps `withErrorHandling({ actionTitle: "Couldn't book {room}" })`.
- On success: `toastCreated('Booking', { onView: () => navigate(`/portal/me-bookings/${id}`) })`.
- On 409/conflict (someone else booked first): the realtime invalidation will re-fetch availability; show a toast linking to the next available slot.

For "Custom" time, expand inline date+time pickers using shadcn `Field` + `Input type=datetime-local`.

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

**Mobile click-to-book acceptance path** (the core user flow):
1. Open `/portal/book/floor` at 375×667 viewport.
2. See the building/floor switcher, time scrubber with crowd heatmap, and a floor plan with at least one **available** (green) polygon.
3. Tap the available polygon.
4. Bottom sheet slides up: status dot + room name + amenity icons + Quick pills (Now/in 30m/this PM/Custom) + window readout.
5. Tap "Book Aurora" (or whatever the room is).
6. Toast appears: "Booking created — View".
7. Sheet closes. The polygon flips from green → blue (`mine` state) within 2s (realtime invalidation).
8. Tap the polygon again → sheet shows "Your booking · 14:30–15:30" with a "Cancel" action.

This flow is non-negotiable for shipping Plan 2. If any step breaks, file a bug and fix before claiming F.4 done.

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
3. Floor switcher's mini-occupancy bars compute server-side (currently 1 RPC per visible floor — fine at 5 floors, expensive at 50).
4. "Custom" time picker in mobile bottom sheet — full-screen pickers vs inline.
5. AI suggested rooms (roadmap A10) — out of scope for Plan 2.
6. Outlook deep-link integration (roadmap A8 / MS Graph spec) — out of scope for Plan 2.
7. **Parking booking via map** — Plan 2 wires room/desk reservations only. Parking has its own booking flow (per spec §1.1 it's in-scope for the renderer; mobile sheet's `Book <Room>` CTA assumes rooms/desks). Add explicit parking flow in a v2.
8. **Visitor flag on map** — spec mentions visitor-as-bundle-line on polygons; not in Plan 2 scope. Visitors module already exists; integration is a follow-up.
9. **Hot-desk zone** (spec §3.4 C) — interchangeable seats with server-assignment. Deferred; tenant request gated.
10. **Booking details on polygon click** — current RPC returns anonymized state only (no booker identity / title). When the booker IS the caller (`'mine'` state), we should still surface "your booking 14:30–15:30" — call `GET /api/bookings/:id` via a separate gated query when the polygon's state === 'mine'.

## Plan-review delta (what changed pre-code)

Two adversarial rounds (full-review skill + codex) caught 7 CRITICAL + 17 IMPORTANT issues before any task touched code:

### Round 2 — codex (post-/full-review fixes)

| # | Severity | Fix |
|---|---|---|
| codex-C5 | CRITICAL | RPC takes `p_tenant_id` as a parameter, server-resolved from `TenantContext`. Avoids the empty-result bug where `current_tenant_id()` returned NULL because the admin client bypassed JWT context. |
| codex-C6 | CRITICAL | Status filter is **slot-level** (`bs.status in ('confirmed','checked_in','pending_approval')`), not booking-level. Released and completed slots no longer hold space. |
| codex-C7 | CRITICAL | RPC grants EXECUTE only to `service_role`, not `authenticated`. Prevents forging `p_user_id` to infer other users' bookings. The TS service uses `this.supabase.admin` which already runs as service_role. |
| codex-I1 | IMPORTANT | Stale C1-era guidance removed (the "verify `\d public.reservations`" note that contradicted the bookings-based SQL). |
| codex-I-mobile | IMPORTANT | Mobile click-to-book acceptance criteria added: tap available polygon → bottom sheet → create booking → toast → polygon turns `mine`. |
| codex-NIT | NIT | Verified schema: `users.person_id` exists, `booking_slots.tenant_id NOT NULL`, `bookings.title/description` exist, `time_range` covered by `booking_slots_no_overlap` GiST exclusion (not a separate index). |

### Round 1 — /full-review (initial draft)

| # | Severity | Fix |
|---|---|---|
| C1 | CRITICAL | RPC rewritten to use `bookings` + `booking_slots` (the canonical post-00277 model). The legacy `reservations` table was dropped in 00280; the original plan was built on a non-existent table. |
| C2 | CRITICAL | Status enum corrected — exclude `'draft'` and `'cancelled'`; allow all others (incl. `'completed'`, `'released'`, `'checked_in'`, `'pending_approval'`, `'confirmed'`). |
| C3 | CRITICAL | Visibility-leak avoided — no `current_booking.title` / identity in the response. State is anonymized aggregate; identity in `'mine'` only matches caller's own person. Booking details go through gated `GET /api/bookings/:id`. |
| C4 | CRITICAL | Controller mount path explicit: endpoint added to `FloorPlanController` (already mounted at `floors/:floorSpaceId/plan`) — resolves to `/api/floors/:id/plan/availability`. |
| I3 | IMPORTANT | `useFloorAvailability` uses plain `useQuery` + `handleQueryError`, not `usePageQuery`. Page primary is `useFloorPlanPublished` (correct "no plan yet" empty state). |
| I4 | IMPORTANT | Added pre-spike to extract create-booking mutation to a shared hook before BookingSheet uses it. |
| I7 | IMPORTANT | Floor switcher mini-occupancy N+1 acknowledged as v1 acceptable; promoted to followup #3. |
| I8 | IMPORTANT | Scheduler ↔ floor-plan window binding (E.1) flagged with required spike before E.1 implementation. |
| I9 | IMPORTANT | "View on floor" (E.2) requires bookings list to include polygon presence — added to E.2 step note. |
| I10 | IMPORTANT | BookingSheet mutation respects `broken` realtime state today; documented. |
| N1 | NIT | `useNow` confirmed to exist at `apps/web/src/lib/use-now.ts`. |
| N5 | NIT | Field primitives mandate in BookingSheet documented. |
| N6 | NIT | `withErrorHandling` for BookingSheet mutation documented. |
| N7 | NIT | Out-of-scope callouts added (parking, visitor flag, hot-desk zone). |
| N8 | NIT | Plan 1 dependency check added to Pre-flight Step 0. |

Realtime publication (I1): `bookings` and `booking_slots` need to be in `supabase_realtime` publication. Added explicit check + one-line migration if absent in D.2 Step 4.
