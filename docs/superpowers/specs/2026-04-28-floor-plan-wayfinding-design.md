# Floor-plan + Wayfinding Engine — Design Spec

**Date:** 2026-04-28
**Status:** Design — pending implementation
**Owner:** TBD
**Estimated effort:** ~6-8 weeks across 4 phases (rendering engine + rooms + desks + visitor lobby).
**Roadmap location:** `docs/booking-platform-roadmap.md` §A5 (room floor plan), §B3 (desk floor plan), §A12 (wayfinding); `docs/cross-spec-dependency-map.md` §13.3 (coverage gap closed).

**Why this spec exists:** Robin / Eptura / Condeco all sell on the floor-plan view first; it's the surface a buyer sees in the demo. Our roadmap labels it Tier 1 in three places (rooms / desks / wayfinding) but no design spec existed — codex flagged this as a real coverage gap on 2026-04-28. Without it, every spec that touches a spatial surface (room booking, desk booking, visitor lobby panel, floor heatmaps) ships its own ad-hoc rendering and the platform never gets a coherent "click a room on the map → book it" or "find your desk → highlighted on the plan" flow.

This spec ships **one** rendering engine that all spatial surfaces consume: rooms detail page, desks scheduler, visitor lobby panel, room booking finder. It picks the rendering tech, defines the tile-coordinate model, integrates with the existing `spaces` tree, and specifies the UX patterns that downstream specs (visitor management Phase 4 lobby panel, desk scheduler Phase 2, etc.) consume.

**Context:**
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §A5, §A12, §B3.
- [`docs/cross-spec-dependency-map.md`](../../cross-spec-dependency-map.md) §13.3.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) §3 "Room booking" / "Desk booking" / "Wayfinding".
- Memory: `project_no_wave1_yet.md` — building best-in-class first; floor plan is a demo surface buyers expect.
- Memory: `project_market_benelux.md` — corporate HQ-led; multi-floor headquarter buildings are the typical target.
- Sibling specs:
  - [Visitor management](2026-04-27-visitor-management-design.md) Phase 4 — lobby panel reuses this engine for "today's visitors on the floor plan."
  - [Vendor execution UX](2026-04-27-vendor-execution-ux-design.md) — KDS / cleaning / AV surfaces can highlight target rooms on a plan.
  - Existing `apps/api/src/modules/space/` + `apps/api/src/modules/reservations/` — spaces tree (`spaces.parent_id`) + reservations are the source of truth this engine renders.

---

## 1. Goals + non-goals

### Goals

1. **One floor-plan rendering engine** consumed by every spatial surface. Today: zero coherent map UX. Target: rooms / desks / visitor / wayfinding all use the same `<FloorPlan>` component.
2. **SVG-first rendering** — picks an engine that's keyboard-accessible, screen-reader-navigable, embeddable in PDFs (via `@react-pdf/renderer`), and editable per-tenant without custom CAD tooling.
3. **Tile-coordinate model** — every space (room / desk / amenity) has an `(x, y, w, h)` rectangle on its floor's plan. Authoring is "drag to position" not "edit a polygon list."
4. **Tenant-authored** — admin uploads a base image (PDF / PNG / SVG of the floor) → traces room outlines once → all booking surfaces light up. No CAD round-trip.
5. **Live status overlay** — rooms colored by current booking state (free / reserved / in-use / cleaning / blocked); desks colored by reservation + person presence (own / colleague / unassigned); visitors as dots on the plan in lobby panel mode.
6. **Click-through booking** — "I see a free room on the 4th floor → click it → book this room now" without leaving the map.
7. **Wayfinding** — "find Marleen's desk for me" or "where is Boardroom 4?" — search → map zooms + highlights → optional turn-by-turn within the building.
8. **Mobile-first** — pinch-zoom + pan on touch; same primitives as desktop.
9. **Multi-floor / multi-building navigation** — tabs between floors; top-level breadcrumb (Building → Floor → Zone → Room).
10. **Reusable in PDF** — daglijst (when the spec calls for it later), reports, building maps for visitors all use the same SVG output.

### Non-goals

