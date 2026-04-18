# Ticket Sidebar — Linear-Style Inline Editing

**Status:** design approved 2026-04-18, pending implementation plan.
**Related:** `docs/routing.md` (SLA on reassignment, rescope gaps).

## Problem

The ticket detail properties sidebar (`apps/web/src/components/desk/ticket-detail.tsx`, right column starting at line 694) only wires three editable fields: Status, Priority, Team. Everything else is read-only text, including the "+ Add label" button, which has no `onClick` handler and is dead. The current sidebar does not feel like Linear — it feels like a detail view with three lucky fields.

The backend already accepts most of what we need via `PATCH /tickets/:id` (`UpdateTicketDto`), and there is a dedicated audited reassignment endpoint (`POST /tickets/:id/reassign`) that the frontend never calls. This spec closes the gap for every sidebar field that is safely editable without triggering routing/SLA/workflow cascades.

## Goals

1. Make every sidebar field the backend can mutate **editable inline**, with Linear-parity UX.
2. Route assignee changes through the audited `/reassign` endpoint so `routing_decisions` stays honest.
3. Reuse a single editor component so new fields added later are one-line additions, not per-field implementations.

## Non-goals

- Changing `location_id`, `asset_id`, `ticket_type_id`, or `requester_person_id`. These would re-trigger routing (and for request type, SLA/workflow). A "rescope" feature with its own endpoint is tracked in `docs/routing.md` → Known gaps. Not part of this work.
- Mobile/narrow-viewport sidebar behavior. Today's sidebar is fixed-width 320px; a responsive sheet variant is a separate feature.
- Satisfaction rating/comment editors. Those are part of a post-resolution requester survey flow, not an agent sidebar concern.
- Sub-issues section (lines 379–388) is a placeholder and out of scope here.

## Architecture

### One reusable editor component

New file: `apps/web/src/components/desk/inline-property.tsx`

`<InlineProperty>` renders a label + an interactive trigger in the Linear row pattern: muted label, pill-shaped trigger, hover background `bg-accent/30`, click opens the appropriate editor. The editor body is a prop — one of:

- **Enum pickers** (Status, Priority, Waiting reason): shadcn `Select`. Keep the existing three as-is.
- **Entity pickers** (Team, Assignee, Vendor): shadcn `Popover + Command`, server-side search with ~180ms debounce, keyboard navigation. Mirrors the `@mention` picker already in the file (lines 524–621) so visual/interaction parity is automatic.
- **Multi-select** (Tags, Watchers): `Popover + Command` with selected items rendered as pills inside the trigger, plus a "Create new" command item for Tags.
- **Inline text** (Title, Description): click swaps `<h1>`/`<p>` for `<Textarea>`. Blur or Cmd/Ctrl+Enter saves; Esc cancels and reverts.
- **Number** (Cost): `Popover` with `Input[type=number]` and a currency prefix.

### One mutation hook

New file: `apps/web/src/hooks/use-ticket-mutation.ts`

`useTicketMutation(ticketId)` exposes:

- `patch(updates: Partial<UpdateTicketDto>)` — fire-and-forget optimistic PATCH
- `reassign(args: { team?, user?, vendor? })` — auto-reason reassignment
- `updateAssignment(target)` — tiered entry point: if the ticket currently has no assignee in that slot it calls `patch`; otherwise it calls `reassign` with a synthesized reason

Everything funnels through one place so the tiered logic isn't duplicated per-field.

### Empty-state affordance

Unset fields render `+ Add {label}` in muted color. Hover fades to `bg-accent/30`, cursor pointer. Click opens the same editor as a populated field.

## Scope

### Fields made editable

| Field | Editor type | Endpoint | Notes |
|---|---|---|---|
| Status | Select (existing) | PATCH | No change to behavior |
| Priority | Select (existing) | PATCH | No change to behavior |
| Team | Select (existing shape) | Tiered PATCH / reassign | Change: previously silent PATCH always |
| Assignee (user) | Popover + Command | Tiered PATCH / reassign | New, via `/users` |
| Vendor | Popover + Command | Tiered PATCH / reassign | New, via `/vendors`. Rendered only when `interaction_mode === 'external'` |
| Labels (Tags) | Multi-select Popover + Command with create-new | `PATCH { tags }` | New. Replaces the dead `+ Add label` button |
| Waiting reason | Select | PATCH | New. Rendered only when `status_category === 'waiting'` |
| Cost | Popover with numeric input | PATCH | New |
| Watchers | Multi-select Popover + Command | `PATCH { watchers }` | New, via `/persons` |
| Title | Inline textarea | PATCH | New. Click the `<h1>` to edit |
| Description | Inline textarea | PATCH | New. Click the `<p>` (or the "Add a description…" placeholder) to edit |

### Fields deliberately read-only

