# Right-pane summary pivot — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`. User authorized autonomous execution + pushing to main as work lands. Standing DB push permission for the booking-modal-redesign workstream is in user memory; this plan is pure UI so no migrations are expected.

**Date:** 2026-05-04
**Status:** Approved (`/design-review` finding + user-driven pivot to "Option A")
**Owner:** Frontend
**Predecessor:** `docs/superpowers/plans/2026-05-02-create-booking-modal-redesign.md` (32 tasks shipped 2026-05-03 to main; right-pane Phase 5 is being replaced — left pane / submit / popover all stay).
**Spec it serves:** `docs/superpowers/specs/2026-05-02-create-booking-modal-redesign.md` (Implementation status §"2026-05-03" lists Phase 5 as shipped; this plan supersedes that with the architecture below).

## Why this exists

The 32-task autonomous run shipped a working `<BookingComposerModal>` but the right pane reads as "three collapsed cards forming a checklist of work" rather than "a panel of meaningful state." `/design-review` (4 phases — UX persona, composition, motion, React quality, web-interface-guidelines) confirmed the visual problem is architectural, not cosmetic. User compared to Robin and concluded:

> "right pane is not only a summary panel — when clicking 'Add service' in empty state, it opens the add service flow we already have inside that entire panel. When done it goes back to the summary."

That's a stack-navigator pattern: panel has two views, **summary** (default) and **picker:&lt;thing&gt;** (full-panel, with back). Cleaner than Robin's modal-on-modal pattern. Replaces the current `<AddinStack>` + `<AddinCard>` collapsed/expanded model.

## Architecture

```
<RightPanel>
  view: 'summary' | 'picker:room' | 'picker:catering' | 'picker:av'

  // Default
  view='summary' →
    <SummaryView>
      <PanelHeaderCopy>
        "We'll update suggestions as you build the booking."
      </PanelHeaderCopy>
      <TimesSummaryCard       /* derived from draft.startAt/endAt */ />
      <RoomSummaryCard        /* derived from draft.spaceId + spacesCache */ />
      <CateringSummaryCard    /* derived from draft.services filter('catering') */ />
      <AvSummaryCard          /* derived from draft.services filter('av_equipment') */ />
    </SummaryView>

  // On Card.CTA / Change click
  view='picker:room' →
    <PickerView title="Pick a room" onBack={() => setView('summary')}>
      <RoomPickerInline /* legacy, reused */ />
    </PickerView>

  view='picker:catering' →
    <PickerView title="Add catering" onBack={...}>
      <ServicePickerBody initialServiceType="catering" /* legacy, reused */ />
    </PickerView>
  // ...etc
```

**Slide animation between views**: `transition-transform 200ms var(--ease-smooth)` with `translate-x` — the panel slides as one unit. No layout thrash.

**Card behavior:** each summary card has two states.

- **Empty:** CTA-style. Icon + emptyPrompt + secondary action (e.g. "Pick a room", "Add catering"). Click opens picker view.
- **Filled:** Robin-style. Icon + chosen-name + meta (capacity/cost/count) + `[Change]` `[Remove]`. Click body or [Change] opens picker view; [Remove] clears the field on the draft.

**Suggested chip preserved** on the empty-state CTAs only. When the gated-`false` backend signals come online, the chip lights up on the empty card without any UI change.

## Files

### Drop (replaced)
- `apps/web/src/components/booking-composer-v2/right-pane/addin-stack.tsx`
- `apps/web/src/components/booking-composer-v2/right-pane/addin-card.tsx`
- `apps/web/src/components/booking-composer-v2/right-pane/addin-card.test.tsx`
- The current bodies of `room-card.tsx`, `catering-card.tsx`, `av-card.tsx` are rewritten (filenames preserved; replacing `AddinCard` wrapping with new summary-card shape)

