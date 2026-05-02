# Create-booking modal redesign — design

**Date:** 2026-05-02
**Status:** Approved (brainstorm — design lock)
**Owner:** Frontend (deep) + small backend signals
**Replaces:** the current `BookingComposer` shell only — the underlying data flow / persistence / bundle logic stays. This is a UX/polish/structure rework, not a backend rework.

## Problem

The current `BookingComposer` (used by the desk scheduler tile-click, the desk-bookings "+ New" button, and the portal "Book a room" entry) is a single-pane, vertically stacked form that the founder describes as "basic and plain". Two concrete failures, beyond aesthetics:

1. **Service attachment is silently missed.** The current modal forces users into the same surface whether they're booking a 30-second routine stand-up or a 5-minute event with catering + AV + visitors. Catering attachment to room bookings is the #1 cited pain in `docs/users.md` ("today's Outlook bookings cause double-bookings + bad UX") — and the current composer doesn't help. There's no contextual prompt, no surfacing of available services for the picked room/time.
2. **Speed regression for proxy-booking operators.** Front-desk operators do ~100 proxy bookings/day. The current single-pane composer has the same friction for "30s routine recurring stand-up" and "5min full-detail event setup". Every extra click is paid 100× per shift.

## Goals

1. Two-tier creation surface: a **quick-book popover** for the 30s case + a **full two-pane composer** for the 5min case, with explicit "Advanced ↗" escalation between them.
2. Two-pane composer that feels Robin / Linear / Notion-Calendar premium, not generic enterprise.
3. **Contextual surfacing of add-ins** — when the picked room has linked catering or the time spans a meal window, the catering add-in card auto-highlights with a "Suggested" chip. Same for AV when the room has AV equipment configured.
4. Title fallback that doesn't pollute calendars (no bare "Maple Room" titles on 40 recurring stand-ups).
5. Premium polish baked into existing design tokens (Geist, easing tokens, hairlines, 4px grid, Field primitives).
6. Mobile behavior that doesn't break — quick-book popover stays usable on phones; full composer collapses pane to bottom sheet.

## Non-goals

- Backend persistence changes. Same `POST /reservations`, same bundle flow, same visitor-create flow.
- Visitor smart-recognition (typing a name → detect known visitor/employee/new contact). Captured as **v2 — separate slice** below; v1 ships with the simple name+email inline row.
- Portal-side full redesign. The portal already has a tailored "Book a room" surface; this redesign focuses on the operator-facing surfaces (desk scheduler, /desk/bookings, /desk/visitors). Portal can adopt the same composer shell in a follow-up.
- The visitors-on-booking-detail "Add visitor" dialog (parked spec from earlier today) — that surface inherits the polish from this redesign in a follow-up; we don't redesign it now.

## Architecture

### Two surfaces, one mental model

| Surface | Trigger | Purpose |
|---|---|---|
| **`<QuickBookPopover>`** | Desk scheduler tile click (drag-to-create or click empty slot) | 30-second path: just title + time confirmation. ~360px wide popover, anchored to the clicked tile. |
| **`<BookingComposerModal>`** (the redesign) | "+ New booking" on `/desk/bookings`, "Advanced ↗" link in the quick popover, portal "Book a room" entry, "Book on behalf" from a person/visitor surface | 5-minute path: full two-pane modal with all add-ins. |

The quick popover is the default for tile-clicks (operators do this 100×/day). The full modal is for intentional, detailed booking. They share state — opening Advanced from the popover passes the in-progress draft over so nothing is lost.

### Quick-book popover (`<QuickBookPopover>`)

Anchored popover, ~360×220px. Two fields:

1. **Title** — placeholder updates live to `"{Host first name}'s {Room name} booking"` once room is known (which it usually is, since the popover knows the tile context). Empty title → submit uses the placeholder string.
2. **Duration chips** — `30m | 1h | 2h | Custom…`. Pre-selected based on room defaults if known.

Footer:
- Primary: `Book` (the only saturated element).
- Secondary muted link: `Advanced ↗` (passes draft to `<BookingComposerModal>`).

Contextual hint (when applicable, single muted line above the footer):
- If the picked time spans a meal window: `"Need catering? Open full composer →"` linking to Advanced.
- If the room is in a "needs visitor pre-registration" wing: `"Visitors? Open full composer →"`.

