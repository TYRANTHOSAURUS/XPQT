# Employee Portal Landing — Redesign

**Date:** 2026-04-17
**Owner:** Frontend (employee portal surface)
**Status:** Design approved pending user review
**Scope:** `apps/web/src/pages/portal/home.tsx` and dependent reusable components

---

## 1. Context and problem

The current employee portal landing (`apps/web/src/pages/portal/home.tsx`) is a centered hero ("How can we help you?"), a single search bar, and a uniform 4-column colored-icon card grid of catalog categories. It has three problems:

1. **Generic aesthetic.** Feels like a template AI landing page — centered hero, pastel icon grid, no imagery, no personality. Not inviting.
2. **Zero personalization.** A brand-new user and a power user with open tickets see the same page. The user's own data (open requests, approvals, assigned assets) is one or more clicks away.
3. **No discovery depth.** Every feature other than the catalog requires navigating to another route. No visibility into "what's mine," "what's new," or "what's next."

Spec alignment reference:

- **`docs/spec.md` §5.1** — the portal is the "unified front door" covering services, requests, bookings, visitors, catering, search, tracking, satisfaction.
- **§5.2** — "One entry point does NOT mean one cluttered screen. The UX must be layered and personalized."
- **§5.3.A** — employee UX principles: *simple, guided, personalized, AI-assisted, task-first.*
- **§5.4** — employee portal is **mobile-priority High** → mobile-first responsive design.
- **§9.22** — the service catalog is the employee-facing "storefront"; categories are tenant-configurable (`display_order`, `active`, icon, description).
- **§20.2** — Phase 2 introduces an AI chat interface *in the portal*; the search surface should be designed so this can occupy the same slot without redesign.

Design-system note:
- Admin and service-desk surfaces follow **`CLAUDE.md`: Linear-style — clean, spacious, minimal borders, subtle color.**
- The **employee portal is the exception.** It targets occasional users, is mobile-first, and is the front door for non-power employees. It uses a warmer, more expressive visual language. (See §3 below.)

---

## 2. Goal and success criteria

Replace the current landing with a personalized, inviting, catalog-centric home that:

- Feels designed, not templated. No "four centered emoji cards" look.
- Surfaces personal data first: *my open requests, my approvals, my assets, my bookings.*
- Keeps the service catalog as the visual centerpiece but with real hierarchy (featured vs. standard categories).
- Previews Phase 2 and Phase 3 features today via "Coming soon" ribbons so the full UI is visible even before the underlying features ship.
- Leaves the search slot ready to evolve into the Phase 2 conversational AI without layout change.
- Works on mobile first; desktop is the widened case.

Success is judged qualitatively against these criteria. No metric gating.

---

## 3. Visual language

### 3.1 Mode and canvas

- **Light mode** by default.
- Outer canvas: warm off-white (`#f4f3ee` range — "cream").
- Inner content wrapper: near-white (`#fafaf7`).
- Content is **contained**, not full-width: `max-width: 1120px`, centered, with horizontal padding that scales with viewport.
- Rounded card radii: `14px` for utility cards, `18–20px` for featured and hero cards.
- Subtle borders (`#e7e5e0`) and very light shadows; no heavy drop shadows.

### 3.2 Color use

Color is informational or atmospheric, not decorative:

- **Status dots** — amber `#f59e0b` for at-risk, blue `#3b82f6` for pending, emerald `#10b981` for success, rose `#f43f5e` for breached/urgent.
- **Category tiles** — each catalog category has a soft pastel background paired with a saturated icon-box. Palette is derived from the category's `icon` field via a fixed client-side map `iconToPalette` (e.g., `Monitor → indigo`, `Wrench → emerald`, `Users → fuchsia`, `ShieldCheck → rose`, `MapPin → cyan`, `Package → amber`, and a neutral slate fallback for unmapped icons). This extends the existing `colorMap` in `home.tsx`. Tenant admin override is a Phase 2 enhancement.
- **Featured hero and duo cards** use soft gradient backgrounds (lavender→pink for the primary hero, blue→cyan for Book, amber→orange for Order) — gradients are reserved for these three slots only to preserve their visual weight.
- **Utility cards** ("Your stuff") are neutral white, no color, except for a single status dot.

