# Bookings Overview Report — Design

**Date:** 2026-04-27
**Module:** room-booking · reporting
**Status:** approved (autonomous execution)

## Goal

Give workplace / facilities admins a single-screen view of how meeting rooms are being used — booking volume, no-shows, utilization, and services attach. Mirrors the structure of the existing service-desk overview report (`/desk/reports/overview`) but tailored to the booking domain.

## Scope (v1)

- **Entity:** `reservations` where `reservation_type = 'room'` and `status != 'draft'` (drafts are work-in-progress, not bookings).
- **Tenant-scoped** like all admin pages. No cross-tenant aggregation.
- **Out of scope for v1:** desks, parking, "other" reservation types. Report layout is built so a future type segmenter at the top is a one-line addition.
- **No exports** for v1 (CSV/PDF). The data is already in the views; export can be added later.
- **No drill-through to a single room's history page** for v1. The watchlist links to existing reservation/space detail pages where they exist; otherwise rows are read-only.

## Route + nav

- Route: `/admin/room-booking-reports` (single overview page).
- Nav: under the existing **Room Booking** admin nav group (added in commit `fcfffcb`), labelled **Reports**.
- Permission: `reports.read` (already in role templates).
- Page-shell: `SettingsPageShell width="ultra"` + `SettingsPageHeader` (title, description, filter row in `actions`). Ultra (1600px) fits the dense KPI row + heatmap + tables without horizontal pressure. The standard ReportShell on the desk side is full-bleed with no max-width — for an admin page, ultra reads cleaner and stays consistent with the rest of the admin surface.

## Definitions (locked)

| Term | Definition |
|---|---|
| **Booking** | `reservations` row, `reservation_type='room'`, `status` in `('pending_approval','confirmed','checked_in','released','cancelled','completed')` (excludes `draft`). |
| **Active booking** | `status` in `('confirmed','checked_in','completed')`. Counts toward "rooms booked". |
| **No-show** | `status='released'` AND `checked_in_at IS NULL` AND `check_in_required=true`. The auto-release path in `CheckInService` flips status to released when grace expires without check-in — that's the no-show signal. |
| **Cancelled** | `status='cancelled'`. |
| **Booked hours** | `extract(epoch from (effective_end_at - effective_start_at)) / 3600`, summed across active bookings, clipped to the report window. |
| **Bookable hours** | `count(reservable rooms in scope) × hours_per_day × days_in_window`, where `hours_per_day = 10` (08:00–18:00 local) and `days_in_window` counts only weekdays. v1 uses these constants; a per-tenant business-hours config is a v2 enhancement. |
| **Utilization** | `booked_hours / bookable_hours`, expressed as a percentage. |
| **Seat fill** | `attendee_count / capacity` averaged over active bookings where both columns are non-null. |
| **Lead time** | `start_at - created_at`, bucketed into `<2h` (same-day), `<24h`, `1–7d`, `≥7d`. |
| **Duration** | `effective_end_at - effective_start_at`, bucketed into `≤30m`, `≤1h`, `≤2h`, `>2h`. |
| **Services attach rate** | Among bookings linked to a `booking_bundle` whose bundle has at least one non-cancelled `orders` row. Numerator: bookings with services. Denominator: all bookings (room-only + bundled). |

## Page layout

In render order:

1. **Header** — `Bookings overview` · description · filter row (date preset · building · location).
2. **KPI row** — six `SectionCard`s. Wraps to 3×2 below 1280px.
3. **Volume chart** — area chart, 4 series (confirmed · cancelled · no-show · completed), x = day, y = count.
4. **Utilization heatmap** — Mon–Sun × 08:00–20:00, color intensity = % of rooms occupied in that hour. Built as a Tailwind CSS grid with inline `background-color` from a 5-step ramp; no chart library.
5. **Top rooms** — table, top 10 by booked hours. Columns: Room · Building · Bookings · Hours booked · Utilization · No-show % · Services %. Clicking the room navigates to its space detail page.
6. **No-show watchlist** — table, last 30 days. Columns: When · Room · Organizer · Status · Released at. Limit 20 rows; sort by `start_at desc`.
7. **Lead time + duration** — two small bar charts side-by-side.
8. **Services attach** — single `SettingsSection` with a percentage callout + tiny breakdown by `bundle_type` (meeting / event / hospitality / etc.).

### Filters

