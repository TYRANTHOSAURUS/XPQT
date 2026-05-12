# Floor Plan Designer and Map-Based Booking — Design

**Status:** draft (brainstormed 2026-05-12, awaiting user approval before plan)
**Owner:** worktree `worktree-floorplanner`
**Roadmap item:** A5 in `docs/booking-platform-roadmap.md` — Tier 1, PARITY with Robin/deskbird
**Decision context:** Build, do not buy. Vendor options (Mappedin, MazeMap) were evaluated and rejected — see §1.3.

## 1. Scope and intent

### 1.1 What this spec covers

A **floor plan designer** for admins (browser-based, vector authoring on top of an uploaded floor image) and a **map-based booking surface** for end users (employees in the portal, operators in the desk app). Both share one renderer and one data model.

Three space types in scope: **rooms**, **desks**, **parking slots**. All represented as polygons (see §3.4).

Three surfaces host the booking map:
- `/portal/book/floor` — employee portal, mobile-first
- `/desk/scheduler` — operator overview, toggle alongside the existing time-axis grid
- `/desk/bookings` — "view on floor" affordance per row

Tenant scope: any tenant with `floor_plans.author` permission can author. Booking surfaces follow existing room/desk visibility rules and `request_type` availability.

### 1.2 What this spec does NOT cover

Deferred to follow-up specs:

- **Blank-canvas authoring** ("draw a floor from scratch with no image"). v1 is trace-only — admin uploads an image (PDF page, PNG, JPG, SVG, even a photo) and traces polygons over it.
- **CAD auto-ingest** (DWG/DXF/IFC → polygons). Deep rabbit hole — even vendors do this semi-manually. CAD-equipped tenants export PDF/SVG and trace once.
- **Zone-with-counter** ("one polygon, N interchangeable seats, server assigns on click"). Different booking flow; rare in practice. Adds a `floor_plan_zones` table when a real tenant asks.
- **Kiosk surface** (lobby touch screen). Larger scope: kiosk auth, big-touch-target UI. v2.
- **Wayfinding** (turn-by-turn directions on the map). Out of scope.
- **3D / multi-floor cutaway views.** Out of scope.

### 1.3 Build vs. buy — why we're not using Mappedin or MazeMap

Mappedin and MazeMap are the two credible vendors for indoor mapping. Both rejected:

1. **Best-in-class beautiful experience is impossible inside an embedded vendor map.** The product would visibly switch design languages when the floor view loads. Robin and deskbird both rebuilt theirs in-house for this reason.
2. **Vendor lock-in on spatial data conflicts with Prequest's "legacy replacement" thesis.** Tenants migrate to Prequest to escape data lock-in. Putting their floor plans into a US/Canada SaaS reproduces the problem we're solving.
3. **GDPR + EU residency** (per `project_market_benelux`) is harder when the spatial layer is third-party.
4. **Vendor cost** is recurring and undisclosed (custom-quoted by venue size). At Prequest's intended scale this is a 5-figure annual line item with no public price discipline.
5. **The existing schema** (`floor_plans` and `spaces.floor_plan_polygon` from 00120 + 00127) already commits us to an owned model.

Build-it cost: ~6–8 weeks for designer + booking surface (per AI calendar inflation correction in `feedback_discount_ai_timelines`, treat as that order of magnitude in real time).

## 2. Glossary

- **Floor** — a `spaces` row with `type='floor'`. The unit a floor plan is attached to.
- **Polygon** — an ordered list of `{x, y}` points in pixel space relative to the floor plan's image. Stored as JSONB.
- **Trace mode** — authoring by drawing polygons on top of an uploaded background image.
- **Render hint** — optional per-polygon flag controlling renderer behavior (`default | seat | parking`).
- **Draft** — in-progress floor plan edit, isolated from the published version.
- **Publish** — atomic swap of draft state into the canonical published state.
- **Time window** — the user-selected `[start, end]` interval that drives availability rendering.

## 3. Data model

### 3.1 Existing (already shipped)

```sql
-- 00127_floor_plans.sql
create table public.floor_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  space_id uuid not null references public.spaces(id),  -- the floor
  image_url text not null,
  width_px int not null,
  height_px int not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (space_id)
);

-- 00120_spaces_room_booking_columns.sql (partial)
alter table public.spaces add column floor_plan_polygon jsonb;
```

**Interpretation:** `floor_plans` holds one raster image per floor. `spaces.floor_plan_polygon` holds the polygon for any space — room, desk, or parking slot — drawn on its parent floor's plan. Polygon shape:

```json
{ "points": [{"x": 120, "y": 85}, {"x": 280, "y": 85}, {"x": 280, "y": 200}, {"x": 120, "y": 200}] }
```

The polygon is in pixel space relative to the `floor_plans.image_url`'s natural width/height (`width_px`/`height_px`). The renderer scales the image and polygons together for zoom — they stay in lockstep because they share the same coordinate space.

### 3.2 New columns (migration 00367)