- **SLA timer, Created timestamp, Workflow badge** — derived/computed
- **Requester** — effectively ticket identity
- **Location, Asset, Request type** — would re-trigger routing/SLA/workflow (see `docs/routing.md`)
- **Satisfaction fields** — belong to a different flow

### Dead code removed

- The onClick-less `+ Add label` button at `ticket-detail.tsx:811` is replaced by the Tags editor.

## Backend work

1. **New endpoint:** `GET /tickets/tags`
   - Returns `string[]` — distinct tag values used in the caller's tenant, ordered alphabetically.
   - Query: `SELECT DISTINCT unnest(tags) AS tag FROM tickets WHERE tenant_id = $1 AND tags IS NOT NULL ORDER BY tag`.
   - Used as the autocomplete source for the Tags editor. Power users can create new tags by typing + hitting Enter on "Create \"{query}\"".
2. No other backend changes. `/users`, `/vendors`, `/persons`, `PATCH /tickets/:id`, and `POST /tickets/:id/reassign` all exist and are sufficient.

## Tiered assignment: PATCH vs `/reassign`

The sidebar mediates between silent PATCH and audited reassign:

- **First-time assignment** (current value is null, new value is non-null): `PATCH` — it's not really a reassignment, just picking an assignee for the first time.
- **Replacement** (current value is non-null, new value differs or is null): `POST /tickets/:id/reassign` with:
  - `reason: "Reassigned from {previousName} to {nextName or 'unassigned'} by {actorName} via ticket sidebar"`
  - `actor_person_id: <current user's person_id>`
  - `rerun_resolver: false` (manual mode — user explicitly picked the target)

This keeps the `routing_decisions` audit trail honest without adding friction. Users who want to type a custom reason are not accommodated in this iteration — add a "with reason…" keyboard shortcut later if that demand appears.

## UX polish

### Optimistic updates

`useTicketMutation` updates local state immediately, fires the request, and on error rolls back + shows `toast.error`. No spinners on the trigger itself — the optimistic update is the feedback. This is what makes the sidebar feel instant instead of form-like.

### Keyboard

- **Ship in v1:** `Esc` closes any open editor popover and cancels inline text edits; `Cmd/Ctrl+Enter` saves inline text editors; tab order is natural (Radix handles focus trap).
- **Stretch (skip if > 30 min):** Linear-style single-letter hotkeys when the detail view is focused: `S` status, `P` priority, `T` team, `A` assignee, `L` label. Only ship if trivial.

### Error handling

- Network failure → rollback + `toast.error("Failed to update {field}")`
- Validation (e.g. cost NaN) → inline red border on input, no toast
- `/reassign` 4xx → rollback + `toast.error(response.message)`

### Accessibility

- Each trigger is a real `<button>` with `aria-label` describing the field and its current value
- Popover content inherits `role="dialog"` from Radix
- Inline text editors preserve focus on the `<textarea>` when opened

### Data loading

Sidebar mounts and fetches `ticket + /teams + /users + /vendors + /persons` in parallel on first render (today it does `ticket + /teams + /persons`). All four picker sources stay cached for the session — picker popovers feel instant on open, and `@mention` still uses the same `/persons` cache it uses today.

## Success criteria

- Every field listed in the "made editable" table opens an editor on click and persists via the expected endpoint.
- Reassigning a ticket (team, user, or vendor) with a previous assignee set produces a `routing_decisions` row with `chosen_by: 'manual_reassign'` and an internal activity with the synthesized reason. A first-time assignment does not produce a `routing_decisions` row.
- Optimistic update appears within one frame of the click; rollback happens within one frame of an error response.
- The dead `+ Add label` button is gone; the Tags editor works for both existing and new tags.
- No regression in the three currently-working fields (Status, Priority, Team).
- `GET /tickets/tags` returns distinct tenant-scoped tags and no cross-tenant leakage.

## Testing notes

- `useTicketMutation`: unit-test the tiered branching (null → patch, non-null → reassign) and the rollback behavior on simulated failure.
- `<InlineProperty>`: smoke-test each editor type renders, opens, saves, cancels.
- Integration: a playwright-style happy-path through the sidebar changing each field and verifying the API received the expected payload.
- Multi-tenant isolation: `GET /tickets/tags` test must assert a ticket in tenant B does not leak tags into tenant A's response.

## Implementation sequencing

Rough order the implementation plan should follow:

1. **Backend:** `GET /tickets/tags` endpoint + tenant-isolation test
2. **Hook:** `useTicketMutation` with patch + reassign + tiered `updateAssignment`, with optimistic semantics
3. **Component:** `<InlineProperty>` wrapping the five editor body types
4. **Refactor sidebar:** swap existing Status/Priority/Team rendering to `<InlineProperty>` (no behavior change)
5. **Add new fields:** Assignee, Vendor, Tags, Waiting reason, Cost, Watchers
6. **Add inline text:** Title, Description
7. **Polish pass:** empty-state affordances, hover states, error toasts, accessibility review
8. **Stretch (optional):** single-letter hotkeys