State lives in the URL via search params (`from`, `to`, `building`, `tz`). Defaults: `from = today − 30d`, `to = today`, `building = all`, `tz = browser IANA timezone` (`Intl.DateTimeFormat().resolvedOptions().timeZone`).

A small toolbar bar:
- **Date range:** segmented control for `7d` / `30d` / `90d`, plus a custom date-range picker (using shadcn `Calendar` in a popover).
- **Building:** select with one option per `space.type='building'` in the tenant. "All buildings" is the default.

The timezone is hidden from the user but determines how `start_at` is bucketed into days and hours — without it the heatmap is wrong by up to ±1 day for users outside UTC. Re-running with a different `tz` is rare; not exposed as a control.

Filter changes invalidate every report query (single key family).

### Volume chart bucketing (explicit)

- x-axis = `(start_at AT TIME ZONE p_tz)::date`. The chart shows when bookings were *scheduled to happen*, not when they were created.
- Each booking is counted in exactly one of four series, by its current `status`:
  - `cancelled` — `status='cancelled'`
  - `no_show` — `status='released' AND checked_in_at IS NULL AND check_in_required=true` (plus the defensive fallback for stuck `confirmed` rows past `end_at`).
  - `completed` — `status='completed'`.
  - `confirmed` — everything else with `status` in `('pending_approval','confirmed','checked_in')`. (Future: split pending out if it becomes meaningful.)

A booking moves between series as its lifecycle progresses; the chart reflects the *current* state of bookings whose start fell on that day.

## Backend

### One RPC, one endpoint

A single Postgres RPC `room_booking_report_overview(p_from date, p_to date, p_building_id uuid)` returns a JSONB document with everything the page needs. One round-trip is dramatically faster than 5–6 endpoints when each is a 5–50ms aggregation; it also makes invalidation trivial. Same pattern as `scheduler_data` (00153).

The RPC is `SECURITY INVOKER` so RLS still applies: a caller without `reports.read` (or without admin role) gets nothing. Tenant scoping comes from RLS on `reservations` and `spaces` (already in place).

#### Returned shape

```jsonc
{
  "window": { "from": "2026-03-28", "to": "2026-04-27", "days": 30 },
  "kpis": {
    "total_bookings": 1287,
    "active_bookings": 1142,
    "no_show_count": 87,
    "no_show_rate": 0.076,           // 0..1
    "cancellation_count": 145,
    "cancellation_rate": 0.113,
    "utilization": 0.62,             // 0..1
    "avg_seat_fill": 0.48,           // null if no rows have attendee_count + capacity
    "services_attach_rate": 0.34,
    "rooms_in_scope": 42
  },
  "volume_by_day": [
    { "date": "2026-03-28", "confirmed": 31, "cancelled": 4, "no_show": 2, "completed": 24 },
    ...
  ],
  "utilization_heatmap": [
    { "dow": 1, "hour": 8, "occupied_rooms": 5, "rooms_in_scope": 42, "utilization": 0.119 },
    ...   // 7 dows × 13 hours = 91 cells (08..20 inclusive); empty cells included with 0
  ],
  "top_rooms": [
    {
      "space_id": "uuid",
      "name": "Helios",
      "building_name": "Cairo HQ",
      "bookings": 86,
      "booked_hours": 142.5,
      "utilization": 0.71,
      "no_show_rate": 0.04,
      "services_rate": 0.42
    }, ...
  ],
  "no_show_watchlist": [
    {
      "reservation_id": "uuid",
      "room_name": "Helios",
      "building_name": "Cairo HQ",
      "organizer_name": "M. Fawzy",
      "start_at": "...", "released_at": "...",
      "attendee_count": 6
    }, ...
  ],
  "lead_time_buckets": { "same_day": 423, "lt_24h": 312, "lt_7d": 401, "ge_7d": 151 },
  "duration_buckets":  { "le_30m": 121, "le_1h": 642, "le_2h": 411, "gt_2h": 113 },
  "services_breakdown": { "meeting": 281, "event": 92, "hospitality": 41, "other": 18 }
}
```

#### SQL approach

A series of CTEs over `reservations` filtered to `reservation_type='room'`, joined to `spaces` for capacity/building. Each section is a small CTE; final select wraps everything into a single `jsonb_build_object`. Indexes already cover the hot paths:

- `reservations(tenant_id, status)` — covered by 00129
- `reservations(tenant_id, space_id, time_range)` — covered by 00129's GiST
- `reservations(tenant_id, start_at)` — needed for window slicing; we add it in this migration if missing.