### 3.3 Typography

- System stack (`-apple-system, BlinkMacSystemFont, 'Inter', system-ui`).
- Greeting: 40–44px / 700 / tight tracking (`-0.02em`).
- Hero headline: 32–36px / 700.
- Duo headline: 22–26px / 700.
- Section labels ("Quick actions", "Your stuff", "Browse services"): 11px / 700 / uppercase / 0.16em letter-spacing / muted color.
- Kicker labels inside hero cards: same small-caps treatment, category-colored.

### 3.4 Imagery

- **Hero card** — illustrated product preview (a rendered mini form/mock of the feature), not a stock photo. This both avoids "generic AI" stock imagery and shows what the feature does.
- **Duo cards** — pastel background + a small preview payload (text preview like "4 rooms free 14:00–16:00").
- **Category tiles** — icon + label. No photography. Custom SVG/`lucide-react` icons in colored rounded boxes (40×40, radius 10).
- **No emoji in production** — emojis are placeholder only. All icons resolve to `lucide-react` symbols chosen per category.

### 3.5 Motion

- Category tiles: `transform: translateY(-2px)` on hover, 200ms.
- Ribbons and dots are static.
- No autoplay animations. No skeleton shimmers beyond the default shadcn `Skeleton` component.

---

## 4. Page structure

Top-to-bottom, inside the contained wrapper:

```
┌─────────────────────────────────────────┐
│ A. Header: avatar · greeting · location │  small
├─────────────────────────────────────────┤
│ B. Greeting line (typographic)          │  large
├─────────────────────────────────────────┤
│ C. Unified search (pill bar)            │  medium
├─────────────────────────────────────────┤
│                                         │
│ D. Featured hero (Submit a request)     │  large, 280–320 px tall
│                                         │
├─────────────────────┬───────────────────┤
│ E1. Book a room     │ E2. Order         │  duo, both "Coming soon"
│     (Coming soon)   │    (Coming soon)  │
├─────────────────────┴───────────────────┤
│ F. Quick actions (4 icon chips)         │  compact row
├─────────────────────────────────────────┤
│ G. Your stuff (3 utility cards)         │  compact row
├─────────────────────────────────────────┤
│ H. Browse services (adaptive strip)     │  variable
├─────────────────────────────────────────┤
│ I. Satisfaction prompt (conditional)    │  slim banner · Coming soon
└─────────────────────────────────────────┘
```

### 4.1 A. Header strip

- Left: 36×36 circular avatar (initials fallback), brand kicker line ("Prequest · <formatted date>"), location line (site · building, from `person.primary_space` / `location.name`).
- Right: subtle meta (weather/temperature optional, not MVP).

**Data:**
- `person.display_name`, `person.primary_site_id`, `site.name`, `building.name` — from existing `useAuth().person` and a `/locations/{id}` lookup.
- Weather is **out of scope** for MVP; the slot is reserved visually but renders empty if no provider.

### 4.2 B. Greeting line

- Single typographic line: `Good <morning|afternoon|evening>, <first_name>.`
- The period and the name use muted color (`#a8a29e`); the greeting uses full-strength ink.
- Time-of-day logic based on user's browser local time.

### 4.3 C. Unified search

- Pill-shaped input, full content-width.
- Placeholder: `Search services, people, rooms, or tickets…`
- Trailing `⌘K` keyboard hint.
- Phase 1 behavior: routes to catalog search results — searches service catalog categories and request types client-side (already in `PortalHome` today) plus a new server call for tickets where the current user is requester (`/tickets?requester_person_id=me&q=…`).
- Phase 2 behavior: same slot becomes the conversational AI input (spec §20.2). The containing component must allow the input to be replaced with a chat trigger without layout shift. **No layout change is required in Phase 2.**
- Global cross-entity search (tickets + spaces + people + assets) is on the Phase 1 backlog (`docs/phase-1.md` L138–142); this design reserves the slot for it, and a small follow-up ticket can extend the handler.

### 4.4 D. Featured hero