### Create
- `apps/web/src/components/booking-composer-v2/right-pane/right-panel.tsx` — view-state machine + slide animation
- `apps/web/src/components/booking-composer-v2/right-pane/summary-view.tsx` — default-view container with header copy + 4 summary cards
- `apps/web/src/components/booking-composer-v2/right-pane/picker-view.tsx` — wrapper with [← Back] header + body slot
- `apps/web/src/components/booking-composer-v2/right-pane/summary-card.tsx` — shared primitive: icon + title + (filled body | empty CTA) + Change/Remove actions
- `apps/web/src/components/booking-composer-v2/right-pane/times-summary-card.tsx` — derives "Wed, May 7 · 10:00 AM – 11:00 AM" + Change opens picker:time (or no-op if time is editable in the left-pane TimeRow inline — see §Time fields below)
- `apps/web/src/components/booking-composer-v2/right-pane/right-panel.test.tsx` — RTL: summary→picker→summary navigation + animation

### Modify
- `apps/web/src/components/booking-composer-v2/booking-composer-modal.tsx` — replace `<AddinStack>`+3-card block in the right pane with `<RightPanel>`
- Existing left-pane components stay
- The `m-2 border border-border/60 rounded-md` floating-card treatment on the `<aside>` is replaced with `border-l border-border/60` (matches `table-inspector-layout.tsx:148` pattern from the codebase) — addresses /design-review finding #3
- `apps/web/src/components/booking-composer-v2/left-pane/time-row.tsx` — convert to inline-visible dropdown trio (date · time · date · time) per Robin pattern. Calendar+slot popover stays as the "advanced" path on the From-side button.

## Tasks

### Phase A — Panel state machine + summary shell (2 tasks)

**Task A.1 — RightPanel + view-state**
- Files: `right-panel.tsx`, `right-panel.test.tsx`
- TDD test: render in summary view → click Room CTA → view = 'picker:room' → click Back → view = 'summary'
- Implementation: `useState<'summary' | 'picker:room' | 'picker:catering' | 'picker:av'>`; render either `<SummaryView>` or `<PickerView>` per state; slide animation via translate-x on a `flex` container with two children, only one shown at a time but the wrapper has `overflow-hidden` and `transition-transform`
- Don't wire content yet (children come in A.2 + B.x)
- Commit: `feat(web): RightPanel with summary↔picker view state machine`

**Task A.2 — SummaryView + PanelHeaderCopy + SummaryCard primitive**
- Files: `summary-view.tsx`, `summary-card.tsx`
- `<SummaryCard>` accepts: `icon`, `title`, `emptyPrompt`, `filled` (boolean), `summary` (filled body), `onChange`, `onRemove`, `suggested`, `suggestionReason`
- Empty state: icon + title + emptyPrompt + (if suggested) chip
- Filled state: icon + title + summary content + Change + Remove buttons
- `<SummaryView>` renders: header copy + four placeholder `<SummaryCard>` slots (still empty until B.x wires real data)
- Commit: `feat(web): SummaryView with shared SummaryCard primitive`

### Phase B — Times / Room / Catering / AV summary cards (4 tasks)

Each task: build the per-domain summary card with both states, wire to draft, slot into SummaryView, hand off to PickerView when CTA / Change clicked.

**B.1** — `RoomSummaryCard`. Filled: name · capacity · "Available" badge (when available) · `[Change] [Remove]`. Empty: "Pick a room" CTA. Picker: wraps `RoomPickerInline`. Commit. (~4h.)

**B.2** — `TimesSummaryCard`. Filled: "Wed, May 7 · 10:00 AM – 11:00 AM" (one or two lines per Robin). For v1 the [Change] action focuses the inline TimeRow on the left pane (no picker:time view yet). When inline editing is good enough, no picker view needed. Commit. (~3h.)