Performance budget: under 200 ms p95 for a 30-day window on a tenant with ~10k reservations. Verified with `explain (analyze, buffers)` against the remote DB after deploy.

#### Endpoint

`GET /reports/bookings/overview?from=YYYY-MM-DD&to=YYYY-MM-DD&building_id=...` on `ReportingController`. Validates the date range (≤365d), defaults to last 30d. Returns the RPC payload as-is.

### Why a single RPC, not a Nest service that builds pieces in JS

- **Latency:** five sequential Supabase round-trips ≈ 250–500ms cold; one RPC is one round-trip.
- **Consistency:** all sections see the same window snapshot — no race where the volume chart and the KPIs disagree because they ran 80ms apart against a moving target.
- **Less code:** one SQL function vs. five service methods + a coordinator.
- **Mirrors recent precedent:** `scheduler_data` (00153) used the same pattern and was a clear win.

The only thing the Nest service does is parse + clamp inputs and pass them through.

## Frontend

### Module layout

```
apps/web/src/api/booking-reports/
  index.ts          # key factory + queryOptions + hooks + types
  types.ts          # response interfaces (mirrors the JSONB shape above)

apps/web/src/pages/admin/room-booking-reports/
  index.tsx                # page (orchestrates filter + sections)
  components/
    bookings-volume-chart.tsx
    utilization-heatmap.tsx
    top-rooms-table.tsx
    no-show-watchlist.tsx
    lead-time-chart.tsx
    duration-chart.tsx
    services-attach-section.tsx
    bookings-filter-bar.tsx
```

### React Query

```ts
export const bookingReportKeys = {
  all: ['booking-reports'] as const,
  overview: (params: OverviewParams) =>
    [...bookingReportKeys.all, 'overview', params] as const,
} as const;

export function bookingsOverviewOptions(params: OverviewParams) {
  return queryOptions({
    queryKey: bookingReportKeys.overview(params),
    queryFn: ({ signal }) =>
      apiFetch<BookingsOverviewResponse>('/reports/bookings/overview', { signal, query: params }),
    staleTime: 60_000,                  // T2 — same as desk reports
    placeholderData: (prev) => prev,    // smooth filter changes (no flash to skeleton)
  });
}
```

`placeholderData: keepPreviousData` is non-trivial here: it keeps the chart visible while the user changes filters, which is the difference between "feels like an app" and "feels like a website".

### KPI cards (six)

| Card | Title | Trend label | Footer primary | Footer secondary |
|---|---|---|---|---|
| Total bookings | `formatCount(total_bookings)` | `formatCount(active_bookings)` active | "Bookings in window" | "Excludes drafts" |
| Utilization | `pct(utilization)` | `formatCount(rooms_in_scope)` rooms | "Booked hours / bookable" | "Bookable: 08:00–18:00, weekdays" |
| No-shows | `formatCount(no_show_count)` | `pct(no_show_rate)` rate | "Confirmed but not checked in" | "Released after grace expired" |
| Cancellations | `formatCount(cancellation_count)` | `pct(cancellation_rate)` rate | "Cancelled before start" | "All cancellation reasons" |
| Avg seat fill | `pct(avg_seat_fill)` or `—` | "of room capacity" | "How full each booking actually was" | "Excludes rooms without capacity" |
| Services attach | `pct(services_attach_rate)` | `formatCount(rooms_with_services)` w/ bundles | "Bookings with services" | "Catering, AV, etc." |

`pct(x)` formats `0.62 → "62%"`. Uses `Math.round(x * 100)`.

### Charts

- **Bookings volume:** `recharts` `AreaChart`, four series, stacked offsetting (`stackOffset="silhouette"` is too cute — use plain stacked). Tooltip shows the four counts. Empty days are rendered with 0s (server fills gaps).
- **Utilization heatmap:** custom Tailwind component. 7 row labels (Mon–Sun) × 13 column labels (08–20). Each cell is a `div` with `background-color` from a 5-step ramp keyed off `utilization`:
  - 0% → `bg-muted` (no booking)
  - 1–25% → `oklch(0.85 0.07 250 / 1)`
  - 26–50% → `oklch(0.75 0.13 250 / 1)`
  - 51–75% → `oklch(0.65 0.18 250 / 1)`
  - 76–100% → `oklch(0.55 0.22 250 / 1)`
  Cell tooltip shows raw count + percentage. Use `<title>` for now (free, accessible); upgrade to a popover only if explicit hover detail is requested.
