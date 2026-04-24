# Portal visual redesign — design

**Date:** 2026-04-24
**Status:** Draft, pending user review
**Owner:** Prequest platform

---

## 1. Problem

The employee portal (`/portal/*`) today shares the operator shell (`SidebarProvider` + `Sidebar` + `SidebarInset`) with the Service Desk and Admin apps. Home shows a centered "How can we help you?" hero with a search bar and a flat grid of lucide-icon category cards. All category pages, the request form, and "My Requests" reuse the same card pattern.

Three problems:

1. **The portal is visually indistinguishable from the operator app.** Employees making a request see the same sidebar, same card system, same typography as the IT agent who processes that request. The two audiences have nothing in common — one is a consumer doing a task, one is an operator running a workflow — and the current design conflates them.
2. **No room for workplace identity.** There is no surface for the tenant's brand, the building, the people, or the experience. Everything is abstracted to icons + one-liners. A real workplace portal should feel like a *place* — Acme HQ on Pancras Square, the lobby photo, the team — not a generic admin tool.
3. **No imagery pipeline.** Admins cannot upload a hero, category covers, or announcements. The current catalog-category dialog only supports a lucide icon name.

The roadmap also adds **Book a Room**, **Order / Catering**, **Visitors**, and (Phase 4) a **Knowledge Base**. These are consumer-app experiences by nature — photos of rooms, menu items, QR passes, live "arrived" states. They cannot be shoehorned into the operator shell.

The portal needs its own visual language, its own shell, and a content-upload pipeline that admins can use to customize each workplace.

## 2. Scope

### In scope (v1)

**A — New portal shell.** A separate top-nav layout for all `/portal/*` routes. No sidebar. Centered nav with the five headline flows (Home · Requests · Rooms · Visitors · Order). "Switch to Service Desk" link for privileged users in the account menu. Mobile: bottom tab bar. Keyed components and tokens explicitly separated from the operator app.

**B — Home redesign.** Big workplace hero with tenant image (or gradient fallback), time-of-day greeting, welcome copy, search. Two-column body on desktop: catalog left, "Your activity" right. Announcements block below. Mobile: single column, activity below catalog.

**C — Catalog browse redesign.** Category detail page with banner (cover image + breadcrumb + title), subcategories rail, services grid. Slot reserved for a "Popular answers" rail (KB, Phase 4) above services — hidden when KB is empty.

**D — Request form redesign.** Focused form with productive density. Header shows request-type icon + name + "what happens next". Footer pins SLA hint + submit actions. Right-side panel slot reserved for live KB deflection (Phase 4).

**E — My Requests redesign.** Single unified list of tickets, bookings, visitors, and orders. Tabs filter by All / Open / Scheduled / Closed. Detail page is conversation-first (messages prominent, system events inline-quiet) with a metadata sidebar containing an SLA ring.

**F — New consumer flows (UI only, APIs per phase).**
- Book a Room: date picker + filter chips + photo/availability card grid. API ready per `docs/spec.md` §8.8; ship UI in Phase 2.
- Order / Catering: cart pattern, category rail, dietary tags, lead times, approval threshold warnings. API Phase 2.
- Visitors: upcoming list + quick-invite form, live "Arrived" status. API Phase 2.

**G — Admin: portal appearance (extends `/admin/branding`).** A new "Portal" area under branding. Three `SettingsGroup` blocks: Workplace hero (per location), Greeting & voice, Announcements.

**H — Admin: category covers (extends `/admin/catalog-hierarchy` dialog).** Add a "Visual" section to the category edit dialog with a cover/icon toggle, cover picker (platform defaults + upload), fallback icon selector, and a live card preview.

**I — Data model + storage.**
- `portal_appearance` — per-location settings: `hero_image_url`, `welcome_headline`, `supporting_line`, `greeting_enabled`.
- `portal_announcements` — per-location: `title`, `body`, `published_at`, `expires_at`.
- `catalog_categories`: add `cover_image_url text`, `cover_source text check (cover_source in ('image','icon')) default 'icon'`.
- Re-use the Supabase storage bucket already used by `/admin/branding` for uploads.