Keyboard: `↵` books, `⌘↵` opens Advanced, `Esc` dismisses.

### Full composer modal (`<BookingComposerModal>`)

**Modal size:** **880×680, max-h-[85vh]**, centered. Single surface (no two-tone bg fill); the right pane is **inset** with `m-2 rounded-md border border/60` so it reads as "panel within a panel" — Notion's pattern, not the duct-taped sidebar look.

**Pane ratio:** **left 520px / right 360px** (≈59/41). The right pane needs less width than instinct says because its content is icon-led cards.

#### Left pane — booking form (520px)

Order top-to-bottom, all built with shadcn `Field` primitives (mandatory, per CLAUDE.md):

1. **Title** — `Input`, large weight (`font-medium text-base`). Placeholder updates live to `"{Host first name}'s {Room name} booking"` once both are known. The placeholder is what becomes the title on submit if blank — what-you-see-is-what-you-get. No mid-keystroke morphing.
2. **From / To** — two adjacent button-styled controls reading `Wed, May 7 · 2:00 PM`. Click → popover with calendar (left) + 15-min time slot list (right). Slots in `font-mono` (Geist Mono, already loaded). Conflicts shown with `text-destructive/70` + hairline strike. Smart-parse ("tomorrow 2pm", "+1h" from start) is **Tier 2 polish**, not v1.
3. **Repeat** — collapsed by default. Single muted row: `"Doesn't repeat ▾"`. Click → popover (Google Calendar pattern). When set, row reads `"Weekly on Wednesdays, until Jun 30"` in `text-foreground` instead of muted. Inline-expand was considered but popover is the right pattern; founder approved.
4. **Description** — `Textarea`, 2–3 visible rows, `resize-none` with `auto-grow` cap at ~6 rows.
5. **Host** — picker, defaults to current user (or proxy-target if launched via "Book on behalf"). Avatar + name pill display, click to change.
6. **Visitors** — inline list with quick-add row at the bottom. v1 spec is two-column quick-add (name + email) producing a chip; details below.

The left pane stays **fully editable** at all times — even when the user is interacting with the right-pane add-ins. No freezing, no modal-within-modal.

#### Right pane — add-in surface (360px, inset)

Stack of cards, hairline-separated, ~64px tall when collapsed. Each card has:
- Icon (40% opacity when empty, 100% when filled)
- Single-line label and an empty-state action prompt:
  - Catering: `"Add catering"` / `+ Add` ghost button
  - AV equipment: `"Add AV equipment"` / `+ Add`
  - Rooms (when modal entered without a room): `"Pick a room"` / `+ Pick`

**Cards expand inline** when clicked — siblings collapse to one-line summaries. **No "swap pane + back button" pattern** (both design lenses rejected it). Expand transition: `grid-template-rows: 0fr → 1fr` over 240ms `var(--ease-smooth)`.

**Filled cards** earn a hair more contrast: `border-foreground/10` instead of `border-foreground/5`. Subtle visual reward loop.

**Contextual surfacing (the discoverability fix):**
- When picked time spans a meal window (tenant-configurable, default 11:30–13:30 lunch + 17:00–19:00 dinner) → catering card shows a `"Suggested"` chip in the top-right corner, `bg-foreground/5 text-foreground/70 text-[11px]` rounded-full. Hover tooltip explains why ("Booking spans lunch — many teams add catering here").
- When the picked room has a linked catering vendor in routing → catering card shows the same `"Suggested"` chip (different reason text).
- When the picked room has AV equipment configured AND duration > 30min → AV card shows the chip.
- When the picked room is in a "needs visitor pre-registration" wing AND no visitors are added in the left pane → small inline hint at the bottom of the visitors section: `"Visitors typically pre-registered for this room"`.

The "Suggested" chip is the single piece of intelligence that makes the right pane feel non-checklist. Without it, the UX critique's "discoverability cliff" concern is real — implement this chip in v1, it's not deferable.

### Pane-swap interaction (deliberately removed)

Earlier proposal: clicking an add-in swaps the right pane to the add-in's flow with a back arrow. **Removed.** Both design lenses rejected it: it transfers the failure from "tool didn't offer" to "user didn't notice", and it's hostile to keyboard operators who'd mouse-hunt the back button each time.