- **Lead-time + duration:** two `recharts` `BarChart`s, single series, no axes labels — minimal Linear-style bars. Each bar shows its count above on hover.

### Tables

`top-rooms-table` and `no-show-watchlist` use `@tanstack/react-table` via the existing `data-table.tsx` component IF it fits; otherwise straight shadcn `Table`. Sortability for v1: only top-rooms (by booked hours). No-show watchlist is fixed sort.

### Loading + empty + error states

- Loading: skeleton placeholders for KPI cards (matching the real card heights — no layout shift) and grey blocks for chart/table areas.
- Empty (zero bookings in window): single centred empty state under the KPI row replacing all charts/tables: "No bookings in this window. Try widening the date range."
- Error: `toastError("Couldn't load bookings overview", { error, retry })`. The page shows the previous data with a small "Failed to refresh" banner above the KPI row.

### Formatting (mandatory per CLAUDE.md)

- All numbers via `formatCount`.
- All timestamps in tables via `formatRelativeTime` for the visible value, `formatFullTimestamp` in `<time title="…">` for hover.
- Percentages via the local `pct` helper above.

## Performance

- **One round-trip** end-to-end via the RPC.
- **`placeholderData`** for filter changes — no skeleton flash.
- **`staleTime: 60_000`** — same as desk reports.
- **No polling.** Reports are point-in-time; users refresh on demand. The realtime channel on reservations (00132) is for the scheduler, not analytics.
- **Indexed queries.** Migration adds `reservations(tenant_id, reservation_type, start_at)` if not already covered.

Target: under 250 ms server p95 for a 30-day window on a tenant with 10k room reservations and 50 rooms. Tested with `explain (analyze, buffers)` post-deploy.

## Permissions + visibility

- Frontend route gated by `requiredRole="admin"` (existing AdminLayout protection).
- Backend endpoint inherits the global JWT guard. The RPC runs as `SECURITY INVOKER` so RLS applies — non-admin sessions returning a tenant scoped to "no rows" produce empty totals (acceptable; the page is admin-only via routing anyway).
- No watcher / participant filtering — admins see all bookings in their tenant. This is consistent with the service desk overview.

## Migrations

`supabase/migrations/00155_room_booking_report_rpc.sql`:

1. `create or replace function public.room_booking_report_overview(p_tenant uuid, p_from date, p_to date, p_building_id uuid) returns jsonb` — `SECURITY INVOKER`, `STABLE`, `LANGUAGE sql`.
2. `grant execute on function public.room_booking_report_overview(uuid, date, date, uuid) to authenticated;`
3. `comment on function ...` describing the contract.
4. Add covering index `reservations_tenant_type_start_idx` if not present.
5. `notify pgrst, 'reload schema';`

Pushed via `pnpm db:push` (DB password in `.env`).

## Testing

- **API service:** unit tests for input clamping (`days > 365` → 422; `from > to` → 422). Mock the supabase client.
- **API e2e (light):** one happy-path test calling `/reports/bookings/overview` with seed fixtures, asserting the JSON shape contains all top-level keys. No deep numeric assertions — that's brittle.
- **Frontend:** smoke test that the page renders without crashing given a stub response. Mock the network call. No visual regression tests.
- **Manual verification:** load the page in dev against the remote DB after migration is pushed; verify each card renders a number, the chart renders four series, the heatmap renders the grid, both tables populate.

## Out-of-scope (deferred)

- Per-tenant business-hours config (drives "bookable hours"). v2.
- CSV / PDF export. v2.
- Comparison with previous period (Δ vs. last 30d). v2.
- Floor / room-type segmenter. v2.
- Drill-through to a single-room history page. v2.
- Desks / parking aggregations. v2.

## Open risks

- **No-show signal depends on the auto-release task.** If the background task in `CheckInService` is paused or slow, no-shows are under-counted (rows stay `confirmed` past `end_at` instead of flipping to `released`). Mitigation: the SQL also counts `status='confirmed' AND end_at < now() AND checked_in_at IS NULL AND check_in_required=true` in the no-show numerator as a defensive fallback. Documented inline in the RPC.
- **Bookable hours are constants for v1** (10h × weekdays). Tenants with 24/7 operations or weekend-heavy use will read low utilization. Footer secondary on the Utilization card states the assumption.
- **Heatmap uses the caller's browser timezone** for v1 (passed as the `tz` query param). Two admins viewing from different cities will see slightly shifted heatmaps. A per-tenant default timezone or per-building heatmap is a v2 concern.
