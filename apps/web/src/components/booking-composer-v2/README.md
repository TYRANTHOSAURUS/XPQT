# booking-composer-v2

Redesigned create-booking surface. Replaces the single-pane
`booking-composer/booking-composer.tsx` (deleted in Task 6.7) with a
two-tier flow:

- `<QuickBookPopover>` — anchored popover for scheduler tile-clicks
  (~360×220, title + duration chips + Advanced ↗). Books directly via
  `useCreateBooking()` on Enter / Book click.
- `<BookingComposerModal>` — full two-pane modal (880×680, max-h
  `min(85vh, 680px)`, spring-open + slow-fade backdrop). Left pane =
  title / time / repeat / description / host / visitors. Right pane =
  `<RightPanel>` view-state machine: a default `<SummaryView>` (times +
  room + catering + AV summary cards) slides over to a per-domain picker
  (room picker / catering catalog / AV catalog) and back. `Suggested`
  chips on the catering + AV summary cards are driven by
  `getSuggestions`.

Spec: [`docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md`](../../../../../docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md).
Plan: [`docs/superpowers/plans/2026-05-02-create-booking-modal-redesign.md`](../../../../../docs/superpowers/plans/2026-05-02-create-booking-modal-redesign.md).

## Files

- `booking-draft.ts` — single root state shape + validation (`validateDraft`)
  + default-title helper (`defaultTitle`). Replaces the legacy `ComposerState`.
- `use-booking-draft.ts` — state container hook with stable-identity setters.
- `contextual-suggestions.ts` — pure `getSuggestions(draft, room, mealWindows)`.
  Wires the `Suggested` chip on the right-pane cards. No network, no React.
- `derive-building-id.ts` — Space-tree walker; finds the enclosing building
  (or fallback site) for a room. Used by the visitors flush + visitors-row
  defaults so visitor invitations carry a `building_id` anchor.
- `quick-book-popover.tsx` — the 30s create surface. Mobile renders as a
  bottom Sheet via `useIsMobile`.
- `booking-composer-modal.tsx` — the full two-pane modal. Owns the submit
  pipeline (`useCreateBooking` + visitors flush + footer toast/onBooked).
- `left-pane/` — `title-input`, `time-row` (calendar + 15-min slots),
  `repeat-row` (popover wrapping legacy `RecurrenceField`), `description-row`,
  `host-row` (with operator-mode "Booking for"), `visitors-row` (delegates
  to legacy `VisitorsSection`).
- `right-pane/` — `right-panel` (the summary↔picker view-state machine,
  slide animation), `summary-view` (vertical stack of summary cards),
  `summary-card` (shared empty/filled primitive with `Suggested` chip),
  `times-summary-card`, `room-summary-card`, `catering-summary-card`,
  `av-summary-card`.

## Right-pane state machine

```
view = 'summary' | 'picker:room' | 'picker:catering' | 'picker:av'
```

`summary` shows the four summary cards stacked. Tapping a card's CTA or
Change button transitions to the matching `picker:*` view, which fills
the entire right pane and renders the picker body inline (no nested
modals). The picker's [← Back] returns to `summary`. Transitions slide
horizontally via `transition-transform 200ms var(--ease-smooth)`. Legacy
`AddinStack` / `AddinCard` / per-domain `*Card` (single-expand grid-row
trick) was removed in this pivot — never reintroduce; use `SummaryView` +
the picker views instead.

`TimeRow` shipped two presentations: the inline-visible dropdown quartet
`[date▾] [time▾] → [date▾] [time▾]` (Robin pattern, default), and the
combined calendar+slot popover (kept as the Advanced path).

## Reuses from the old composer (still alive)

- `service-picker-sheet.tsx` — `ServicePickerBody` is the catalog browser
  embedded directly inside the right pane's `picker:catering` and
  `picker:av` slots.
- `sections/recurrence-field.tsx` — used inside `RepeatRow`.
- `sections/room-picker-inline.tsx` — used inside the right pane's
  `picker:room` slot.
- `sections/visitors-section.tsx` — wrapped (with chip presentation
  skipped per VisitorsSection's existing list rendering) by `VisitorsRow`.
- `state.ts` — `PendingVisitor`, `ComposerMode`, `ComposerEntrySource` type
  aliases. (Migrating these into v2 is a separate refactor.)
- `submit.ts` — `buildBookingPayload` is shared between the popover + the
  modal. Both pass `title` directly on the payload (`BookingPayload` was
  extended to accept `title` + `description` in Task 6.1).
- `helpers.ts` — date / time math.

## Tests

`pnpm --filter @prequest/web test` runs the vitest suite. Pure functions
(`booking-draft`, `contextual-suggestions`, `use-booking-draft`,
`derive-building-id`) have unit tests; components (`quick-book-popover`,
`right-panel`, `summary-card` + per-domain summary cards, `visitors-row`,
`booking-composer-modal` shell) have RTL tests.

## Entry points

- `/desk/scheduler` — drag-create on a tile opens `<QuickBookPopover>`. Book
  posts directly. Advanced ↗ escalates to `<BookingComposerModal>`. The
  room-inspector "Book" button also opens `<BookingComposerModal>` with
  the room pre-seeded.
- `/desk/bookings` — "+ New booking" opens `<BookingComposerModal>` in
  operator mode.
- `/portal/book-room` — picking a room opens `<BookingComposerModal>` in
  self mode, pre-seeded with the search context (time, attendees,
  template defaults).