Replaced with **inline-expand cards** — see right pane above.

## Visitor inline quick-add row (v1 + v2)

### v1 — simple

Inside the Visitors section on the left pane:
- Existing visitors render as chips (name + small status dot, click → `/desk/visitors/:id`).
- Quick-add row at the bottom: two `Field`s side-by-side — name + email. Tab/Enter on email row → posts to `useCreateInvitation()` with current `reservation_id` (when editing) or queues for the post-POST flush (when in composer).
- Default host is the booking host (the `requester_person_id` decision from the parked spec).

### v2 — smart entity recognition (separate slice)

User types in a single input. Debounced search hits:
1. **Tenant persons (employees)** — surface with avatar + role; selecting promotes to attendee, NOT visitor.
2. **Known visitors** — recent visitor records by name/email match; surface with last-visit date.
3. **Email pattern detection** — when the typed string matches an email and the domain is recognized (tenant config or seen-before) → suggest `"External visitor from {Company}"`.
4. **Add as new** — fallback when no match.

Selected entity becomes a chip with type icon (employee vs visitor). Marketed as "type a name or email — we'll figure out who it is".

**v2 is a separate slice; v1 ships with the simple two-field row.** The architecture must keep v2 open: the row's behavior is owned by a `<VisitorOrAttendeePicker>` component that v1 implements as two static fields and v2 swaps for the smart input.

## Polish micros (mandatory, not aspirational)

These are non-negotiable for the redesign — both design lenses called them out and they match existing CLAUDE.md polish rules:

- **Type ramp** lives in 13–15px. No 18px section headers. Hierarchy via weight (500 vs 400) and color (`foreground` vs `muted-foreground`). Title input is the one exception — `text-base` (16px) `font-medium`.
- **Corner radius rhythm:** outer modal 12px, inner cards 8px, inputs 6px. Each level loses 2–4px.
- **Hover affordances** are background-only: `hover:bg-accent/50` over 100ms. No border color shifts, no shadow puffs.
- **4px vertical grid** (not 8px). Field gap 12px, row gap 8px, header→body 16px. The denser grid is what makes Linear/Robin feel "designed".
- **Submit button is the only saturated element in the modal.** Everything else is grayscale.
- **Modal open animation:** `var(--ease-spring)`, 380ms, scale 0.96→1 (NOT from 0). Backdrop fades over 240ms `var(--ease-smooth)` — slower than the modal so the modal arrives first. Both critiques flagged this as the single biggest "feels Robin" detail.
- **Easing tokens only.** `var(--ease-smooth)` for pane expand. `var(--ease-snap)` for the back-chevron (if reintroduced) and hover states. `var(--ease-spring)` for modal open. Never hand-roll a `cubic-bezier(...)` in a TSX file.
- **Tabular numerals** on the time fields, the duration chips, the recurrence row, and any counter (e.g. "3 services"). Add `tabular-nums` class — it's already wired globally for `<time>` and `[data-tabular-nums]` but we should be explicit on the time controls.
- **Forms must use Field primitives.** `FieldGroup` wraps the form body. Each label+control is a `Field` with `FieldLabel htmlFor`. No hand-rolled `<div className="grid gap-1.5">` — that's the exact pattern CLAUDE.md exists to kill.
- **Hairlines over shadows.** The modal already has its overlay shadow from the shadcn `Dialog`. Inside, every separator is `border-border/60`. No `shadow-sm` on the right pane, no `ring-1` on cards beyond the rare focus state.
- **Active press = `translate-y-px`**, never `scale`. Already the Button baseline.

## Mobile behavior

Mobile is a first-class consideration — `docs/users.md` says many requesters book from phones.