- Large card (≥280px tall), lavender→pink gradient background, two-column layout on desktop.
- Left column: kicker ("Featured · Submit a request"), headline ("Something broken? Describe it, we'll route it."), sub ("Pick a service…").
- Right column: an **illustrated product preview** — a stylized mock of the submit form (static, non-interactive mini-form with example values).
- Clickable anywhere; navigates to `/portal/submit`.
- The "featured" intent is dynamic (see §4.4.1). For Phase 1, it always surfaces *Submit a request* as the featured action because that's the core flow. For Phase 2+, it can rotate.

#### 4.4.1 Featured rotation (Phase 2+ extension, out of scope for MVP)

Reserved for later: the featured hero can rotate based on (a) user's most-used category, (b) time of day / day of week, or (c) an admin-pinned featured entry. Data model allows this later without redesign; no schema change required for the MVP fixed version.

### 4.5 E. Duo — Book a room · Order

- Two side-by-side cards, 1:1 grid.
- Both carry a top-right "Coming soon" ribbon.
- Card content: kicker, h2 headline, one-line description, a small preview payload at the bottom ("4 rooms free 14:00–16:00 →", "12 items available · avg delivery 30 min →").
- Phase 1 click behavior: clicking routes to the existing placeholder route (`/portal/book`, `/portal/order`); the destination itself is a "Coming in Phase 2" page, also using the ribbon language for consistency.
- Phase 2+ click behavior: routes to the real feature; ribbon is removed.

### 4.6 F. Quick actions

A row of **four icon chips** with Notion-style visual treatment:
- Small colored icon box (30×30, radius 8).
- Two-line label (primary bold, secondary muted).
- Chevron on the right.
- Phase-2+ items carry a tiny "Soon" pill top-right.

Actions (fixed set):
1. **Submit a request** → `/portal/submit` — active.
2. **Book a room** → `/portal/book` — Soon.
3. **Invite a visitor** → `/portal/visitors` — Soon.
4. **Order** → `/portal/order` — Soon.

This is a minor redundancy with the hero and duo; it's deliberate for mobile, where the hero/duo stack vertically and a compact quick-action row becomes the fastest way to jump.

### 4.7 G. Your stuff — three utility cards

All three are white utility cards, same size.

**Card 1 — My requests**
- Label: "My requests"
- Value: `<N> open` with amber/blue/emerald dot based on risk.
- Detail: "<K> at risk · <most-urgent ticket title>" (truncated).
- Source: `GET /tickets?requester_person_id=me&status_category=new&status_category=assigned&status_category=in_progress&status_category=waiting`.
- Click: → `/portal/my-requests`.
- Empty state: "No open requests · <a href>Submit one →</a>".

**Card 2 — Pending approval**
- Label: "Pending approval"
- Value: `<N> waiting`
- Detail: most recent approval summary.
- Source: `GET /approvals?approver_person_id=me&status=pending`. The approvals endpoint exists (per `phase-1.md` L97–103, service-desk approval queue), but the employee-portal `/portal/my-approvals` route is not built.
- Click: → `/portal/my-approvals` — route is out of scope for this ticket; the card acts as a preview/entry point and carries the ribbon until the route ships in a separate ticket.
- Ribbon: "Coming soon" for Phase 1. The card still fetches and displays a real count if the endpoint returns data, so the number is truthful while the destination is unbuilt.

**Card 3 — Assigned to me**
- Label: "Assigned to me"
- Value: stacked list of 2–3 assigned assets, name + short id.
- Source: `GET /assets?assigned_person_id=me&limit=3`. Endpoint exists per `phase-1.md` Asset service = shipped.
- Click: → `/portal/my-assets` (new route, very small — a flat list of my assets; scope minimal).
- Empty state: "No assets currently assigned."

### 4.8 H. Browse services — adaptive catalog strip

Replaces the current uniform 4-col grid.

- Reads `GET /service-catalog/categories` (already used in `home.tsx`).
- **Adaptive layout** based on count `N`:
  - `N ≤ 4`: single row of uniform tiles.
  - `5 ≤ N ≤ 8`: 4-column grid, 1–2 rows.
  - `N > 8`: 4-column grid with "View all" overflow link to `/portal/catalog`.