```sql
alter table public.spaces
  add column if not exists floor_plan_render_hint text not null default 'default'
    check (floor_plan_render_hint in ('default', 'seat', 'parking'));
```

**Why:** the renderer adapts based on polygon size (small polygons render as seat dots, big ones as labeled rectangles), but admins occasionally want to force the seat-dot or parking look regardless of polygon size. This is an override hint, not a separate model.

### 3.3 New table — drafts (migration 00368)

```sql
create table public.floor_plan_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  floor_space_id uuid not null references public.spaces(id),
  image_url text,
  width_px int,
  height_px int,
  polygons jsonb not null default '[]'::jsonb,
  labels jsonb not null default '[]'::jsonb,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (floor_space_id)
);

alter table public.floor_plan_drafts enable row level security;

create policy "tenant_isolation" on public.floor_plan_drafts
  using (tenant_id = public.current_tenant_id());

create trigger set_floor_plan_drafts_updated_at
  before update on public.floor_plan_drafts
  for each row execute function public.set_updated_at();
```

`floor_plan_drafts.polygons` shape:

```json
[
  {
    "space_id": "uuid",
    "points": [{"x": 120, "y": 85}, ...],
    "render_hint": "default" | "seat" | "parking"
  },
  ...
]
```

**Why per-floor unique:** one draft per floor at a time. If a second admin opens the designer while a draft exists, they see the existing draft and a soft-lock chip ("draft started by Maria 12 min ago — take over?"). Take-over reassigns `created_by`.

**Why polygons are duplicated into the draft** (rather than editing `spaces.floor_plan_polygon` directly): the booking surface reads from `spaces.floor_plan_polygon`. Mutating those columns mid-edit means employees see half-drawn floors. Draft isolation guarantees the published state is always coherent.

### 3.4 Polygon model — one shape, three rendering modes

**One model.** Every desk, room, parking slot stores a polygon in `spaces.floor_plan_polygon`. The renderer decides what to draw based on the polygon's *rendered size on screen* and the optional `floor_plan_render_hint`:

| Rendered size | render_hint | Output |
|---|---|---|
| ≥ ~6000 px² | default | Labeled rectangle: name + capacity + status |
| < ~6000 px² | default | Seat circle at centroid + tooltip on hover |
| any | seat | Always seat circle (overrides size heuristic) |
| any | parking | "P" glyph + slot number |

The same polygon JSON drives all three. The "A vs B" appearance from the brainstorm screens emerges from polygon size, not from two authoring modes.

**Designer gestures.** Two shortcuts in the designer, both producing polygons:
- **Draw shape** — click corners, double-click to close. Produces an arbitrary polygon. Used for rooms, large workstations, parking slots, irregular shapes.
- **Stamp seat** — click once at the desk center. Drops a standardized small polygon (default 60×40 px ≈ 90×60 cm at typical scale). Used for typical office desks. Authoring 200 desks via Stamp Seat is fast; doing the same via Draw Shape would be miserable.

### 3.5 Per-space relationships

The `floor_plan_polygon` belongs to a `spaces` row. That row's `parent_id` should be the floor (`spaces` row with `type='floor'`) the polygon is drawn on. The designer enforces this at save time:

- Drawing a polygon for a `spaces` row whose `parent_id` is not the open floor → either reparent the row (admin opt-in confirm) or refuse to save.
- Linking a polygon to a `spaces` row whose `tenant_id` ≠ current tenant → hard rejection (this would be a cross-tenant leak; surface as `validation` error).

### 3.6 Realtime channel

The booking surface subscribes to two Supabase Realtime channels for the open floor:

- `reservations` — INSERT / UPDATE / DELETE on rows where `space_id IN (children of floor_space_id)` triggers re-render.
- `tickets` (work orders that block a space, e.g., maintenance) — same scope, same behavior.