### Out of scope (v1)

- No second bundle / subdomain split. Portal remains served by the same Vite app; separation is achieved at the layout level.
- No change to the operator shell (`/desk/*`, `/admin/*`). Those keep `SidebarProvider`.
- No request-type-level cover images (Level 4 in brainstorming terms). Only top-level categories get covers; request types stay icon + text.
- No AI-generated imagery, no stock-photo picker inside the upload flow. Admins bring their own images or use platform defaults.
- No new font family, no new color palette. Geist stays; tokens from `@/index.css` are reused.
- No change to how search works under the hood — the reshaped search is a UI refactor over the same `/portal/catalog` endpoint.
- No native mobile app. Portal is mobile-web with native-app patterns (bottom tabs).
- **KB feature itself is Phase 4.** This spec designs *the slots* for KB: the sidebar panel on the form, the rail on the category page, the "Answers" section in search results. They render empty-or-hidden until the KB feature ships.

## 3. Visual direction

Blend of **C (warm / branded workplace)** + **D (dense / productive hub)**:

- **Warm:** hero photography, greeting by name + time of day, workplace identity in the chrome (tenant logo + building name), breathing room, image covers on categories.
- **Productive:** activity panel on every visit surfaces open tickets, upcoming bookings, visitors. Single unified My Requests feed. Forms remain dense shadcn/Field forms once the user is "doing work."

Explicit references the design should *not* pull from: the operator app itself (sidebar, dense tables, cramped SettingsPageShell forms). The operator app is for operators; the portal is for people doing one task in their day.

## 4. Architecture

### 4.1 New layout: `PortalLayout` (top-nav)

Replace the current `apps/web/src/layouts/portal-layout.tsx` body. The component still wraps `<PortalProvider>` and still gates on `portal.can_submit`, but the inner shell swaps from `SidebarProvider` to a new layout:

```
<div className="min-h-screen bg-background">
  <PortalTopBar />                        // sticky, backdrop-blur
  <main className="pb-[env(safe-area-inset-bottom)]">
    {!portalLoading && portal && !portal.can_submit
      ? <PortalNoScopeBlocker />
      : <Outlet />}
  </main>
  <PortalBottomTabs />                    // mobile only (md:hidden)
</div>
```

- `PortalTopBar` (desktop ≥ `md`):
  - Grid `1fr auto 1fr`. Left: tenant logo + workplace name ("Acme HQ"). Center: nav links (Home · Requests · Rooms · Visitors · Order) with underline indicator on active route. Right: location pill (reuses `PortalLocationPicker`) + account avatar. `h-14`, `border-b`, `bg-background/85 backdrop-blur`.
  - Account menu (existing `NavUser` replaced by a new `PortalAccountMenu`) shows profile + settings + a "Switch to Service Desk" link when `useAuth().hasRole('agent') || hasRole('admin')`.
- `PortalTopBar` (mobile `< md`):
  - Flex row. Logo + workplace name, location chip (shortened label), account avatar. No nav links (they move to bottom tabs). `h-12`.
- `PortalBottomTabs`:
  - 5 icon+label tabs pinned bottom, `h-16`, `border-t`, `bg-background/95 backdrop-blur`, safe-area padding. Each tab: icon + short label (Home · Requests · Rooms · Visitors · Order). Active tab: filled icon + slight lift (`translate-y-[-1px]`). Hidden on `md+`.
  - Badge dot when `Your activity` has new/changed items relevant to that tab.

Both bars are pure layout components with no data-fetching — they consume `usePortal()` and `useAuth()` via hooks already in place.

### 4.2 Content width

Portal pages do not use `SettingsPageShell`. The operator template is for admin density; the portal uses its own shell:

- `PortalPage` wrapper: `mx-auto w-full max-w-[1600px] px-4 md:px-6 lg:px-8` with responsive vertical padding. No borders, no heading scaffolding. 1600px matches the `SettingsPageWidth.ultra` value used for dashboards elsewhere — the portal genuinely benefits from horizontal canvas for the hero + two-column activity layout.
- The home hero and category banner break out of the max-width via `-mx-4 md:-mx-6 lg:-mx-8` (full-bleed image) + internal `max-w-[1600px] mx-auto` on their *text* content, so the image can stretch edge-to-edge but the greeting and search stay aligned with the content grid below.
- Specific pages may opt for a narrower inner container *inside* the 1600px wrapper (e.g. the request form uses `max-w-[920px]` for readable form width). The outer `PortalPage` max-width is always 1600px.

### 4.3 Motion & tokens

- No new easing or color tokens. Reuse `--ease-smooth` / `--ease-spring` / `--ease-snap` from `apps/web/src/index.css`.
- Bottom tab entry/exit: `--ease-swift-out` 200ms.
- Hero fade-in on load: 400ms `--ease-spring`, image gets a subtle `scale(1.02 → 1.0)` parallax (respecting `prefers-reduced-motion`).

### 4.4 Typography

- Hero headline: `text-3xl md:text-5xl font-semibold tracking-tight text-balance` (larger than anywhere in the operator app on purpose).
- Category banner title: `text-2xl md:text-4xl font-semibold tracking-tight`.
- Eyebrows (section labels): `text-[11px] uppercase tracking-wider text-muted-foreground font-semibold`. This is the only case in the portal where uppercase tracking is used.
- Tabular numerals applied to counts on tabs and list-rows via `.tabular-nums` (already global).
- Relative times via `formatRelativeTime` (already in `@/lib/format`), with `formatFullTimestamp` as `title`.

## 5. Page designs

### 5.1 Home (`/portal`)

**Above the fold:**
- Full-width hero, min-height `260px` desktop / `180px` mobile.
- Background: tenant hero image from `portal_appearance.hero_image_url` (resolved for `portal.current_location`), OR a branded gradient fallback (radial overlays + linear gradient derived from tenant brand color). A semi-opaque dark scrim is always applied so overlay text stays readable regardless of the image.
- Overlay content (max-width 640px): eyebrow = "Good afternoon, Sarah" (time-of-day + first name, togglable in admin), h1 = `welcome_headline`, subtitle = `supporting_line`, then a search input with `backdrop-blur` and translucent bg.
- Hero search submits to the existing catalog search logic; nothing changes server-side.

**Body (desktop — two columns, `1.8fr 1fr`):**
- Left: "Browse services" — 3-col grid of category cards (6–8 tiles). Each card: cover image (aspect `2.1/1`) with icon overlay if `cover_source='icon'`, body with title + one-line description. Click → `/portal/catalog/:id`.
- Right: "Your activity" panel, surfaces a merged feed of:
  - Open requests (from `/tickets?mine=1&status=open|in_progress`)
  - Upcoming bookings (from future `/reservations?mine=1`, Phase 2 — empty state until then)
  - Upcoming visitors (from future `/visitors?host=me`, Phase 2 — empty state)
  - Recent orders (Phase 2)
  - Each row: type-icon + title + meta (source + time) + status badge. Max 6 rows, "View all" link → `/portal/requests`.

**Body (mobile — single column):**
- Categories (2-col grid of covers).
- Activity panel below, full-width, same row format but stacked.

**Announcements section:**
- Bottom of home page, above footer. Rendered from `portal_announcements` matching `current_location.id` with `published_at <= now() < expires_at`. One active per location per spec.
- Full-width card with title + body + published timestamp + dismiss (dismissal stored in localStorage keyed by announcement id).

**Empty / fallback states:**
- No hero image: gradient + logo watermark (derived from `branding.logo_url`).
- No announcements: section is not rendered.
- No activity items: panel shows a friendly empty state ("Nothing open. Click a service to get started.") — always rendered so layout doesn't collapse.

### 5.2 Category detail (`/portal/catalog/:id`)