- Tile structure: pastel background, icon box (40×40 with category-accent color), category name (15px / 700), request-type count ("8 request types").
- Click: → `/portal/catalog/:categoryId` (existing route).
- Category palette: derived from the category's `icon` field via a fixed `iconToPalette` map (client-side). Admin-editable palette is a Phase 2 enhancement.

### 4.9 I. Satisfaction prompt

- Slim banner at the bottom of the page.
- Appears **only** when the current user has at least one ticket resolved in the last 7 days with `satisfaction_rating IS NULL`.
- Current Phase 1 behavior: the satisfaction feature itself is Phase 3 (per `docs/phase-3.md` L111). The banner renders with a "Coming soon" ribbon; the stars are non-interactive.
- Content: `How did we do on <ticket_ref · ticket_title>?` with 5 placeholder stars.
- Source: `GET /tickets?requester_person_id=me&status_category=resolved&resolved_since=7d&has_rating=false&limit=1`. If the `has_rating=false` filter is not supported at implementation time, the implementation plan must add it as a small service-side enhancement — this banner depends on it. If it cannot be added in the same ticket, the banner is **hidden** rather than faked with mock data.

---

## 5. Responsive behavior

Target breakpoints:
- **Mobile** (< 640px): single-column stack; all grids collapse to 1 column.
  - Section order is preserved.
  - Duo cards stack vertically.
  - Quick actions: 2 columns.
  - Your-stuff cards: 1 column.
  - Catalog tiles: 2 columns.
- **Tablet** (640–1024px): 2-column layouts where the desktop layout has 3–4 columns. Hero keeps its two-column inner structure.
- **Desktop** (≥ 1024px): full layout as described, constrained to `max-width: 1120px`.
- Above 1120px the page centers with gutters; the content never reflows wider.

---

## 6. Loading, empty, and error states

Each section is independently loadable.

- **Hero, duo, quick actions**: static — always render.
- **Your stuff**: each card skeleton-replaces its value line while fetching. Errors render a quiet inline "Couldn't load — retry" link; they do not block other cards.
- **Catalog strip**: skeleton tiles while fetching. If fetch fails, show a fallback "Couldn't load services" tile with retry.
- **Satisfaction banner**: renders only when its query returns at least one ticket; silent otherwise.

Loading orchestration is per-card, not page-global. Users should see the chrome and featured hero instantly.

---

## 7. Component inventory

Per `CLAUDE.md` frontend rule — *make components reusable/generic by default* — each block below is extracted as a prop-driven component in `apps/web/src/components/portal/`:

| Component | Props | Notes |
|---|---|---|
| `PortalHeaderBar` | `person`, `location`, `dateString` | avatar + kicker + location |
| `PortalGreeting` | `firstName`, `now` | computes time-of-day greeting |
| `PortalSearchBar` | `placeholder`, `onSearch` | pill input; Phase 2 swaps implementation, not component |
| `FeaturedHero` | `kicker`, `title`, `sub`, `illustration`, `to`, `gradient` | generic featured-card primitive |
| `DuoCard` | `kicker`, `title`, `description`, `preview`, `to`, `comingSoon`, `gradient` | one of the two duo cells |
| `QuickActionChip` | `icon`, `label`, `subLabel`, `to`, `comingSoon`, `iconColor` | the Notion-style chip |
| `UtilityStatCard` | `label`, `value`, `detail`, `statusColor`, `to`, `empty` | the "Your stuff" tile |
| `CatalogTile` | `name`, `icon`, `typesCount`, `palette`, `to` | pastel category cell |
| `CatalogStrip` | `categories` | does adaptive-count layout |
| `SatisfactionBanner` | `ticket`, `comingSoon` | conditional slim banner |
| `PhaseRibbon` | `label = 'Coming soon'` | shared corner pill |

All reusable across the portal (catalog detail page can reuse `CatalogTile`, etc.).

### 7.1 shadcn usage

Per `CLAUDE.md`, check shadcn first. Expected shadcn primitives: `Card` (base for utility + duo cards), `Input` (search bar), `Badge` (ribbons via custom styling, or a new `Ribbon` wrapper around `Badge`), `Skeleton` (loading states), `Avatar`, `Button`. No new shadcn installs expected; the custom styling lives in the portal components.

