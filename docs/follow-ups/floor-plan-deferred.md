# Floor-plan deferred work

Captured 2026-05-13. Branch `worktree-floorplanner`, PR #13.

## What shipped tonight (last commits before sleep)

- `6c1e495d` — apiFetch tolerates empty 200 bodies (Nest null return crashed PublishDialog)
- `9b1e0872` — 4 CRITICAL bugs from /full-review (ZoomPanLayer null deref, polygon NaN, seed validation, useFloorAvailability `/api/api/`)
- `f2cd9814` — storage RLS relax (image upload was 100% blocked by `current_tenant_id()` mismatch)
- `c477a8ca` — designer interaction overhaul (ZoomPanLayer reserves left-click for tools; auto-select-after-draw; drag-to-pan moved to middle/right-click)
- `6b34b0f4` — design-review Phase 0 fixes (inline create-space in Inspector; portal Cmd-K search)
- _(this commit)_ — autosave backoff, SVG upload, beforeunload guard, designer loading skeleton

## What's deferred — Tier 1 (do next)

1. **Clone floor** — Facilities Admin JTBD `users.md:125`. Floor-plans index needs a "Clone from…" row action that copies `floor_plans` + `spaces.floor_plan_polygon` to a target floor, auto-creating children by name where they don't exist. Biggest single time saver for migrations.
2. **Browser-test every flow** — I've been shipping without it. CLAUDE.md is explicit. Walk: designer load → draw rect → create space → publish → restore → portal load → search → tap polygon → book. Fix anything that breaks.
3. **"Continuously patches in the room list"** — user-reported, root cause unverified. Likely the inspector Select firing onValueChange on render OR the SpacesTree re-rendering. Add a console.log on every PATCH and reproduce in browser.

## Tier 2 (production polish)

4. **TimeScrubber math** — Y-coord formula in `time-scrubber.tsx:183` is incoherent (`SVG_H - 2 * BAR_H_MAX * occupancy`). The bars are out of register with the ticks. Use a proper viewBox (e.g. `0 0 1000 56`) with non-stretched preserveAspectRatio.
5. **BookingSheet 409 detection** — `pages/portal/book-floor/booking-sheet.tsx:176` sniffs `err.status === 409`. Route through `handleMutationError({ actionTitle: "Couldn't book {room}" })`.
6. **useIsMobile** — doesn't react to resize. Use `useSyncExternalStore` with `matchMedia`.
7. **Realtime subscribe filter** — `useFloorAvailabilityRealtime` invalidates on ANY booking change. Filter by `space_id IN (childSpaceIds)` (Realtime supports row-level filter on a single column; multi-value needs a server-side notify wrapper).
8. **Polygon points outside image bounds** — no client-side or DTO guard. User can draw outside the bg image.
9. **Take-over UI** for two admins on same draft. Optimistic lock currently catches it but UX is just a toast → reload.

## Tier 3 (long tail)

10. Parking-slot dedicated tool (today: stamp-seat with `render_hint='parking'`).
11. Label tool (positioned annotations; schema + storage exist; no UI).
12. Image-remap after replacement (today: warns "polygons may need to be remapped").
13. Konva fallback if SVG perf falls below 30fps at 500+ polygons.
14. Arrow-key vertex nudge in Select tool.
15. Multi-touch pinch zoom (mobile + trackpad).
16. Floor switcher mini-occupancy bars compute server-side (N+1 today, fine ≤5 floors).
17. Audit-trail surface for Tenant Admin (persona #4) — events exist; no UI.
18. Booking detail on polygon click for `state==='mine'` polygons (today: opens BookingSheet to make a NEW booking, not show the existing one).
19. Visitor flag on map (visitor-as-bundle-line wedge from `visitor-management-v1` spec).
20. Hot-desk zone (one polygon, N interchangeable seats — separate booking flow).

## Known gotchas

- **Two .env symlinks required in a worktree**: `.env` at the worktree root (API reads it) AND `apps/web/.env` (Vite reads VITE_*). Both gitignored. Mirror from main repo when bringing a worktree up.
- **API runs on port 3001 by default**. If the main repo's API is also up, the worktree silently fails to bind — set `API_PORT=3099` or stop the main API.
- **TenantService.resolveDefault** returns the tenant with the OLDEST `created_at` (fixed in this branch). Don't seed test tenants without a sentinel `created_at` if you want resolveDefault to pick a specific one.
- **node --watch dist/main.js is unreliable**. After a code edit, kill the API process by PID and restart; don't trust HMR.

## Personas served vs. underserved

- ✅ **Facilities Admin (#3)** — designer works end-to-end now (after tonight's fixes). Clone-floor still missing.
- ✅ **Requester (#1)** — portal map + Cmd-K search. Mobile bottom sheet works.
- ⚠️ **Service Desk Operator (#5)** — scheduler floor view exists but doesn't surface routing decisions.
- ⚠️ **Tenant Admin (#4)** — audit events emitted, no UI.
- ❌ **Receptionist (#9)** — not addressed (kiosk view deferred per spec §1.2).
- ❌ **External Vendor (#6)** — not in scope.
- ❌ **Visitor (#8)** — not in scope.