**B.3** — `CateringSummaryCard`. Filled: "3 items · €240" with optional one-line breakdown of top items (Robin shows e.g. "Lauren McWalters cannot attend" — for catering it'd be "Lunch sandwiches × 12"). Empty: "Add catering" CTA + Suggested chip when meal-window signal fires. Picker: wraps `ServicePickerBody initialServiceType="catering"`. Commit. (~4h.)

**B.4** — `AvSummaryCard`. Same shape as B.3, scoped to `service_type === 'av_equipment'`. Picker: ServicePickerBody filtered. Commit. (~3h.)

### Phase C — Modal integration (2 tasks)

**C.1** — Replace `<AddinStack>` block in modal with `<RightPanel>`. Drop the legacy AddinStack/AddinCard files. Drop the `m-2 border rounded-md` on `<aside>` and apply `border-l border-border/60` instead. Inline the `<aside>` width adjustment so the panel fills the right side cleanly. Commit. (~2h.)

**C.2** — TimeRow conversion to inline dropdowns visible at once (Robin pattern). Date dropdown · Time dropdown · "→" · Date dropdown · Time dropdown · timezone label. Click date dropdown → small calendar popover; click time dropdown → 15-min slot popover. The full date+slot composite popover from the existing implementation stays as the "Advanced" path triggered by an icon next to the From-side. Commit. (~6h — this is the longest task.)

### Phase D — Design-review must-fixes (1 batched task)

**D.1** — Apply the design-review findings that aren't covered by Phases A–C:
- `booking-draft.ts` — `emptyDraft()` defaults: `startAt = next 15-min slot`, `endAt = startAt + 1h`
- Wrap left-pane fields in `<FieldGroup>` (currently flat in a `gap-4` div)
- Modal close animation: add `data-closed:duration-[200ms] data-closed:ease-[var(--ease-swift-out)]`
- ARIA fixes: TimeRow listbox/option correctness; AddinCard's `aria-controls` (now in summary cards); `aria-selected` reflects actual selection
- `handleSubmit` wrapped in `useCallback` to fix the stale-retry-closure bug
- `suggestions` `useMemo` deps narrowed to `[startAt, endAt, visitors.length, roomFacts, mealWindows]`
- `aria-live="polite"` on validation message
- Ship as one polish commit with the bullets above as commit body
- (~3h.)

### Phase E — Verification + docs (1 task)

**E.1** — Run full `pnpm test` + `pnpm build` + `pnpm lint`. Update spec's "Implementation status" section with the v3 architecture. Update `apps/web/src/components/booking-composer-v2/README.md` to describe the new right-panel pattern. Add memory entry. (~1h.)

**Total estimate: ~26h ≈ 3-4 working days. Realistic on the orchestrator pattern with subagents per task.**

## Constraints

- Mobile already has the modal going full-bleed (Task 6.6); the `<RightPanel>` slide animation should still work in single-column-stacked mobile (right panel becomes a section below left, slide stays horizontal — test).
- Form-composition rule applies to summary cards too: any in-card editable inputs use `<Field>` + `<FieldLabel>`. (Most summary cards aren't editable — they hand off to picker views — so this is mostly N/A.)
- Toast voice rule (`Couldn't <verb> <thing>`) preserved.
- Reduced-motion: panel slide must respect `prefers-reduced-motion: reduce` (the global clamp in `apps/web/src/index.css` handles this; verify by manual check).

## Out of scope

- Conflict-strike / "Lauren cannot attend" inline awareness (deferred — needs conflict-check API).
- Real Space photo / `Space.image_url` — render initials/icon placeholder until backend ships the field.
- Description rich-text toolbar — keep current `<Textarea>`; revisit if the user requests a follow-up.
- Recurrence summary in the right pane (currently the RepeatRow lives in the left pane; summary card would be visual duplication). Skip.
- Visitors summary card — visitors live in the left pane already; right-pane duplicate would be visual noise. Skip.

## Open questions / accepted unknowns

- The TimesSummaryCard's [Change] behavior: focus the inline TimeRow on the left pane vs. open a picker:time view. v1: focus the left-pane row. Revisit if the inline TimeRow proves cramped.
- Slide animation direction: forward (summary → picker slides left) is the natural read direction; back animates the reverse. Confirm with prefers-reduced-motion fallback.
- Whether to rename `right-pane/` to `right-panel/` (since `<AddinStack>` and friends are gone). Leave as-is; rename in a follow-up cleanup if it bothers anyone.

## Spec self-review (after Phase E)

- Right pane has summary view by default with 4 cards
- Each card: filled state with Change/Remove + empty state with CTA
- Click card CTA → picker view fills the entire right panel
- Picker has [← Back] in header that returns to summary
- Slide animation between views, respecting reduced-motion
- Suggested chip surfaces on empty CTAs (gated on backend signals)
- Time fields are visible inline at once (date · time · date · time)
- Modal panes connected via `border-l` hairline (not floating card)
- Left-pane fields in FieldGroup
- Default time set on emptyDraft → users see real values, not `— · —`
- All design-review must-fixes applied
- Tests + build + lint green