- **CAD / DWG / Revit / IFC ingestion in v1.** Phase 1-4 (this spec) ships rect-tracing + manual polygon authoring. CAD ingestion is **Tier 2 — separate Phase 5+ effort** per §3.3. (Earlier draft labeled it Tier 3; that contradicts `docs/spec.md`'s enterprise import promise. Corrected.)
- **Real-time occupancy via sensors** (people counting, heat-mapping). Tier 3 — depends on hardware partners we don't have.
- **3D visualisation** (Matterport-style walkthroughs). Tier 3 — too much production cost for the demo value at our market segment.
- **True turn-by-turn (corridor graph + step-by-step instructions).** Tier 2 — v1 ships directional-pointer + distance per §7.
- **AR overlay** (point your phone at a hallway and see room labels). Tier 3.
- **Per-employee desk-history visualisation** ("most-booked desks last 30 days"). Tier 2 analytics; reporting surface, not the floor-plan engine.

---

## 2. Architecture overview

### Module layout

Frontend:
- `apps/web/src/components/floor-plan/` — the engine.
  - `floor-plan.tsx` — main `<FloorPlan>` component.
  - `floor-plan-canvas.tsx` — SVG-based render layer with pan / zoom / hit-testing.
  - `floor-plan-region.tsx` — single space region (room or desk).
  - `floor-plan-overlay.tsx` — overlay layer for status colors / labels / icons.
  - `floor-plan-search.tsx` — wayfinding search box.
  - `floor-plan-editor.tsx` — admin region-tracing UI.
  - `use-floor-plan-data.tsx` — React Query hook bundling the regions + status.
- `apps/web/src/api/floor-plans/` — query keys + queryOptions per the React Query guidelines.

Backend:
- `apps/api/src/modules/floor-plan/` — bundles + serves the regions + cached status snapshots.
  - `floor-plan.service.ts` — `getRegionsForFloor`, `upsertRegion`, `getStatusSnapshot`.
  - `floor-plan.controller.ts` — REST API + Realtime channel.
  - `floor-plan-image.service.ts` — base-image upload + sanitization (SVG sanitizer reused from `apps/api/src/modules/tenant/svg-sanitizer.ts`).

### Data flow

```
Admin uploads floor base (PDF/PNG/SVG)  ───▶  /admin/spaces/:floorId/floor-plan
                                                       │
                                                       ▼
                                              base_image stored in
                                              floor-plans Storage bucket
                                                       │
Admin traces regions on the base    ───▶              ▼
(drag rectangles on the editor)            inserts/updates
                                          floor_plan_regions

End user opens /portal/book-room    ───▶  GET /api/floor-plans/:floorId
                                                       │
                                                       ▼
                                          { base_image_url, regions[], status_snapshot{} }
                                                       │
                                                       ▼
                                          <FloorPlan> renders SVG

Realtime: a reservation starts/ends
       → floor-plan service publishes
       → status snapshot live-updates
```

### Why SVG, not Canvas / WebGL?

Considered + chosen reasoning:

- **SVG-native**: every region is a real DOM element with `aria-label`, `role="button"`, keyboard tab order. Screen readers + keyboard users get a usable floor plan without us writing custom a11y. Canvas + WebGL require shadow-DOM accessibility plumbing that becomes per-engine drift.
- **Embeddable in `@react-pdf/renderer`**: daglijst spec already uses `@react-pdf/renderer` (per cross-spec §3.6). SVG renders natively in their PDF; Canvas + WebGL don't.
- **Vector**: pinch-zoom is crisp at any magnification; print-quality is automatic.
- **Editing surface**: tracing a rectangle on an SVG is easy with mouse + touch math. Canvas requires reimplementing hit-testing per shape.
- **Performance**: at our scale (500 desks per floor max), SVG is well under the perf cliff (~5k DOM nodes is fine; we'll be at ~600 max). When we hit 10k+ desks per floor, pivot to Canvas with a virtualisation layer — but that's a real-customer-with-large-campus problem, not a demo-stage problem.
- **No new runtime dependency**: native browser SVG + React. No `react-konva` / `pixi.js` / etc. Any new dep adds bundle size + maintenance cost.

Trade-off acknowledged: at >5000 regions per floor SVG starts to get slow on low-end mobile. Mitigation: viewport culling (only render regions within the visible bbox) + level-of-detail (render rectangles only at low zoom; skip labels until user zooms in).

---

## 3. Data model

### 3.1 Existing schema we extend (don't duplicate)

The repo already ships:

- **`floor_plans` table** (`supabase/migrations/00127_floor_plans.sql`): `id, tenant_id, space_id (the floor), image_url, width_px, height_px, active`. One per floor, replaced on re-upload.
- **`spaces.floor_plan_polygon jsonb`** (`supabase/migrations/00120_spaces_room_booking_columns.sql`): per-room polygon coords on its floor's plan.

This spec **extends** that schema rather than introducing a parallel one. A previous draft proposed `floor_plan_regions` + `floor_plan_image_assets` tables; that draft was wrong — codex flagged it on 2026-04-28. The existing tables already cover the use cases; the gaps are in metadata + per-region presentation, not in the storage shape.

### 3.2 Schema additions

```sql
-- Extend the existing floor_plans table — no new image-asset table.
alter table floor_plans
  add column orientation        text default 'north_up'
    check (orientation in ('north_up','north_right','north_down','north_left')),
  add column mime_type          text,                          -- 'image/svg+xml' | 'image/png' | 'application/pdf' (PDF→PNG server-side)
  add column sanitization_log   jsonb,                         -- list of stripped <script>, on*, etc. (SVG path)
  add column uploaded_by_user_id uuid references users(id);

-- Extend spaces with rect-coordinate fast-path + presentation hints. The
-- existing floor_plan_polygon stays; rect coords are an additional shape
-- option for the simple case (any 4-sided room) and the scaffold for v2
-- polygon authoring.
alter table spaces
  add column floor_plan_rect_x        int,
  add column floor_plan_rect_y        int,
  add column floor_plan_rect_w        int,
  add column floor_plan_rect_h        int,
  add column floor_plan_rect_rotation int default 0,
  add column floor_plan_label_position text default 'center'
    check (floor_plan_label_position in ('center','top_left','top_right','bottom_left','bottom_right')),
  add column floor_plan_icon          text,                    -- lucide icon name
  add column floor_plan_color_hint    text;                    -- override default per-status color (rare)

-- v1 picks ONE shape per space — either rect XOR polygon. Constraint:
alter table spaces
  add constraint spaces_floor_plan_shape_xor check (
    floor_plan_polygon is null
    or (floor_plan_rect_x is null and floor_plan_rect_y is null
        and floor_plan_rect_w is null and floor_plan_rect_h is null)
  );
```

This means:
- A space can have NO floor-plan presence (default — `parent` floors, generic zones, etc.).
- A space can have a `floor_plan_rect_*` (simple case — most rooms).
- A space can have a `floor_plan_polygon` jsonb (curved/L-shaped rooms; CAD-imported shapes).
- Never both — the rect is just a syntactic shortcut.

### 3.3 CAD / BIM / IWMS ingestion (Tier 2, not Tier 3)

The main `docs/spec.md` promises CAD/BIM/IWMS import. The earlier draft of this spec downgraded that to Tier 3, contradicting a stated enterprise commitment. Corrected:

- **Tier 1 (this spec, Phase 1-4):** rect-tracing + manual polygon authoring covers 95% of customers up to ~50 buildings. Robin/Eptura/Condeco demos lead with this; tracing UX is the wedge for SMB.
- **Tier 2 (separate Phase 5+ effort, post Wave 4):** CAD/DWG/Revit/IFC ingestion. Pipeline:
  1. Admin uploads .dwg / .ifc → backend converts to SVG via a sandboxed worker (Vercel Sandbox-style isolated job per memory `vercel:vercel-sandbox.md`).
  2. Polygons extracted from layer metadata → matched to existing `spaces.code` values via fuzzy match → admin confirms.
  3. Result: `floor_plans.image_url` = the converted SVG, `spaces.floor_plan_polygon` populated automatically.
  4. Re-upload + re-match supported; per-space `external_source_id` preserves the link to the CAD layer for round-tripping.

Tier 2 not Tier 3 because: (a) main spec promises it, (b) it's a meaningful enterprise upsell wedge, (c) the schema we ship in Tier 1 is forward-compatible (CAD ingestion populates the same polygon column).

### 3.4 Audit events

- `floor_plan.image_uploaded` — admin uploaded a new base image for a floor.
- `floor_plan.region_created|updated|deleted` — admin authored regions.
- `floor_plan.cad_imported` (Tier 2) — successful CAD ingestion run.

### Status snapshot — not a table

The "what's the current state of every region" is computed from existing tables (reservations, asset_reservations, visitors, etc.) and pushed to the client as a single payload + Realtime delta. No new table needed.

### Audit events (extending existing taxonomy)

- `floor_plan.image_uploaded` — admin uploaded a new base image for a floor.
- `floor_plan.region_created|updated|deleted` — admin authored regions.
- (Status changes don't audit — they cascade from reservation events.)

---

## 4. Backend services + endpoints

### `FloorPlanService`

```typescript
class FloorPlanService {
  /** Bundle: base image URL + regions + current status snapshot. */
  async getFloorView(tenantId: string, floorId: string, opts?: { include?: ('rooms' | 'desks' | 'amenities' | 'visitors')[] }): Promise<FloorView>;

  /** Admin upload + sanitize. */
  async uploadBaseImage(input: UploadBaseImageInput): Promise<FloorPlanImageAsset>;

  /** Admin region CRUD. */
  async upsertRegion(input: UpsertRegionInput): Promise<FloorPlanRegion>;
  async deleteRegion(tenantId: string, regionId: string): Promise<void>;

  /** Wayfinding search. */
  async searchSpace(tenantId: string, query: string): Promise<WayfindingHit[]>;
}
```

### Endpoints

```
GET  /api/floor-plans/:floorId                          → FloorView (regions + status snapshot)
POST /api/admin/floor-plans/:floorId/image              → upload base image
POST /api/admin/floor-plans/:floorId/regions            → upsert region
DELETE /api/admin/floor-plans/:floorId/regions/:id      → delete region
GET  /api/floor-plans/search?q=<query>                  → WayfindingHit[]
```

Realtime channel: `tenant:{tenantId}:floor:{floorId}:status` — broadcasts region status deltas (room becomes occupied, desk gets assigned, etc.). Same Realtime pattern as Phase B per cross-spec §3.9.

### Status snapshot composition

```sql
-- Per-region status (rooms): composed from current reservations
SELECT s.id as region_id,
       case when r.id is null then 'free'
            when r.status = 'in_progress' then 'in_use'
            when r.status = 'pending_check_in' then 'arriving_soon'
            else 'reserved'
       end as status,
       r.starts_at, r.ends_at, r.attendee_count
  FROM spaces s
  LEFT JOIN reservations r ON r.space_id = s.id
   AND r.tenant_id = s.tenant_id
   AND now() between r.starts_at and r.ends_at
   AND r.status in ('pending_check_in','in_progress','reserved')
 WHERE s.tenant_id = $1
   AND s.parent_id = $2  -- floor
   AND s.type = 'room'
```

For desks: similar but joins `desk_reservations`. For visitors (lobby panel mode): joins `visitors` where `visit_date = today`. Each composition is a `view` materialised in Postgres for low-latency reads.

---

## 5. Frontend rendering

### `<FloorPlan>` component

```tsx
<FloorPlan
  floorId={floorId}
  mode="rooms" | "desks" | "visitors" | "wayfinding"
  onRegionClick={(region) => /* book this room | assign this desk */}
  highlightedSpaceId={maybeSpaceId}             /* wayfinding "highlight result" */
  showCompass
  showLegend
  /* presentation overrides per call site */
  className="h-[600px]"
/>
```

The `mode` prop drives the status overlay legend + the click handler. Rooms mode → click → "Book this room"; desks mode → click → "Reserve this desk"; visitors mode → read-only with visitor dots; wayfinding mode → search + highlight + zoom-to.

### Pan + zoom

Native SVG `viewBox` manipulation. On wheel / pinch:
- Wheel: zoom by factor 1.1, recentre on cursor.
- Pinch: standard 2-finger gesture math.
- Drag: pan by delta.
- Double-tap / double-click: zoom to the region under cursor.
- "Fit floor" button: viewBox = full natural bbox.

### Region rendering

Each region is an SVG `<rect>` or `<polygon>` with:
- `fill` = status color (per `mode`).
- `stroke` = darker shade.
- Click + keyboard handlers via `role="button"` + `tabIndex={0}` + `onKeyDown` (Enter / Space).
- Label text: lazy-rendered above zoom threshold (≥0.5×) to avoid label spaghetti at low zoom.
- Status icon (room: people-count badge; desk: avatar of assignee; visitor: dot with check-in time tooltip).

### Multi-floor navigation

Top-level tabs (one per floor) above the canvas. Floors loaded lazily — fetch when tab activates. Cross-floor wayfinding ("show me Boardroom 4") auto-selects the correct floor tab + zooms.

### Mobile

Pan / zoom are touch-native via the browser. The pan + zoom library is intentionally not a dependency — we reuse the standard touch / pointer events. At very small screens (<480px), the legend collapses behind a bottom-sheet; the canvas claims the viewport.

---

## 6. Admin region-tracing editor

### `/admin/spaces/:floorId/floor-plan` page

Per CLAUDE.md width enum: `SettingsPageShell width="full"` (this is a true canvas tool, not a settings page — qualifies for the `full` opt-out).

Layout:
- Left sidebar: list of unmapped spaces under this floor (rooms / desks / amenities). Each row drag-handle.
- Center: `<FloorPlanEditor>` — base image as background; regions overlaid; admin can:
  - Drag a space from the sidebar onto the canvas → drops a default rectangle near the cursor → adjustable.
  - Click an existing region → resize handles + delete + properties.
  - Pan + zoom same as the read-only canvas.
- Right inspector: properties of the selected region (label position, icon, color hint, optional rotation).
- Top toolbar: upload-base-image, fit-floor, undo, redo, save.

### Authoring flow for a new floor

1. Admin uploads PNG / PDF / SVG of the floor → backend sanitizes (SVG strip script tags via existing sanitizer) → stores in `floor-plans` storage bucket → records `natural_width / natural_height` from image dimensions.
2. Admin drags each space from the sidebar onto the canvas → trace its rectangle. Initial drop = 100×100 box near cursor; admin resizes.
3. Save → all unsaved regions persist via batch upsert.
4. End-user surfaces light up with the new regions on next load (cache invalidates on region upsert via React Query).

### Edge cases

- **Floor base updated** (admin replaces the image with a redrawn one) — regions stay with their pixel coordinates. If the new image has different `natural_width / height`, admin gets a "regions may need re-positioning" warning + a side-by-side diff view.
- **Space deleted upstream** — orphaned regions → admin sees the region with an "unlinked" badge + deletes it.
- **Two admins editing concurrently** — last-write-wins per region (no real-time co-editing in v1; flagged as Tier 2).

---

## 7. Wayfinding

### Search box

`<FloorPlanSearch>` mounts at the top of the canvas in wayfinding mode. Input: free text. Results:

- Person name → "Find Marleen V" → if person has a default desk reservation today, highlight + zoom; otherwise show "no booking today" empty state.
- Room name / number → "Boardroom 4" → highlight + zoom; show today's reservations as a tooltip.
- Amenity → "Nearest coffee" → finds amenity-type spaces of category 'coffee' on the same building, sorts by Euclidean distance from the user's last selection / current view centre.

Behind the scenes: existing global search infra (per memory `project_global_search_future_perf.md`) powers the queries; floor-plan-specific results add a `floor_id` discriminator so the result-click handler can switch tabs.

### "Where am I?"

When the user opens the floor plan from the portal home, default selection = their `default_location_id` floor (per memory `project_person_default_location.md`). When they open it from a meeting reminder or visitor email, default = the relevant booking's `space_id`'s floor.

### v1 wayfinding — directional pointer (Tier 1)

`competitive-benchmark.md` §3 lists mobile turn-by-turn as parity. A pure "highlight + zoom" without any direction reads visibly behind in demos. Codex flagged this on 2026-04-28; corrected.

v1 ships:

- **Highlight + zoom-to** the destination on its floor (Tier 1, ships Phase 3).
- **Directional pointer** at the user's current device-pose-relative reference: an arrow on the floor view from the user's current "anchor" (last-tapped room, or "I'm at reception" hard-coded for visitor mode) to the destination, plus straight-line distance ("Boardroom 4 — 35m, that way →"). No corridor graph required; uses the rect/polygon centroid math we already have. (Tier 1, ships Phase 3.)
- **Cross-floor handoff:** when destination is on a different floor, pointer points to the nearest stairwell/elevator on the current floor (a `spaces.type = 'amenity'` of category 'circulation') with a "go up 2 floors" sub-instruction. (Tier 1, ships Phase 3.)

### v2 wayfinding — full turn-by-turn (Tier 2)

Corridor-graph turn-by-turn with step-by-step instructions ("turn left, walk 20m, turn right at the kitchen"). Requires:

- Corridor graph: a `floor_corridor_segments` table linking points on each floor.
- Authoring UX: admin draws corridors on top of the floor plan.
- Pathfinding: A* on the corridor graph.
- Multi-floor: links between stairwell/elevator segments.

Tier 2 because corridor authoring is per-tenant manual work and the demo value of full turn-by-turn vs the directional-pointer is incremental at smaller-tenant scale. Promote to Tier 1 if customer demand confirms (campus-style customers with >5 buildings + multi-corridor floors).

---

## 8. Reusable in PDF

The same SVG output renders into `@react-pdf/renderer` for:

- Daglijst PDF cover (Tier 2 enhancement to existing daglijst spec) — small floor map with delivery locations highlighted.
- Visitor host email — tiny embedded plan showing where their visitor will arrive.
- Building-map handout for visitors (printable from `/admin/visitors/:id`).
- Room booking confirmation email — embedded plan showing the room.

Rendering path: the same SVG markup renders in the browser; for PDF we use the native `@react-pdf/renderer` `<Svg>` primitive with the same regions array. No re-implementation.

---

## 9. Status overlay colors + accessibility

Per memory `feedback_quality_bar_comprehensive.md` — best-in-class. Colors must work for the 8% color-blind population AND be theme-aware (light / dark).

| Status | Light theme | Dark theme | Pattern fallback |
|---|---|---|---|
| Free | `--success-300` | `--success-700` | none |
| Reserved (future) | `--info-300` | `--info-700` | diagonal stripes |
| In use (now) | `--info-500` | `--info-500` | solid |
| Arriving soon (5min before) | `--warning-300` | `--warning-700` | dotted border |
| Cleaning | `--accent-300` | `--accent-700` | crosshatch |
| Blocked / out-of-service | `--neutral-400` | `--neutral-600` | × overlay |

Tenant brand color overrides per `tenants.branding` (existing).

A11y:
- Each region is a focusable button with `aria-label="Boardroom 4 — currently free until 14:30"`.
- Tab order follows reading order (top-to-bottom, left-to-right, per floor).
- Pattern fallback ensures color-blind readability without ARIA-color soup.
- Keyboard shortcuts: `j/k` next/previous region; `Enter` activate; `Esc` clear selection; `f` fit-floor.

---

## 10. Performance + scale

- **Region count per floor**: typical 20-60 rooms + 50-300 desks. SVG handles 5000 DOM nodes; we're well under.
- **Status snapshot fetch**: one query joining reservations + spaces; <100ms for typical tenants per CLAUDE.md observability targets.
- **Realtime delta**: per-region patch <1KB; broadcast to ~50 connected clients per tenant.
- **Initial load**: base image ~50-300KB depending on format; regions JSON ~5-50KB; total <500KB cold. Cached aggressively via React Query (staleTime 60s for status, infinity for regions until upsert).
- **Mobile**: pinch-zoom uses native browser pointer events. No JS pan-zoom library = minimal overhead.

---

## 11. Security

- Base image upload goes through `apps/api/src/modules/tenant/svg-sanitizer.ts` (existing) — strips `<script>`, `on*` attributes, `xlink:href` to non-allow-listed schemes.
- PDF uploads converted to PNG server-side (so we don't ship interactive PDF features).
- RLS on `floor_plan_regions` and `floor_plan_image_assets`: tenant-scoped + service-role-only for writes (admin endpoints use service-role); reads gated by `spaces.read` permission.
- No PII in the regions payload — region labels come from `spaces.name`, never from `persons.first_name`. Visitor dots in lobby panel mode use `visitor.id` only; the dot tooltip joins `persons.first_name` server-side per access-log decorator.

---

## 12. Phased delivery

### Phase 1 (2 wks): Engine + base data + read-only rooms view

- Migrations: spaces floor-plan columns, `floor_plan_regions`, `floor_plan_image_assets`.
- `FloorPlanService` core: `getFloorView` + `uploadBaseImage` + `upsertRegion`.
- `<FloorPlan>` component (rooms mode, read-only) + admin region editor v1 (rect only).
- React Query hooks + Realtime subscription scaffold.
- A11y baseline: keyboard nav + ARIA labels.

**Acceptance:** admin uploads a floor PNG, traces 5 rooms, end-user opens the booking finder and sees the floor with rooms colored by current state.

### Phase 2 (2 wks): Desks mode + multi-floor + click-to-book

- Desks mode (extends overlay logic; reuses regions for desks).
- Multi-floor tabs + cross-floor navigation.
- Click-to-book: room mode opens `<CreateBookingDialog>` pre-populated; desk mode opens desk-reservation flow.
- Mobile responsive: pinch-zoom + bottom-sheet legend.

**Acceptance:** end-user clicks a free room on the 4th floor → CreateBookingDialog opens with that room selected → books it → status overlay updates live.

### Phase 3 (1.5 wks): Wayfinding + search

- Search integration (extends existing global search).
- Highlight + zoom-to per query.
- Default selection from `default_location_id` / current booking context.
- Path-as-the-crow-flies arrow (Tier 2 turn-by-turn deferred).

**Acceptance:** end-user types "Marleen" in the wayfinding search → finds her assigned desk → map zooms + highlights → tap to navigate.

### Phase 4 (1.5 wks): Visitor lobby panel + PDF reuse + a11y polish

- Visitors mode: today's expected visitors as dots on the floor; live updates via Realtime as they check in.
- `@react-pdf/renderer` `<Svg>` integration → daglijst PDF cover + visitor host email embedded plan.
- A11y audit: screen reader + keyboard sweep; pattern fallbacks for status colors.
- i18n: NL + FR + EN region labels.

**Acceptance:** reception runs `/lobby/today` → sees a live floor with visitor dots animating as they check in; daglijst PDFs render with a delivery-locations cover map.

### Phase 5 (~3 days): Polish + tenant onboarding

- Onboarding wizard for first-floor upload (default flow walks new tenant through PDF upload + tracing 5 sample rooms).
- Empty-state UX for tenants with no floor plans yet.
- Documentation + admin help.

**Total: ~6-8 weeks.**

---

## 13. Acceptance criteria

1. Admin uploads a 2-floor building PDF, traces 30 rooms across both floors, saves; end-users see the floors live in the booking finder.
2. End-user on a phone opens the room finder, pinch-zooms into the 4th floor, taps a free room, books it; the room turns red on every connected device within 2 seconds.
3. Admin uploads a malicious SVG with `<script>` tags; backend strips them; the rendered floor is safe to view.
4. End-user types "Boardroom 4" in wayfinding search; map auto-switches to floor 3, zooms to the room, highlights it; today's reservations show in a tooltip.
5. Reception opens the lobby panel; sees today's 12 expected visitors as dots; one visitor checks in via the kiosk; their dot turns from gray to green within 2 seconds.
6. A floor base image gets re-uploaded with different dimensions; admin sees the "regions may need re-positioning" warning + can side-by-side compare the old and new.
7. Daglijst PDF renders for a vendor; the cover page contains a small floor map with the day's delivery locations highlighted.
8. Color-blind user navigates the floor with a screen reader; every region is announced ("Boardroom 4, currently in use until 14:30, press Enter to view options"); pattern fallbacks distinguish reserved vs in-use vs blocked without color.
9. Keyboard user navigates the floor entirely via `j` / `k` / `Enter`; no mouse needed.
10. Tenant with 600 desks per floor opens the desk-finder; SVG renders within 1s on a mid-range Android phone (Pixel 6a); pinch-zoom stays at 60fps.

---

## 14. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| SVG performance cliff at >5k regions per floor | Low (we're at ~600 max) | Medium | Viewport culling + LOD per spec §2; pivot to Canvas with virtualisation when a real customer hits the cliff |
| SVG XSS via uploaded base image | Medium | High | Sanitizer reused from existing tenant-branding flow; sanitization log in `floor_plan_image_assets` |
| Region pixel coords drift when base re-uploaded | Medium | Medium | Side-by-side diff + warning at upload; never silently shift coords |
| Concurrent admin editors clobber each other | Low | Medium | Last-write-wins v1; Tier 2 = Y.js / CRDT live co-editing |
| Wayfinding finds wrong floor for a person | Medium | Low | Default to person's `default_location_id`; explicit floor breadcrumb in the search result |
| Mobile pinch-zoom inconsistent across browsers | Medium | Medium | Test matrix: iOS Safari, iOS Chrome, Android Chrome; pointer events polyfill if needed |
| PDF SVG output renders differently than browser SVG | Medium | Low | Snapshot tests on a sample floor; limit fancy SVG features (filters, masks) in the rendering path |
| Tenant uploads a floor with PII in the image (employee names labelled per desk) | Low | Medium | Onboarding doc warns explicitly; SVG sanitizer doesn't strip text but admin guidance covers it |

---

## 15. Open questions

1. **Multi-building campus navigation — one combined map or per-building?** Proposed: per-building (one floor-plan engine per building); a separate "campus map" Tier 2 surface for buildings on a site.
2. **Free-form polygons in v1 or v2?** Proposed: v2. Rect covers 90%+ of rooms; the engine schema supports polygon for future without migration.
3. **Live co-editing in the admin region editor?** Proposed: Tier 2. v1 ships last-write-wins.
4. **Per-region custom shapes (e.g. a curved zone)?** Proposed: Tier 3. Polygon support in v2 covers the practical cases.
5. **Floor plan as default room finder vs as opt-in?** Proposed: side-by-side (list view default; map view toggle). Roll over to default-map after 50% of tenants opt-in.
6. **Photo-realistic render for the marketing site?** Out of scope — that's a separate marketing asset, not a product feature.
7. **Show real-time desk presence (who's actually at their desk)?** Proposed: Tier 2 + opt-in per tenant + per user. Privacy-sensitive; tie to GDPR baseline retention.

---

## 16. Out of scope

- 3D walkthrough / Matterport.
- Sensor-based real-time occupancy.
- AR overlay.

(Note: CAD/DWG/Revit ingestion is **Tier 2, not out of scope** — see §3.3. The earlier draft of this spec listed it here in error. Polygon authoring + true turn-by-turn are also Tier 2, not Tier 3 / out-of-scope.)

---

## 17. References

- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §A5, §A12, §B3.
- [`docs/cross-spec-dependency-map.md`](../../cross-spec-dependency-map.md) §13.3.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) §3 "Room booking", "Desk booking", "Wayfinding".
- Sibling specs:
  - [Visitor management](2026-04-27-visitor-management-design.md) Phase 4 (lobby panel reuses this engine).
  - [Vendor execution UX](2026-04-27-vendor-execution-ux-design.md) (KDS / cleaning route highlighting).
  - [Daglijst Phase A](2026-04-27-vendor-portal-phase-a-daglijst-design.md) (PDF cover map reuse).
- Memory:
  - `project_market_benelux.md` — corporate HQ market.
  - `project_person_default_location.md` — default floor selection.
  - `project_no_wave1_yet.md` — building best-in-class first.
  - `feedback_quality_bar_comprehensive.md` — comprehensive scope.
- External:
  - Robin floor-plan UX — benchmark for click-to-book.
  - Eptura wayfinding — benchmark for search + highlight.
  - Condeco desk grid — benchmark for live status overlay.
  - `@react-pdf/renderer` `<Svg>` primitive — PDF embedding reference.

---

**Maintenance rule:** when implementation diverges from this spec, update the spec first then code. When a new spatial surface is added (e.g. parking-lot view), register the new mode here in §5 + add the corresponding status composition in §4.