Realtime status integrates with the existing `RealtimeStatusStore` and `useRealtimeStatus()` hook (per project's error-handling spec). The 6×6 status dot lives in the page header.

**Hop limit:** the renderer re-fetches the affected reservation set on each event, not the whole floor. Target latency p95 < 2s from someone else's booking commit to other viewers seeing the recolor.

## 4. Renderer — `<FloorPlanCanvas>`

### 4.1 Component shape

```tsx
type Props = {
  floorSpaceId: string;
  timeWindow: { start: ISOString; end: ISOString };
  currentUserId: string;
  mode: 'view' | 'edit';
  onSpaceClick?: (spaceId: string) => void;
  onDraftChange?: (next: FloorPlanDraftState) => void;
};
```

In `view` mode: read-only renderer driven by `useFloorPlanForFloor(floorSpaceId)` + `useReservationsForFloorWindow(floorSpaceId, timeWindow)`. In `edit` mode: same renderer plus drawing/selection layer, driven by the draft state (managed by `<FloorPlanDesigner>`).

### 4.2 Rendering pipeline

1. Fetch the published `floor_plans` row (or draft, if `mode='edit'`).
2. Fetch the floor's child `spaces` rows (only those with non-null `floor_plan_polygon` for `view` mode; all for `edit` mode so unlinked spaces show in the left rail).
3. Fetch reservations overlapping `timeWindow` for those spaces.
4. Compute per-space availability state: `available | partial | booked | mine | pending | not_bookable`.
5. Compute "free in N min" badge if `now ∈ timeWindow` and state is `booked` and there's no booking starting within next 30 min.
6. Render in z-order:
   - Background image (`image_url`, scaled to canvas)
   - Polygons (largest first, smallest last → small ones sit on top, never occluded by big ones)
   - Labels (if polygon area ≥ threshold)
   - Seat dots (if polygon area < threshold, drawn at polygon centroid)
   - Selection handles (edit mode only)

### 4.3 SVG vs Canvas vs WebGL

**SVG.** Reasoning:
- Polygons at typical floor sizes (≤500 shapes per floor) render fast in SVG with no perf concerns.
- SVG is keyboard-accessible by default (each polygon is a focusable element with `tabindex`, `aria-label`, `onKeyDown` → Enter activates).
- Hit-testing comes for free (`onClick` per polygon).
- Animations via Framer Motion (`<motion.polygon>` for hover/select transitions).
- Scales infinitely with zoom — no pixelation.

Fallback path if perf degrades: switch the polygon layer to Konva (canvas). The data model and component API don't change. The realistic floor scale stays well within SVG limits.

### 4.4 Pan, zoom, fit

- **Click-drag** to pan. Cursor cycles `grab` → `grabbing` on press.
- **Scroll wheel** to zoom, zooming toward the cursor position (Google Maps / Figma convention).
- **Pinch** on touch/trackpad to zoom.
- **Two-finger drag** on trackpad to pan.
- **Fit to screen** button — collapses to one icon on mobile, expands to a control row on desktop. Default zoom on first load = fit-to-screen.
- Map fills its parent's available height. No parent scroll conflict because the parent layout reserves a viewport.

Implementation: a small `<ZoomPanLayer>` wrapping the SVG. State `{ scale: number, tx: number, ty: number }`. CSS transform on the inner `<g>`. Bound scale to `[0.25, 8]`.

### 4.5 Color palette (locked)

| State | Outline | Fill | Status dot |
|---|---|---|---|
| Available | `#86efac` (1.5px) | `#f0fdf4` | `#22c55e` |
| Partially available | `#fcd34d` (1.5px) | striped `#f0fdf4` + `#fca5a5` 135° | `#84cc16` + `#ef4444` (dual) |
| Booked | `#fca5a5` (1.5px) | `#fef2f2` | `#ef4444` |
| Mine | `#60a5fa` (2px) | `#eff6ff` | `#3b82f6` |
| Pending approval | `#fcd34d` (1.5px) | `#fffbeb` | `#f59e0b` |
| Not bookable | `#d6d3d1` (1px dashed) | `#fafaf9` | `#d6d3d1` |

"Free in N min" doesn't get its own state — it's a `Booked` polygon with a different subtext.

Crowd heatmap on the time scrubber uses a green→amber→red gradient: `#d1fae5 #a7f3d0 #86efac #fcd34d #fb923c #f87171 #ef4444` based on `% of bookable rooms occupied` at each hour.

### 4.6 Time scrubber

A persistent horizontal strip at the top of the booking surface:
- 7am–7pm range (driven by the floor's `business_hours_calendars` association if set; else 7–19).
- Per-hour vertical bars showing aggregate floor occupancy. Bar height = `% bookable rooms booked`. Color follows the heatmap palette.
- Dashed vertical line for "now".
- Solid vertical line + filled dot for "selected start". A second smaller handle on the right of the selection sets duration.
- Tabular-num readout at the right: `"selected: 14:30 → 15:30"`.

Mobile: same scrubber, narrower bars, hour labels every 2 hours.

### 4.7 Floor switcher

Between the time scrubber and the floor plan:

- **Building pill** (left). Shows `tenants.name` or the current building. Dropdown when tenant has >1 building. Hidden when there's only one building (auto-collapse).
- **Floor pills** (center). One pill per floor in the selected building, ordered by floor number. Each pill shows the floor label (`G`, `1`, `2`, …) and a thin mini-bar underneath = aggregate occupancy at the selected time. Selected floor is rendered with `bg-foreground text-background`. Floors with no published plan render with a dashed border + muted label and route to a "this floor doesn't have a plan yet" empty state when clicked.
- **Viewport controls** (right). Zoom in / zoom out / fit-to-screen. On mobile, collapsed to one fit-to-screen circle.

Floors are derived from `spaces` rows with `type='floor'` and `parent_id = <selected_building_id>`.

## 5. Designer — `<FloorPlanDesigner>`

### 5.1 Layout

Figma-style, locked. Three regions:

- **Top bar** (48px). Building + floor breadcrumb, save status chip (`saved` / `saving…` / `error`), zoom %, undo/redo, **Publish** button.
- **Left rail** (240px). Spaces tree for the current floor. Each row: status dot (drawn / in progress / issue), name, capacity. Click a row to focus/zoom its polygon; double-click to start editing it. Separate sub-list at bottom for unlinked draft polygons (drawn but not yet linked to a `spaces` row).
- **Tool dock** (44px). 7 tools: Select · Draw polygon · Draw rectangle · Stamp seat · Parking slot · Label · Image upload. Keyboard shortcuts (`V`, `P`, `R`, `S`, `K`, `T`, `I`).
- **Canvas** (center). Background image faded to ~35% opacity. Polygons rendered with edit affordances (vertex handles when selected, midpoint handles for inserting vertices).
- **Right inspector** (244px). Properties of the selected polygon: linked `spaces` row (combobox), capacity, amenities (chip multi-select), render hint, vertex count, area in m², "Detach from floor plan" danger action.

Hidden chrome:
- Bottom of left rail: legend of status dots.
- Bottom of canvas: snap-to-grid toggle, snap-to-vertex toggle, image opacity slider.

### 5.2 Tools

**Select (`V`).** Click polygon to select. Drag handles to reshape. Drag interior to move. Shift-click to multi-select. Backspace deletes (with confirm if linked to a space).

**Draw polygon (`P`).** Click to add vertex. Enter or double-click last to close. Esc cancels. Right-click on a vertex while drawing deletes it. Snapping: vertex snaps to nearest existing vertex within 8 px and to grid lines within 4 px.

**Draw rectangle (`R`).** Click + drag. Drag end positions the opposite corner. Hold Shift for square.

**Stamp seat (`S`).** Click once. Drops a 60×40 px polygon with `render_hint='seat'`. Pre-fills the linked space with a desk row from the current floor's children that has no polygon yet (FIFO). If no unlinked desk exists on this floor, the designer auto-creates a new `spaces` row with `type='desk'`, `parent_id=<floor_space_id>`, `name='Desk <next-sequence-number>'`, `tenant_id=<current_tenant_id>`. Admin can rename it later via the inspector. Hold Shift to stamp multiple in a row (cursor stays in stamp mode).

**Parking slot (`K`).** Click + drag (rectangle). Pre-fills `render_hint='parking'`.

**Label (`T`).** Click. Drops a non-polygon label (e.g., "Lounge"). Stored as a separate concern (see §5.6).

**Image upload (`I`).** Opens file picker. Replaces the draft's `image_url`/`width_px`/`height_px`. Existing polygons are NOT remapped (their pixel coords were relative to the old image). The designer surfaces a warning banner: "Image replaced. Existing polygons may need to be remapped." It does NOT auto-remap — that's a v2 tool.

### 5.3 Draft lifecycle

1. **Open designer for floor X.**
   - If `floor_plan_drafts` row exists for X: load it. If `created_by` ≠ current user and `updated_at` < 24h ago, show take-over chip.
   - Else: create a new draft. Seed `image_url`/`width_px`/`height_px` from the published `floor_plans` row (if any). Seed `polygons` by copying every child space's `floor_plan_polygon` + `floor_plan_render_hint`.
2. **Edit.** Autosave the entire `polygons` jsonb every 500ms-debounced after a change. UI shows `saving…` then `saved`.
3. **Publish.** Confirm dialog shows a diff: added polygons, changed polygons, removed polygons, image changed/not. On confirm, calls `publish_floor_plan_draft(draft_id)` (see §6.2).
4. **Discard draft.** Optional action on the publish dialog or top bar dropdown. Deletes the `floor_plan_drafts` row. No effect on published state.

### 5.4 Undo / redo

Local-only in the browser. Stack of `polygons` jsonb snapshots, capped at 50. Cmd/Ctrl-Z and Cmd/Ctrl-Shift-Z. Cleared on page reload (the persisted state is in the draft on disk, not the undo history).

### 5.5 Validation in the designer

Real-time checks, all rendered as left-rail status:

| Check | Severity | Resolution |
|---|---|---|
| Polygon links to a deleted space | Issue (red dot) | Click row → "Detach" button |
| Polygon outside floor image bounds | Issue | Drag back inside, or shrink to fit |
| Polygon area < 200 px² (likely accidental tap) | Warning | Designer prompts "tiny polygon — keep?" |
| Polygon overlaps another by >70% area | Warning | Designer flags both polygons with amber dot |
| Polygon has <3 vertices | Issue (auto-deleted) | Internal — never persisted |
| Space exists for this floor but no polygon | Info ("not drawn" muted dot) | Designer left rail shows in muted style |

None of these block publish. They're informational. The single hard publish requirement is "every polygon links to a `spaces` row in the current tenant whose `parent_id = floor_space_id`".

### 5.6 Labels (non-polygon annotations)

Labels are short text strings positioned on the canvas. They're not bookable. They exist to mark areas like "Lounge", "Reception", "Kitchen" without modeling them as `spaces`.

Stored on the floor plan (not on `spaces`):

```sql
-- inside floor_plan_drafts.polygons jsonb sibling, or a separate labels jsonb column
alter table public.floor_plans
  add column if not exists labels jsonb not null default '[]'::jsonb;
-- shape: [{ "text": "Lounge", "x": 690, "y": 250, "size": 11 }]
```

Drafts carry the same `labels` jsonb. Publish copies labels into the canonical `floor_plans` row.

## 6. Backend services

### 6.1 New module — `apps/api/src/modules/floor-plan/`

```
floor-plan/
├── floor-plan.module.ts
├── floor-plan.controller.ts        // REST endpoints for designer + booking
├── floor-plan.service.ts           // business logic + RPC orchestration
├── floor-plan-draft.service.ts     // draft-specific operations
├── dto/
│   ├── update-draft.dto.ts
│   ├── publish-draft.dto.ts
│   └── …
├── tests/
│   ├── floor-plan.service.spec.ts
│   ├── publish-rpc.spec.ts
│   └── cross-tenant.spec.ts
```

The module exports a `FloorPlanService` for cross-module reads (e.g., the existing `RoomService` may want to expose `hasFloorPlan: boolean` on its room list response).

### 6.2 Publish RPC — `publish_floor_plan_draft(draft_id)` (migration 00369)

Per CLAUDE.md, **multi-step writes go through one PL/pgSQL function**. The publish flow touches 3 tables:

1. UPSERT `floor_plans` (insert or update by `space_id`, set `image_url`/`width_px`/`height_px`/`labels`).
2. For each polygon in `draft.polygons`: UPDATE `spaces.floor_plan_polygon` and `floor_plan_render_hint` WHERE `id = polygon.space_id AND tenant_id = draft.tenant_id`.
3. For every child space of the floor not represented in the new draft.polygons: NULL its `floor_plan_polygon`.
4. DELETE the `floor_plan_drafts` row.
5. INSERT into `audit_events` with the diff payload.

Atomic. The `tenant_id` filter on every step is the cross-tenant safeguard (per `feedback_tenant_id_ultimate_rule`).

```sql
create or replace function public.publish_floor_plan_draft(p_draft_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_draft record;
  v_tenant_id uuid;
  v_floor_id uuid;
  v_polygon jsonb;
  v_space_ids uuid[];
begin
  select * into v_draft from public.floor_plan_drafts where id = p_draft_id;
  if v_draft is null then
    raise exception 'floor_plan_drafts.not_found' using errcode = 'P0002';
  end if;

  v_tenant_id := v_draft.tenant_id;
  v_floor_id  := v_draft.floor_space_id;

  -- tenant safeguard: caller must be in the same tenant
  if v_tenant_id <> public.current_tenant_id() then
    raise exception 'floor_plan_drafts.cross_tenant' using errcode = '42501';
  end if;

  -- upsert floor_plans
  insert into public.floor_plans (tenant_id, space_id, image_url, width_px, height_px, labels)
  values (v_tenant_id, v_floor_id, v_draft.image_url, v_draft.width_px, v_draft.height_px, coalesce(v_draft.labels, '[]'::jsonb))
  on conflict (space_id) do update
    set image_url  = excluded.image_url,
        width_px   = excluded.width_px,
        height_px  = excluded.height_px,
        labels     = excluded.labels,
        updated_at = now();

  -- collect space_ids in the new draft
  select coalesce(array_agg((p->>'space_id')::uuid), '{}'::uuid[])
    into v_space_ids
    from jsonb_array_elements(v_draft.polygons) p;

  -- detach orphans (spaces previously had a polygon on this floor but aren't in the new draft)
  update public.spaces
     set floor_plan_polygon = null,
         floor_plan_render_hint = 'default'
   where tenant_id = v_tenant_id
     and parent_id = v_floor_id
     and floor_plan_polygon is not null
     and id <> all(v_space_ids);

  -- apply new polygons
  for v_polygon in select jsonb_array_elements(v_draft.polygons) loop
    update public.spaces
       set floor_plan_polygon     = v_polygon->'points',
           floor_plan_render_hint = coalesce(v_polygon->>'render_hint', 'default')
     where id = (v_polygon->>'space_id')::uuid
       and tenant_id = v_tenant_id
       and parent_id = v_floor_id;
  end loop;

  -- audit
  insert into public.audit_events (tenant_id, kind, payload, created_by)
  values (v_tenant_id, 'floor_plan.published',
          jsonb_build_object('floor_space_id', v_floor_id, 'draft_id', p_draft_id),
          v_draft.created_by);

  -- delete draft
  delete from public.floor_plan_drafts where id = p_draft_id;
end;
$$;

revoke all on function public.publish_floor_plan_draft(uuid) from public;
grant execute on function public.publish_floor_plan_draft(uuid) to authenticated;
```

### 6.3 REST endpoints

```
GET    /api/floors/:floorSpaceId/plan                    // published view (image + polygons)
GET    /api/floors/:floorSpaceId/plan/draft              // current draft (creates if absent)
PATCH  /api/floors/:floorSpaceId/plan/draft              // update draft fields/polygons
POST   /api/floors/:floorSpaceId/plan/draft/publish      // calls publish_floor_plan_draft RPC
DELETE /api/floors/:floorSpaceId/plan/draft              // discard draft

GET    /api/buildings/:buildingId/floors                 // floors with hasPlan + occupancy summary
GET    /api/floors/:floorSpaceId/availability?from&to    // aggregated state per polygon space
```

`GET …/availability` returns:

```json
{
  "floor_space_id": "uuid",
  "window": { "start": "...", "end": "..." },
  "spaces": [
    {
      "id": "uuid",
      "type": "meeting_room",
      "name": "Aurora",
      "polygon": { "points": [...] },
      "render_hint": "default",
      "capacity": 8,
      "amenities": ["whiteboard", "video"],
      "state": "available" | "partial" | "booked" | "mine" | "pending" | "not_bookable",
      "freeAt": "2026-05-12T15:30:00Z" | null,
      "currentBooking": { "id": "...", "title": "...", "owner": "..." } | null
    },
    ...
  ],
  "crowdHeatmap": [
    { "hour": 7, "occupancy": 0.05 },
    ...
  ]
}
```

The `state` value is computed server-side. Visibility rules (per `docs/visibility.md`) filter what's included — invisible bookings show their room as `booked` without `currentBooking.owner` or `currentBooking.title`.

### 6.4 React Query keys

Following `docs/react-query-guidelines.md`:

```ts
// apps/web/src/api/floor-plans/keys.ts
export const floorPlanKeys = {
  all: ['floor-plans'] as const,
  building: (buildingId: string) => [...floorPlanKeys.all, 'building', buildingId] as const,
  floor: (floorSpaceId: string) => [...floorPlanKeys.all, 'floor', floorSpaceId] as const,
  floorAvailability: (floorSpaceId: string, window: TimeWindow) =>
    [...floorPlanKeys.floor(floorSpaceId), 'availability', window.start, window.end] as const,
  floorDraft: (floorSpaceId: string) =>
    [...floorPlanKeys.floor(floorSpaceId), 'draft'] as const,
};
```

`usePageQuery` for primary fetches (per `docs/superpowers/specs/2026-05-02-error-handling-system-design.md`); plain `useQuery` for sidebar/picker fetches.

Realtime invalidations: subscribe to Supabase `reservations` and `tickets` channels filtered by `space_id IN (children of floor)`, invalidate `floorPlanKeys.floorAvailability(...)` on event.

## 7. Frontend routes and pages

### 7.1 Admin designer route

```
/admin/floor-plans                              — index page, list of buildings + floors
/admin/floor-plans/:floorSpaceId                — designer for one floor
```

Index page uses `SettingsPageShell width="default"`, header + table of (building / floor / has plan / last published / draft author).

Designer page uses `SettingsPageShell width="full"` (per CLAUDE.md: "complex consoles" use full-bleed, designer is also exempt-from-shell territory but we keep the shell for back navigation). Header has `backTo="/admin/floor-plans"`.

### 7.2 Portal booking route

```
/portal/book/floor                              — new map view, mobile-first
/portal/book/floor/:floorSpaceId                — direct link to a specific floor
```

Default floor on first visit = the user's `persons.default_location` (per `project_person_default_location`).

### 7.3 Desk scheduler integration

`/desk/scheduler` gets a view toggle: `Timeline | Floor plan`. Persists per-user via localStorage. Floor plan view reuses the same `<FloorPlanCanvas>` but with the operator scope.

### 7.4 Desk bookings list integration

`/desk/bookings` gets a "View on floor" action per row (context menu + new button on the detail drawer). Opens a dialog with `<FloorPlanCanvas>` centered on that booking's space.

## 8. Permissions

### 8.1 New permission keys (migration 00370)

Add to `packages/shared/src/permission-catalog.ts` (migration 00371 inserts matching rows into the catalog table):

```ts
'floor_plans.author',   // open the designer, create/edit drafts
'floor_plans.publish',  // publish a draft (separate so reviewers author, admins publish)
'floor_plans.delete',   // delete a published floor plan (unpublish + clear polygons)
```

Update role defaults in `packages/shared/src/permission-role-defaults.ts`:

- Workplace Admin: all three.
- Locations Admin (if it exists): `floor_plans.author` + `floor_plans.publish`.
- (No need to grant author to anyone else; tenants can override via role editor.)

The 8-test CI gate from `project_permission_catalog_enforcement_shipped` must keep passing.

### 8.2 Booking surface permissions

No new permissions for booking. The map filters by `ticket_visibility_ids` for current bookings (per `docs/visibility.md`) and the existing `request_types.availability_mode` controls which polygons are bookable. A polygon with no permission to book renders, but click → toast "You can't book this room".

### 8.3 RLS

- `floor_plan_drafts`: tenant_isolation policy (see §3.3).
- `floor_plans`: existing tenant_isolation policy from 00127.
- The publish RPC is `security definer` but checks `current_tenant_id()` matches the draft's `tenant_id`.

## 9. Edge cases

### 9.1 Floor with no published plan

- Booking surface: floor pill is dashed. Click → empty state "This floor doesn't have a plan yet" with link to list-view of the floor's rooms. Existing list booking flow still works.
- Designer: index page shows "no plan" badge; click opens designer in a fresh draft.

### 9.2 Space deleted while polygon exists

- Polygon becomes an orphan. Renderer ignores it (it's keyed off `spaces.floor_plan_polygon`, and the space row is gone).
- Designer: orphan handling is moot — the polygon's row no longer exists. If a `spaces` row is soft-deleted (we don't currently soft-delete spaces, hard-delete only) we'd revisit.

### 9.3 Image replaced mid-edit

- Draft's `image_url` updates. Polygons stay (their pixel coords were relative to the old image).
- Designer banner: "Image replaced — verify polygon positions before publishing." No auto-remap.
- v2: a "remap" tool (align reference points between old and new image, transform polygons).

### 9.4 Booking exists for a polygon that's about to be deleted on publish

- Publish flow does NOT cancel bookings. The polygon vanishes from the floor plan, but the `reservations` rows remain.
- Booking surface for affected dates: room still shows in list-view; it just doesn't appear on the floor plan. Lossy but not destructive.
- Designer publish-diff dialog surfaces this: "This polygon (Aurora) has 3 future bookings. Detaching the polygon won't cancel them, but they won't appear on the map."

### 9.5 Two admins editing the same floor

- First admin's draft locks the slot (unique on `floor_space_id`).
- Second admin opening the designer sees a take-over chip: "Maria started a draft 12 min ago." Options: View read-only · Take over.
- Take-over reassigns `created_by` and bumps `updated_at`. If Maria reopens the designer afterward, she sees a banner explaining Lukas now owns the draft. No active notification — we don't push toasts to absent users; the banner is on next page load.

### 9.6 Floor plan for a floor in a building the user can't see

- Tenant scope (RLS) is sufficient.
- Within tenant, building visibility is controlled by `org_node_location_grants` (per `docs/visibility.md` and the org-structure note in CLAUDE.md). A user with no access to building B sees no B floors in the floor pills, and `GET /api/buildings/:id/floors` returns 404 for B.

### 9.7 Polygon outside floor image bounds

- Designer surfaces as `issue` left-rail status.
- Renderer (booking surface) clips polygon to image bounds visually; click still hits.
- Not a blocker for publish — admins might do this intentionally (extension or annexe room outside the captured floor area).

## 10. Testing

### 10.1 Database

- Cross-tenant isolation: insert draft as tenant A, attempt read/update as tenant B (must return 0 rows / fail RLS).
- Publish RPC atomicity: throw mid-loop, confirm no partial state (transaction rollback).
- Orphan detach: publish a draft with fewer polygons than the published state; confirm removed spaces have `floor_plan_polygon = null`.
- Render hint default: a new polygon without `render_hint` lands as `'default'`.

### 10.2 Backend (Vitest + Supertest)

- `GET /api/floors/:id/plan` returns published state.
- `PATCH /api/floors/:id/plan/draft` upserts draft.
- `POST /api/floors/:id/plan/draft/publish` calls the RPC and returns the new published state.
- Visibility filtering: a user without `floor_plans.author` cannot PATCH the draft (403); a user without `floor_plans.publish` cannot publish (403).
- The new module is covered by the existing cross-tenant FK leak harness (`apps/api/src/modules/cross-tenant-fk-leak-*.spec.ts`).
- **Smoke gate addition:** `pnpm smoke:floor-plans` (new script) runs the publish flow against a real DB. Sibling to `pnpm smoke:work-orders`. Mandatory before claiming designer work shipped.

### 10.3 Frontend (Vitest + Testing Library)

- Renderer:
  - Renders polygons from a fixture.
  - Adaptive: small polygon → seat circle, large → labeled rect.
  - Click on polygon fires `onSpaceClick`.
  - Keyboard: Tab focuses polygons in z-order; Enter activates.
  - Pan/zoom integration tests.
- Designer:
  - Stamp seat creates a small polygon with `render_hint='seat'`.
  - Draw polygon: click corners + close.
  - Undo/redo through snapshots.
  - Autosave debounce.
  - Take-over chip when draft exists from another user.
- Booking surface:
  - Time scrubber drag updates the rendered polygon colors.
  - Floor switcher persists the selected floor on remount.
  - Bottom sheet: time pills, change button, primary CTA.

### 10.4 E2E happy path

A scripted browser test:
1. Admin uploads an image → traces 3 rooms + 12 desk stamps → publishes.
2. Employee opens portal, sees floor plan, scrubs time slider, clicks an available room, books via bottom sheet.
3. Another viewer sees the room recolor (red) within 2s via realtime.

## 11. Performance

### 11.1 Targets

- First paint of map ≤ 600ms after navigation on broadband desktop.
- Pan/zoom maintains ≥ 50fps with 200 polygons on screen.
- Realtime recolor p95 ≤ 2s after the other user's commit.

### 11.2 Strategies

- Server-side `availability` aggregation (one query, per-space state computed in SQL via `tickets`/`reservations` joins + `tstzrange` overlap predicates).
- Client-side polygon visibility culling (only render polygons within current viewport, with 200px margin).
- Image lazy-loading with `decoding="async"` and a low-quality placeholder while the full image streams.
- React Query staleTime tuning: `availability` = 30s stale + realtime invalidation; `plan` = 5min stale (rarely changes).

## 12. GDPR + audit

- `audit_events` records:
  - `floor_plan.published` (with diff)
  - `floor_plan.draft.created`
  - `floor_plan.draft.discarded`
  - `floor_plan.draft.taken_over`
- Floor plan images are stored in Supabase Storage under `floor-plans/<tenant_id>/<floor_space_id>/<sha>.jpg`. Tenant prefix is RLS-enforced.
- No PII is embedded in polygons (just shape + space_id). No additional retention rules needed beyond the existing baseline (per `project_gdpr_baseline_sprint1`).
- Bookings on the map are subject to existing booking retention.

## 13. Migration order

| # | File | Purpose |
|---|---|---|
| 00367 | `spaces_floor_plan_render_hint.sql` | Add `floor_plan_render_hint` column to `spaces`. |
| 00368 | `floor_plan_drafts.sql` | New table for in-progress edits. |
| 00369 | `publish_floor_plan_draft_rpc.sql` | The atomic publish RPC. |
| 00370 | `floor_plans_labels.sql` | Add `labels` jsonb to `floor_plans` AND `floor_plan_drafts`. (Spec §3.3's table DDL shows the post-00370 state; the initial 00368 creation omits `labels` and 00370 alters both.) |
| 00371 | `floor_plans_permissions_catalog.sql` | Insert `floor_plans.author` / `.publish` / `.delete` rows into the permission catalog. TS SoT in `packages/shared/src/permission-catalog.ts` updated in same PR. |

All migrations push to remote per the standing authorization in `feedback_db_push_authorized` workstreams; this workstream gets its own standing-auth memory entry on first push.

## 14. Phase plan (preview — formal plan to be written by writing-plans skill)

- **Phase A — Schema + draft API.** Migrations 00367–00371. Backend module skeleton. `GET`/`PATCH`/`DELETE` for drafts. Empty publish endpoint that no-ops. Smoke: `pnpm smoke:floor-plans` proves draft CRUD across two tenants.
- **Phase B — Designer canvas.** `<FloorPlanCanvas>` in edit mode, draw/select/stamp tools, autosave, undo/redo. No publish yet. Admin can edit drafts but they don't appear in the booking surface.
- **Phase C — Publish flow.** `publish_floor_plan_draft` RPC. Publish dialog with diff. Audit events. Smoke harness covers the publish path. Booking surface starts seeing published changes.
- **Phase D — Booking renderer.** `<FloorPlanCanvas>` in view mode. Portal route `/portal/book/floor`. Bottom sheet. Time scrubber with crowd heatmap. Realtime via existing `RealtimeStatusStore`.
- **Phase E — Scheduler integration.** Toggle in `/desk/scheduler`. Same renderer.
- **Phase F — Polish + accessibility.** Keyboard nav across polygons, ARIA labels, reduced-motion, mobile QA at 320–428px. Lighthouse pass.

Total: 6 phases. Phases A–C are designer-only; Phases D–F are user-facing. Each phase ends with a smoke gate and (where applicable) a `/full-review` self-review per `feedback_review_loop_protocol`.

## 15. Open questions for product

These are explicit non-decisions I deferred:

1. **Crowd-heatmap baseline.** v1 = % rooms occupied per hour. Future: switch to "people in building" once attendance/check-in data is reliable. Spec assumes v1 only.
2. **Default time on map open.** Locked: "Now" with 60-min duration. Could also be "next free 30-min slot on this floor". Spec assumes "Now".
3. **Building selector behavior when tenant has 1 building.** Locked: hide the pill entirely. Auto-detect via `count(buildings)`.
4. **Should the time scrubber show beyond today?** v1: today only. Date selector (date pill above scrubber, allows navigating ±7 days) added in Phase D if time permits.
5. **Image upload size cap.** Suggest 10 MB per image. Long edge auto-downscaled to 4096px (preserves trace fidelity, caps memory).

These don't block the spec but are flagged for product review.

## 16. References

- Roadmap: `docs/booking-platform-roadmap.md` §A5
- Existing schema: `supabase/migrations/00120_spaces_room_booking_columns.sql`, `supabase/migrations/00127_floor_plans.sql`
- Error handling spec: `docs/superpowers/specs/2026-05-02-error-handling-system-design.md`
- React Query guidelines: `docs/react-query-guidelines.md`
- Visibility model: `docs/visibility.md`
- Permission catalog enforcement: `project_permission_catalog_enforcement_shipped` (auto-memory)
- Multi-step writes go through PL/pgSQL: `CLAUDE.md` — Architecture section
- Realtime status pattern: `docs/superpowers/specs/2026-05-02-error-handling-system-design.md` §"Realtime status UI"