### 7.2 Data hooks

Use the existing `useApi` hook (`apps/web/src/hooks/use-api.ts`). No React Query introduction as part of this change — that's a separate architectural decision.

---

## 8. Accessibility

- All cards are keyboard-focusable when clickable (`role="button"` or `<a>`).
- Color is never the only status signal — status dots are paired with a text label ("2 open", "at risk", "1 waiting").
- Contrast ratios: all text on pastel backgrounds meets WCAG AA (verified at implementation time; pastel palette chosen for AA compliance with `#1f1f1f` and `#52525b` text).
- Ribbons ("Coming soon") are announced via `aria-label="feature coming soon"`.
- Search bar has a visible label via placeholder plus an `aria-label="Search"`.
- Greeting is purely decorative — no screen-reader gate.

---

## 9. Non-goals

- No change to `/portal/my-requests`, `/portal/submit`, `/portal/catalog/:categoryId` — those keep their existing designs (can be restyled in a follow-up, but not in this ticket).
- No change to admin or service-desk surfaces. The Linear-style aesthetic in `CLAUDE.md` remains authoritative there.
- No real AI integration. Search is literal search. (Phase 2 change, separate ticket.)
- No global cross-entity search implementation. The search slot is reserved; extending the handler to search tickets + people + spaces + assets is a separate Phase 1 backlog ticket.
- No role-based variation (manager view, field-technician view). Single employee view ships first; role-gating is a later enhancement once the base design is accepted.
- No tenant-admin palette override for catalog categories in this ticket. Pulled palette from icon-name map.
- No weather/temperature data source.
- No announcements row. The spec doesn't define an announcements entity; adding one is its own project.

---

## 10. Phase 1 honesty — what ships vs. "Coming soon"

| Section | Phase 1 status | Ribbon? |
|---|---|---|
| Header / greeting / search bar | Ships real | no |
| Featured hero — Submit a request | Ships real, links to existing submit flow | no |
| Duo — Book a room | Placeholder route, ribbon on tile | **Coming soon** |
| Duo — Order | Placeholder route, ribbon on tile | **Coming soon** |
| Quick actions — Submit | Ships real | no |
| Quick actions — Book / Visitor / Order | Placeholder route | **Soon** pill |
| Your stuff — My requests | Ships real (tickets endpoint exists) | no |
| Your stuff — Pending approval | Portal-side route is new/unbuilt; endpoint exists | **Coming soon** until route ships |
| Your stuff — Assigned to me | Ships real (assets endpoint exists) | no |
| Browse services | Ships real | no |
| Satisfaction prompt | Feature is Phase 3 | **Coming soon** until Phase 3 |

---

## 11. Open questions (non-blocking)

These are deliberate deferrals; they do not block implementation:

- **Per-category palette editing** — tenant admins may want to override category colors. Phase 2 admin work.
- **Featured-hero rotation logic** — today it's fixed to "Submit a request." Future iteration can rotate based on usage, time of day, or admin pin.
- **Dark mode mirror** — out of scope; if requested later, the palette tokens in the components support a theme swap without structural change.
- **Global search scope** — the Phase 1 backlog item "Unified search bar" (tickets + spaces + people + assets) is a separate ticket; this design reserves the slot.

---

## 12. Implementation sequence (high-level)

Detailed sequencing is produced by the writing-plans step next. This spec's implication:

1. Extract the reusable component primitives listed in §7 (new files in `apps/web/src/components/portal/`).
2. Rewrite `apps/web/src/pages/portal/home.tsx` to compose them.
3. Add the small utility endpoints the page assumes (e.g., `has_rating=false` filter on tickets) — or degrade gracefully if they don't land in the same ticket.
4. Add placeholder "Coming soon" destination pages for Book / Order if they don't already exist (some routes may 404 today).
5. Verify mobile behavior on a physical breakpoint at 375px.

No backend schema changes are introduced. No new tables. All referenced endpoints exist (Phase 1 backend is complete per build-strategy.md).