- Banner (min-height `150px` desktop / `110px` mobile): category cover image + gradient overlay, breadcrumb (`Home › Category name`), h1 = category name, subtitle = category description.
- Sticky sub-bar (optional, only when 5+ subcategories): horizontal scrollable list of subcategories as chips, links to subcategory pages.
- Slot: **Popular answers** (Phase 4 KB). 2-col grid of article tiles (lightbulb icon + title + read-time + view count). Hidden in v1 until KB ships. The component `<PortalCategoryAnswers categoryId={id} />` mounts unconditionally and returns `null` when the API returns zero articles.
- **Subcategories** rail: 3-col compact cards (icon + name + count). Only rendered when children exist.
- **Services** grid: 2-col wide tiles. Each tile: icon + name + description (the description field on `request_types` is the "sell the service" one-liner). Last tile: dashed "Other" card → `/portal/submit` (general request).
- Back button top-left returns to parent category or `/portal`.

### 5.3 Request form (`/portal/submit?type=:id`)

- No banner. Max-width container `max-w-[920px]`.
- Top: back link to the category it came from.
- Header card: request-type icon (large, 44px in a soft-tinted square), name (text-xl), "what happens next" sentence (derived from `request_type.sla_policy` when set, e.g. "Usually resolved within 4 hours"). Border-bottom separator.
- Form body: shadcn `Field` primitives per CLAUDE.md's form composition rule. Form schema is already dynamic via `form_schemas`. The UI shift is:
  - Render `FieldSet`s for schema groupings if the `form_schemas` row defines groups (today the admin has `group_label` on fields — we honor it). If no groups are defined, render a single flat `FieldGroup` as today.
  - Use chip-based multi-select for enum fields with ≤6 options (`FieldChips` wrapping `RadioGroup`/`CheckboxGroup` — new primitive in `apps/web/src/components/ui/field-chips.tsx`). Schema-driven: whenever a field is `enum` with `<= 6` options, it renders as chips instead of a Select.
  - File upload area uses a polished drag-drop tile rather than the default file input.
- Right-side slot: **KB deflection panel** (Phase 4). Reserved 340px column. In v1 this column is absent (form takes full width); in Phase 4 we widen the page, mount `<PortalFormKbPanel requestTypeId description={description} />` and it ranks articles by request-type match + description similarity. Layout is designed so enabling KB does not shift existing fields horizontally — form is always left-justified within its column.
- Footer: sticky bottom bar with SLA hint on the left ("Usually resolved within 4 hours"), "Save draft" + "Submit request" on the right.

### 5.4 My Requests (`/portal/requests`)

**List view:**
- Page title + "New request" primary action.
- Tabs: All / Open / Scheduled / Closed (counts from server).
- Unified rows — one row pattern regardless of source type:
  - Left: 32px colored icon keyed by type (ticket=blue, facilities=orange, room=purple, visitor=pink, order=green).
  - Main: title + sub (request type/source · category/team).
  - Right side metas: time (relative), assignee (when applicable), status badge.
- Clicking a row navigates to the detail view for that type:
  - Ticket → `/portal/requests/:id`
  - Booking → `/portal/rooms/:bookingId`
  - Visitor → `/portal/visitors/:id`
  - Order → `/portal/order/:id`
- Server combines sources into one paged feed via a new `/portal/my-feed?status=&cursor=` endpoint. Each row payload: `{ id, type, title, subtitle, icon_kind, status, timestamp, assignee_name? }`.