- **Quick-book popover** on mobile: bottom sheet (full-width), same two-field UX. No Advanced link on mobile (the full composer doesn't fit).
- **Full composer modal** on mobile (≤640px): right pane collapses BELOW the form as a stacked accordion of add-in cards. Same inline-expand behavior. Modal goes full-screen with `max-h-screen`. The contextual "Suggested" chips still show — that's the discoverability fix and matters even more on mobile.

## Permissions / context

- The quick-book popover and full composer share the same backend permissions as today. No new perms.
- Proxy-booking ("Book on behalf") is operator-only — gated by existing `bookings:create_for_others` (or whatever the existing perm is called; verify at implementation time).
- Add-in cards individually check their own perms — e.g. catering card hidden if the operator can't create service requests on this tenant.

## State + persistence

- The full composer is a controlled React state tree with a single `BookingDraft` root object (room, time, repeat, attendees, visitors, services, AV).
- Quick-book popover holds a smaller subset (room, time, title) and `Advanced ↗` constructs a `BookingDraft` from it before opening the full composer — nothing is lost in escalation.
- No local-storage drafts in v1. Cancelled drafts are dropped. (v2 could persist drafts per-user; not needed now.)

## Files touched

**New:**
- `apps/web/src/components/booking-composer/quick-book-popover.tsx` — the 360×220 popover
- `apps/web/src/components/booking-composer/booking-composer-modal.tsx` — the new two-pane shell (rename from `booking-composer.tsx` if structure permits, otherwise sit alongside)
- `apps/web/src/components/booking-composer/left-pane/` — folder with one file per left-pane block (title-input, time-row, repeat-row, description, host-picker, visitors-section)
- `apps/web/src/components/booking-composer/right-pane/` — folder with `addin-stack.tsx`, `addin-card.tsx`, `catering-card.tsx`, `av-card.tsx`, `room-card.tsx`
- `apps/web/src/components/booking-composer/contextual-suggestions.ts` — pure function `getSuggestions({ room, startAt, endAt, attendees }) → string[]`
- `apps/web/src/components/booking-composer/booking-draft.ts` — type + helpers for the shared draft state

**Modified:**
- `apps/web/src/components/desk/scheduler/*` — wire tile-click to open `<QuickBookPopover>` instead of `<BookingComposer>`
- `apps/web/src/pages/desk/bookings.tsx` — wire "+ New" button to open `<BookingComposerModal>`
- `apps/web/src/pages/portal/book-room.tsx` (or wherever portal entry lives) — wire to `<BookingComposerModal>`
- The current `booking-composer.tsx` — likely deleted or reduced to a thin re-export shim during migration; the goal is a clean replacement, not parallel maintenance

**Backend (small):**
- Tenant config table needs `meal_windows` columns OR a new `tenant_meal_windows` table (start_time, end_time, label). v1 default: lunch 11:30–13:30 + dinner 17:00–19:00. Used by `getSuggestions`. (One small migration, name TBD at implementation time.)
- Endpoint to fetch suggested add-ins for a draft: `POST /bookings/draft-suggestions` accepting `{ room_id, start_at, end_at }` returning `{ catering_suggested: bool, catering_reason: string, av_suggested: bool, av_reason: string, visitors_likely: bool }`. The frontend can call this on draft change with light debounce. Alternative: compute entirely client-side from already-loaded room + meal-window config — preferred for v1, no new endpoint needed.

**Docs:**
- This file
- Update `apps/web/src/components/booking-composer/README.md` if one exists, otherwise create one summarizing the new shape
- The visitors-on-booking-detail spec (`docs/superpowers/specs/2026-05-02-visitors-on-booking-detail-design.md`) needs a one-line note that its `<AddVisitorToBookingDialog>` will inherit this redesign's polish in a follow-up

**No data-model migrations.** Reservation/visitor schema unchanged.

## Testing

- **RTL** mounting `<BookingComposerModal>` with a known room → asserts the title placeholder reads `"{Host first name}'s {Room name} booking"`.
- **RTL** with a meal-window-spanning time → asserts the catering card shows the `"Suggested"` chip.
- **RTL** for the inline-expand: clicking a card expands it, siblings collapse to summary.
- **RTL** for the quick-popover → Advanced escalation: drafts in the popover propagate to the full modal.
- **Visual regression** snapshots (or Storybook) for: collapsed/expanded card states, populated/empty pane, mobile bottom-sheet variant.
- **Smoke gate (`pnpm smoke:work-orders`)** is unaffected — no work-order code changed.

## Open questions

None at this point — design is locked. Implementation may surface small choices (exact meal-window default values, exact pane ratio at narrower viewports, AV equipment signal source); resolve inline at implementation time and update this doc if the answer is non-trivial.