**Ticket detail view (`/portal/requests/:id`):**
- Back link, header card (icon + title + ticket # + opened-ago + category).
- Main column: conversation thread.
  - Messages (requester and assignee) are prominent cards with avatar + name + timestamp + body.
  - System events (assigned, status change, SLA trigger) are quiet inline lines, no card.
  - Threading is linear (most recent at bottom).
- Reply composer: pinned below thread. Textarea + attachment + Send.
- Right sidebar (`300px`):
  - **Status** block: SLA ring (conic-gradient circle progress) + "In progress / Waiting / Done" + "X of SLA used · Y remaining".
  - **Assignee** block: name + team.
  - **Location** block: workplace + level + desk.
  - **Additional context** fields from the form_schema (Equipment, Urgency, etc.)

### 5.5 Book a Room (`/portal/rooms`)

Phase 2. UI designed now so backend integration is a swap-the-fetch change.

- Header: "Book a Room" + date context + "Change date" action.
- Filter bar: capacity chip set (1–4, 5–8, 9–15, 16+), amenity chips (Video conferencing, Whiteboard, Catering-ready), time picker (defaults to "Available now").
- Rooms grid: 3-col cards. Each card: photo cover + capacity pill overlay (top-right), body with room name + level + amenity glyphs + availability strip (30-min slots showing free/busy for the next 2 hours).
- Click a free slot → opens a booking drawer (uses existing `Drawer` component) with: attendees (email chip entry), duration (30/60/90/120), title, "Add to booking" button that navigates to `/portal/order` pre-filled with `?booking_id=…`.

### 5.6 Order / Catering (`/portal/order`)

Phase 2. UI designed now.

- Header: contextual — "Catering & supplies" with a badge if linked to a booking ("✓ Linked to Kensington Room 4A · Thu 3pm · 8 people"). Without a linked booking, just page title.
- Two-column body:
  - Left: horizontal category rail (Food · Drinks · Snacks · AV & setup · Stationery) + item grid. Each item: thumbnail + name + unit hint ("Per person" / "Serves 8–10") + lead-time + dietary tags + price + `+` button.
  - Right: cart panel (sticky) — line items + subtotal + delivery context (when linked to booking, auto-fills destination and time-15-min-before-start) + approval warning if above `approval_threshold`.
- Approval thresholds are per tenant (from `tenant_settings`). When crossed, the Submit button text becomes "Submit for approval" and the warning block displays inline.

### 5.7 Visitors (`/portal/visitors`)

Phase 2. UI designed now.

- Header: "Visitors" + "Invite visitor" primary action.
- Two-column body:
  - Left: "Upcoming" list — rows with avatar (initials) + name + company + arrival date/time + status badge (Registered / Pre-registered / Arrived). Arrived status shows the check-in time.
  - Right: "Quick invite" form panel (shadcn Field primitives): name, company (optional), date, time, meeting location, optional notes. Submit sends email with QR pass + notifies reception.

## 6. Admin surfaces

### 6.1 `/admin/branding` — add "Portal" section

Extend the existing `branding.tsx` page. Add a new `SettingsGroup` area titled **Portal appearance**, positioned after the logos and colors blocks.

Inside it, use `SettingsRow` for each setting:

**Workplace hero group** (one `SettingsGroup` card):
- One `SettingsRow` per location (iterates over tenant's locations, filtered to sites + buildings).
  - Label: "Hero image — {location.name}"
  - Description: "Recommended 2400 × 800 px. JPG/PNG/WebP, max 2 MB."
  - Control: clickable row → opens an upload dialog (reuses the `LogoSlot` pattern from current `branding.tsx`). Row value shows either a thumbnail + filename or "Not set — using default."
- Save: auto-save per image (upload completes → toast → refresh).

**Greeting & voice group:**
- `SettingsRow` — Welcome headline (inline text input, debounced auto-save).
- `SettingsRow` — Supporting line (inline text input, debounced auto-save).
- `SettingsRow` — Time-of-day greeting (inline `Switch`, immediate save).

**Announcements group:**
- `SettingsRow` per location showing the current announcement (if any): "{title} — {body summary} · Published by X · Expires {date}."
- Primary action at the top of the section: "Publish announcement" button → opens a dialog (title + body + expiry picker). One active per location at a time; publishing a new one retires the previous.

All auto-save where possible (per CLAUDE.md settings-page rules). Dialog saves explicitly via primary button.

Route: stays at `/admin/branding`. No tab navigation added — section scroll is fine. If the page grows further, we can split "Portal" into `/admin/branding/portal` as a child detail page later.

### 6.2 `/admin/catalog-hierarchy` — category edit dialog

Extend the existing dialog in `catalog-hierarchy.tsx`. Add a **Visual** section (as a `FieldSet` with `FieldLegend`) *before* the current icon picker:

- `Field` — Visual mode (radio group: "Cover image" / "Icon only"). Stored on `catalog_categories.cover_source`.
- When "Cover image" is selected:
  - `Field` — Cover picker: 4 platform-default thumbnail tiles + 1 upload slot (`+` tile). Clicking a default sets `cover_image_url` to a preset asset URL; clicking upload opens file picker → Supabase storage → sets `cover_image_url`.
  - `FieldDescription`: "Pick from our defaults or upload a custom image. Recommended 1200 × 600 px."
- When "Icon only": cover picker is hidden.
- `Field` — Fallback icon (always present, required): existing icon grid. Used if the cover image URL fails to load.
- Below: a live preview card that shows how the category will render on the portal home (120px wide mini).

Request-types dialog stays icon-only; no cover for leaves (per brainstorming agreement).

Save: explicit save button (the dialog already has one). Matches the existing dialog save flow.

### 6.3 New admin endpoints

- `GET /admin/portal-appearance?location_id=` → current settings for a location.
- `PATCH /admin/portal-appearance` — `{ location_id, hero_image_url?, welcome_headline?, supporting_line?, greeting_enabled? }` (partial update).
- `POST /admin/portal-appearance/hero-upload` — multipart → uploads to `portal-assets` bucket → returns URL.
- `GET /admin/announcements?location_id=` → current announcement (max one active).
- `POST /admin/announcements` — publish new (retires any existing active).
- `DELETE /admin/announcements/:id` — unpublish.
- Extend `PATCH /admin/catalog-categories/:id` — accept `cover_image_url`, `cover_source`.
- `POST /admin/catalog-categories/:id/cover-upload` — multipart → uploads → returns URL → sets `cover_image_url`.

## 7. Data model

### 7.1 `portal_appearance`

```sql
create table public.portal_appearance (
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references spaces(id) on delete cascade,
  hero_image_url text,
  welcome_headline text,
  supporting_line text,
  greeting_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, location_id)
);
create index on public.portal_appearance (tenant_id);
```

RLS: tenant-scoped read for authenticated users of that tenant; write requires `branding.write` permission (add to `roles.permissions`).

Fallback resolution when a location has no row: walk up the `spaces.parent_id` tree looking for an ancestor with `portal_appearance`. If none, use a tenant-level default (tenant-id, location-id = tenant's root space).

### 7.2 `portal_announcements`

```sql
create table public.portal_announcements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  location_id uuid not null references spaces(id) on delete cascade,
  title text not null,
  body text not null,
  published_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now()
);
-- Postgres partial-index predicates must be IMMUTABLE, so the DB-level
-- constraint only covers the permanent-active case. The service's
-- retire-and-insert pattern covers time-windowed (expires_at > now()).
create unique index portal_announcements_one_active_per_location
  on public.portal_announcements (tenant_id, location_id)
  where (expires_at is null);
create index on public.portal_announcements (tenant_id, location_id, published_at desc);
```

The partial unique index enforces the permanent-active case at the DB; time-windowed active enforcement lives in the publish service (retire existing active before insert).

### 7.3 `catalog_categories` — add cover columns

```sql
alter table public.catalog_categories
  add column cover_image_url text,
  add column cover_source text not null default 'icon'
    check (cover_source in ('image', 'icon'));
```

No backfill. Existing rows default to `cover_source='icon'` and continue to use the icon. When an admin switches to image, they pick/upload a cover.

### 7.4 Storage

Reuse the existing `branding` bucket (Supabase) or add a sibling `portal-assets` bucket. Files path convention: `{tenant_id}/{type}/{uuid}.{ext}` where type is `hero | category-cover`. Access: signed URLs for authenticated users of the tenant; RLS on the bucket ensures no cross-tenant reads.

## 8. Responsive / mobile

Breakpoint is `md` (768px) — below is mobile layout, above is desktop.

Per-page mobile rules:

- **Home**: hero shrinks to 180px, search tile stays inside. Body collapses to single column; categories become 2-col grid of covers; activity panel renders below categories full-width. Announcements block full-width at bottom.
- **Category detail**: banner shrinks to 110px. Subcategories rail becomes horizontal scroll. Services grid becomes 1-col.
- **Form**: KB panel (when present) becomes a collapsible "3 articles might help" strip above the textarea. Sticky footer bar retains SLA hint + actions but stacks on very small widths.
- **My Requests list**: rows stack slightly — time + assignee move to a sub-line under title. Status badge stays on the right.
- **Request detail**: sidebar moves to a collapsible summary card at the top of the page, below the header. SLA ring visible in the summary.
- **Book a Room**: grid becomes 1-col. Filter chips horizontal-scroll.
- **Order**: cart panel becomes a sticky bottom sheet that expands when tapped. Item grid becomes 1-col.
- **Visitors**: upcoming list and invite form stack.

Bottom tab bar visible on all portal pages below `md`. Active tab updated based on current route. Safe-area padding handled by CSS `env(safe-area-inset-bottom)`.

## 9. Accessibility

- All interactive elements are `<button>` or `<a>` with focus-visible rings per the global CSS.
- Hero overlay text: AA contrast minimum against the darkest part of the scrim; we compute a darker scrim when the image is bright.
- Announcement dismiss remembers by localStorage keyed on id; also re-shows when a new announcement is published (new id).
- Bottom tab bar: each tab has `aria-label` with full name even when visually abbreviated.
- Sidebar KB panel announces new results with `aria-live="polite"` when Phase 4 ships.
- Prefers-reduced-motion respected by existing global CSS rule — the hero scale + fade are clamped.

## 10. Implementation order

### Slice 1 — New portal shell (no content change)
1. `PortalTopBar`, `PortalBottomTabs`, `PortalAccountMenu` components.
2. Rewrite `portal-layout.tsx` to use them instead of `SidebarProvider`.
3. Add `"Switch to Service Desk →"` link in `PortalAccountMenu` when user is agent/admin.
4. Ensure existing portal routes (home/catalog-category/submit/my-requests) still render inside the new shell — no visual upgrade yet, just the shell swap.

**Exit criteria:** `/portal/*` has a top nav on desktop and bottom tabs on mobile. Agent/admin users can still jump to `/desk` via the account menu. No visual difference in page *content* yet.

### Slice 2 — Data model + admin surfaces (enables content)
1. Migration: `portal_appearance`, `portal_announcements`, `catalog_categories.cover_image_url` + `cover_source`.
2. Backend: CRUD endpoints per §6.3. Storage path for `portal-assets`.
3. `/admin/branding` new Portal section (all three `SettingsGroup`s).
4. `/admin/catalog-hierarchy` category dialog — add Visual section + cover picker + fallback icon.
5. Seed 6 default category covers and a default workplace hero gradient.

**Exit criteria:** admins can upload hero + category covers and publish announcements, and these settings are persisted.

### Slice 3 — Home redesign
1. Hero component (`PortalHomeHero`) wired to `portal_appearance`.
2. Category card redesign with cover image + icon fallback.
3. `Your activity` panel — reads from existing `/tickets?mine=1&status=open|in_progress` for now; leaves placeholder empty states for bookings/visitors/orders.
4. Announcements block wired to `portal_announcements`.

**Exit criteria:** home page matches the mockup with real data for categories + tickets.

### Slice 4 — Catalog browse + request form redesign
1. Category detail banner with cover.
2. Subcategories rail + services grid polish.
3. Reserve KB slots (render `null` in v1).
4. Request form — new header, grouped field sets, sticky footer, SLA hint.

**Exit criteria:** the submit flow feels warmer and more "consumer," with the KB slot reserved.

### Slice 5 — My Requests redesign
1. New unified list endpoint `/portal/my-feed`.
2. Tabs + row renderer.
3. Ticket detail conversation-thread view.

**Exit criteria:** My Requests shows all user-originated items in one list, and ticket detail is conversation-first.

### Slice 6 — Book a Room / Order / Visitors (Phase 2 alongside backend)
1. Ship pages one by one as backend lands.
2. Each uses the same `PortalPage` primitives + existing shell.

### Slice 7 — KB slots turn on (Phase 4)
1. KB panel in form, popular-answers rail on category, answers section in search.
2. Widen form page to `1fr 340px` when KB panel is present (server-side feature flag).

## 11. Non-goals

- Operator app (`/desk`, `/admin`) visual redesign. Out of scope entirely.
- Cross-tenant theming (portal still renders the authenticated tenant's appearance only).
- Portal personalization beyond location + greeting name (no favorite categories, recommendations, etc.).
- Portal analytics dashboard (how many employees saw an announcement, etc.).
- Portal notifications panel — email + in-app notifications stay as-is for v1.
- Chat/AI assistant in portal. Phase 2+.
- Request-type-level cover images (only top-level categories).

## 12. Risks & open questions

### R1 — Workplace hero fallback chain
An employee's `default_location_id` may be set to a sub-space (a specific floor or zone). `portal_appearance` is most useful at the building level. We need a clear walk-up rule: start at the employee's current selected location, walk up `spaces.parent_id` until we find a `portal_appearance` row, fall back to tenant root, fall back to gradient. This is portal-only (not routing); implement the walk-up inside the `portal_appearance` resolver and unit-test it. No dependency on the assignments/routing docs.

### R2 — Image size / bandwidth
Hero images at 2400×800 can be heavy. Supabase storage does not auto-optimize. Options:
- Recommend PNG/JPEG size cap + client-side resize on upload.
- Or generate 3 sizes (mobile/tablet/desktop) server-side on upload and serve via `<picture>`.

Prefer option 2 for visible quality; adds one storage trigger. Decide in Slice 2.

### R3 — Agent-and-employee user experience
A user who is also an agent currently sees Portal/Workspace/Admin in one sidebar. Post-redesign, they see the portal top-nav by default when on `/portal/*`, with "Switch to Service Desk" in the account menu. There's no visual link *back* from `/desk` to `/portal` yet — we should add a symmetric link in the operator shell ("Switch to Portal" in the sidebar footer) in Slice 1 to close the loop.

### R4 — Bottom tabs vs. back navigation
React Router doesn't natively remember per-tab history stacks. A user on `Requests → ticket detail`, tapping `Home`, then tapping `Requests` again — should they go back to the list or back to the detail? Keep it simple: bottom tabs always navigate to the tab root (list view), never remember scroll/state. Acceptable tradeoff for v1.

### R5 — Search result ordering with KB
In Phase 4, global search returns articles + categories + services. Design says articles first. Confirm with user that "answer first" is the intended ordering (vs. a relevance-based mix). This is a Phase 4 decision; noting here so it's not forgotten.

### R6 — Announcement display rules
Spec says "one active per location." Resolution chain when employee is at a sub-space: walk up `spaces.parent_id` to find the first location that has an active announcement. What if both Dublin-office and Dublin-office-Level-3 have one active? Use the most specific (deepest) — that's what the walk-up resolves to naturally. Document.

### R7 — Announcements overlap with in-app notifications
These are different surfaces. Announcements are tenant-wide broadcast ("cafeteria reopens Monday"); notifications are personal ("your ticket was assigned"). Keep them separate; don't merge the feed. But in the future a "push to everyone at this location" broadcast could generate both an announcement AND individual notifications — out of scope v1.

### R8 — KB Phase 4 dependency
The spec reserves slots (form sidebar, category rail, search answers) but the actual rendering depends on a KB feature that's Phase 4. Between now and then, those slots render empty or are hidden behind a feature flag. No visual layout shift when they turn on — verify with screenshots during Slice 4.

---
