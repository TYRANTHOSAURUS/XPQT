# Bookings split-view + full route + global search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `/desk/bookings` to parity with `/desk/tickets`: split-pane detail, full-page route, and global-search reachability.

**Architecture:** Extract `BookingDetailContent` from the existing portal drawer into a shared component. Wrap it three ways: portal Sheet, desk right-side panel, and full-page route. Add a `'reservation'` kind to the global-search RPC (with a new `reservation_visibility_ids` SQL predicate mirroring `ticket_visibility_ids`).

**Tech Stack:** React 19 + Vite + Tailwind v4, NestJS, Supabase Postgres (RPC-driven search).

**Spec:** `docs/superpowers/specs/2026-04-27-bookings-split-view-design.md`

---

## File Map

**New (web):**
- `apps/web/src/components/booking-detail/booking-detail-content.tsx`
- `apps/web/src/components/booking-detail/booking-detail-panel.tsx`
- `apps/web/src/components/booking-detail/booking-detail-page.tsx`
- `apps/web/src/components/booking-detail/index.ts` (barrel)

**Moved (web) — from `apps/web/src/pages/portal/me-bookings/components/` to `apps/web/src/components/booking-detail/`:**
- `booking-detail-drawer.tsx`
- `booking-edit-form.tsx`
- `bundle-services-section.tsx`
- `cancel-with-scope-dialog.tsx`
- `booking-status-pill.tsx`

**Modified (web):**
- `apps/web/src/pages/desk/bookings.tsx` — split-pane layout
- `apps/web/src/pages/portal/me-bookings/index.tsx` — drawer import path
- `apps/web/src/pages/portal/me-bookings/components/booking-row.tsx` — status-pill import path
- `apps/web/src/App.tsx` — new route `/desk/bookings/:id`
- `apps/web/src/api/search.ts` (or wherever `SearchKind` type lives)
- `apps/web/src/components/command-palette/command-palette-body.tsx` — `KIND_META` + `RESULT_KIND_ORDER`

**New (db):**
- `supabase/migrations/00157_reservation_visibility_ids.sql`
- `supabase/migrations/00158_search_global_reservations.sql`

**Modified (api):**
- `apps/api/src/modules/search/search.service.ts` — `SearchKind` enum

---

## Slice 1 — Shared `booking-detail/` directory

### Task 1.1: Move portal-only detail components to shared location

**Files:**
- Move: `apps/web/src/pages/portal/me-bookings/components/booking-status-pill.tsx` → `apps/web/src/components/booking-detail/booking-status-pill.tsx`
- Move: `apps/web/src/pages/portal/me-bookings/components/bundle-services-section.tsx` → `apps/web/src/components/booking-detail/bundle-services-section.tsx`
- Move: `apps/web/src/pages/portal/me-bookings/components/booking-edit-form.tsx` → `apps/web/src/components/booking-detail/booking-edit-form.tsx`
- Move: `apps/web/src/pages/portal/me-bookings/components/cancel-with-scope-dialog.tsx` → `apps/web/src/components/booking-detail/cancel-with-scope-dialog.tsx`
- Move: `apps/web/src/pages/portal/me-bookings/components/booking-detail-drawer.tsx` → `apps/web/src/components/booking-detail/booking-detail-drawer.tsx`
- Modify: `apps/web/src/pages/portal/me-bookings/index.tsx:9` — drawer import → `@/components/booking-detail/booking-detail-drawer`
- Modify: `apps/web/src/pages/portal/me-bookings/components/booking-row.tsx:7` — status-pill import → `@/components/booking-detail/booking-status-pill`
- Modify: `apps/web/src/pages/desk/bookings.tsx:16` — drawer import → `@/components/booking-detail/booking-detail-drawer`
- Modify (within moved drawer): change relative imports `./booking-status-pill`, `./booking-edit-form`, `./bundle-services-section`, `./cancel-with-scope-dialog` — they all become same-directory siblings, so `./` paths still work.

- [ ] **Step 1: Move files**

```bash
mkdir -p apps/web/src/components/booking-detail
git mv apps/web/src/pages/portal/me-bookings/components/booking-status-pill.tsx apps/web/src/components/booking-detail/booking-status-pill.tsx
git mv apps/web/src/pages/portal/me-bookings/components/bundle-services-section.tsx apps/web/src/components/booking-detail/bundle-services-section.tsx
git mv apps/web/src/pages/portal/me-bookings/components/booking-edit-form.tsx apps/web/src/components/booking-detail/booking-edit-form.tsx
git mv apps/web/src/pages/portal/me-bookings/components/cancel-with-scope-dialog.tsx apps/web/src/components/booking-detail/cancel-with-scope-dialog.tsx
git mv apps/web/src/pages/portal/me-bookings/components/booking-detail-drawer.tsx apps/web/src/components/booking-detail/booking-detail-drawer.tsx
```

- [ ] **Step 2: Update import sites**

Edit the three import sites listed above. The drawer's own internal imports stay relative (siblings still in same dir).

- [ ] **Step 3: Verify build passes**

Run: `pnpm -C apps/web typecheck`
Expected: 0 errors.

- [ ] **Step 4: Verify tests pass**

Run: `pnpm -C apps/web test --run`
Expected: All pass (no behavior change).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(bookings): hoist detail components to shared directory"
```

### Task 1.2: Extract `BookingDetailContent` from drawer

The drawer's body (status strip + meta rows + bundle services + actions + audit footer) is the reusable surface. The Sheet header (chip ref + title + relative-time description) stays in the wrapper since each surface (Sheet / Panel / Page) has its own header chrome.

**Files:**
- Create: `apps/web/src/components/booking-detail/booking-detail-content.tsx`
- Modify: `apps/web/src/components/booking-detail/booking-detail-drawer.tsx`

- [ ] **Step 1: Create `BookingDetailContent`**

```tsx
// apps/web/src/components/booking-detail/booking-detail-content.tsx
import { useState } from 'react';
import {
  CalendarClock, CheckCircle2, Pencil, RefreshCw, Users as UsersIcon, X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReservationDetail, useCheckInBooking, useRestoreBooking } from '@/api/room-booking';
import type { Reservation } from '@/api/room-booking';
import { formatFullTimestamp, formatRelativeTime } from '@/lib/format';
import { BookingStatusPill } from './booking-status-pill';
import { BookingEditForm } from './booking-edit-form';
import { BundleServicesSection } from './bundle-services-section';
import { CancelWithScopeDialog } from './cancel-with-scope-dialog';
import { toastError, toastSuccess } from '@/lib/toast';

const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit',
});
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'long', day: 'numeric',
});

export interface BookingDetailContentProps {
  reservationId: string | null;
  /** Called when nested cancel/edit/check-in flows want to dismiss the surface. */
  onDismiss?: () => void;
}

/**
 * Shared body of the booking detail surface. Renders status strip, meta rows,
 * bundle services, action buttons, and audit footer. Wrapped by:
 *   - BookingDetailDrawer (Sheet, portal)
 *   - BookingDetailPanel (split-pane right side, desk)
 *   - BookingDetailPage (full route, desk)
 *
 * Header chrome (title / ref / relative-time) is owned by each wrapper since
 * Sheet vs SettingsPageHeader vs inline panel header have different rules.
 */
export function BookingDetailContent({ reservationId, onDismiss }: BookingDetailContentProps) {
  const { data: reservation, isPending } = useReservationDetail(reservationId ?? '');
  const [editing, setEditing] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  const checkIn = useCheckInBooking();
  const restore = useRestoreBooking();

  if (isPending && !reservation) {
    return <div className="px-5 py-6 text-sm text-muted-foreground">Loading…</div>;
  }
  if (!reservation) return null;

  const isPast = new Date(reservation.end_at).getTime() < Date.now();

  const showCheckIn =
    reservation.status === 'confirmed' &&
    reservation.check_in_required &&
    !reservation.checked_in_at;

  const showRestore =
    reservation.status === 'cancelled' &&
    reservation.cancellation_grace_until !== null &&
    new Date(reservation.cancellation_grace_until!).getTime() > Date.now();

  const showEdit =
    !isPast && (reservation.status === 'confirmed' || reservation.status === 'pending_approval');

  const onCheckIn = async () => {
    try {
      await checkIn.mutateAsync(reservation.id);
      toastSuccess('Checked in');
    } catch (e) {
      toastError("Couldn't check in", { error: e, retry: onCheckIn });
    }
  };

  const onRestore = async () => {
    try {
      await restore.mutateAsync(reservation.id);
      toastSuccess('Booking restored');
    } catch (e) {
      toastError("Couldn't restore booking", { error: e, retry: onRestore });
    }
  };

  if (editing) {
    return (
      <div className="px-5 py-5">
        <BookingEditForm reservation={reservation} onClose={() => setEditing(false)} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {/* Status strip */}
      <div className="flex items-center justify-between gap-2 border-b px-5 py-3">
        <BookingStatusPill reservation={reservation} />
        {reservation.calendar_event_id && (
          <Badge variant="outline" className="h-5 text-[10px]">Mirrored to Outlook</Badge>
        )}
      </div>

      {/* Meta rows */}
      <div className="divide-y">
        <DetailRow icon={<CalendarClock className="size-3.5" />} label="When">
          <div className="text-sm tabular-nums">
            {DATE_FORMATTER.format(new Date(reservation.start_at))}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {TIME_FORMATTER.format(new Date(reservation.start_at))} –{' '}
            {TIME_FORMATTER.format(new Date(reservation.end_at))}
          </div>
        </DetailRow>

        <DetailRow icon={<UsersIcon className="size-3.5" />} label="Attendees">
          <div className="text-sm">{reservation.attendee_count ?? 0} expected</div>
          {reservation.attendee_person_ids.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {reservation.attendee_person_ids.length} internal · others external
            </div>
          )}
        </DetailRow>

        {reservation.check_in_required && (
          <DetailRow icon={<CheckCircle2 className="size-3.5" />} label="Check-in">
            {reservation.checked_in_at ? (
              <div className="text-sm text-emerald-700 dark:text-emerald-400">
                Checked in {formatRelativeTime(reservation.checked_in_at)}
              </div>
            ) : (
              <div className="text-sm">
                Required within {reservation.check_in_grace_minutes} minutes of start
              </div>
            )}
          </DetailRow>
        )}

        {reservation.recurrence_series_id && (
          <DetailRow icon={<RefreshCw className="size-3.5" />} label="Recurrence">
            <div className="text-sm">Part of a series</div>
            {reservation.recurrence_index != null && (
              <div className="text-xs text-muted-foreground">
                Occurrence #{reservation.recurrence_index + 1}
              </div>
            )}
          </DetailRow>
        )}

        {reservation.policy_snapshot.rule_evaluations &&
          reservation.policy_snapshot.rule_evaluations.some((e) => e.matched) && (
            <DetailRow label="Rules applied">
              <ul className="space-y-1 text-xs">
                {reservation.policy_snapshot.rule_evaluations
                  .filter((e) => e.matched)
                  .map((e) => (
                    <li key={e.rule_id} className="flex items-start gap-2">
                      <code className="chip mt-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px]">
                        {e.effect}
                      </code>
                      {e.denial_message && (
                        <span className="text-muted-foreground">{e.denial_message}</span>
                      )}
                    </li>
                  ))}
              </ul>
            </DetailRow>
          )}
      </div>

      {reservation.booking_bundle_id && (
        <BundleServicesSection bundleId={reservation.booking_bundle_id} />
      )}

      {(showCheckIn || showRestore || showEdit) && (
        <div className="border-t px-5 py-3">
          <div className="flex flex-wrap gap-2">
            {showCheckIn && (
              <Button onClick={onCheckIn} disabled={checkIn.isPending}>
                {checkIn.isPending ? 'Checking in…' : 'Check in'}
              </Button>
            )}
            {showRestore && (
              <Button variant="outline" onClick={onRestore} disabled={restore.isPending}>
                {restore.isPending ? 'Restoring…' : 'Restore booking'}
              </Button>
            )}
            {showEdit && (
              <>
                <Button variant="outline" onClick={() => setEditing(true)}>
                  <Pencil className="mr-1.5 size-3.5" /> Edit
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive hover:text-destructive hover:bg-destructive/10"
                  onClick={() => setConfirmingCancel(true)}
                >
                  <X className="mr-1.5 size-3.5" /> Cancel booking
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      <div className="border-t bg-muted/20 px-5 py-3 text-[11px] text-muted-foreground tabular-nums">
        Created {formatFullTimestamp(reservation.created_at)}
        {reservation.updated_at !== reservation.created_at && (
          <span className="block">
            Last updated {formatRelativeTime(reservation.updated_at)}
          </span>
        )}
      </div>

      <CancelWithScopeDialog
        open={confirmingCancel}
        onOpenChange={setConfirmingCancel}
        reservation={reservation}
        isRecurring={Boolean(reservation.recurrence_series_id)}
        onCancelled={onDismiss}
      />
    </div>
  );
}

function DetailRow({
  label, icon, children,
}: {
  label: string; icon?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-start gap-3 px-5 py-3">
      <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {icon}{label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
```

- [ ] **Step 2: Slim `BookingDetailDrawer` to a Sheet wrapper**

Replace its body to render `<BookingDetailContent reservationId={reservationId} onDismiss={onClose} />` inside the SheetContent, keeping the SheetHeader (chip ref + title + relative-time description) intact.

```tsx
// apps/web/src/components/booking-detail/booking-detail-drawer.tsx
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { useReservationDetail } from '@/api/room-booking';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

interface Props {
  reservationId: string | null;
  onClose: () => void;
  spaceName?: string | null;
}

export function BookingDetailDrawer({ reservationId, onClose, spaceName }: Props) {
  const open = Boolean(reservationId);
  const { data: reservation } = useReservationDetail(reservationId ?? '');
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 sm:max-w-md p-0">
        <SheetHeader className="border-b px-5 py-4">
          {reservation && (
            <code
              data-chip
              className="font-mono text-xs text-muted-foreground tabular-nums mb-1 inline-block"
            >
              {formatRef('reservation', reservation.module_number)}
            </code>
          )}
          <SheetTitle className="text-lg">{spaceName ?? 'Booking'}</SheetTitle>
          <SheetDescription>
            {reservation
              ? `Booked ${formatRelativeTime(reservation.created_at)}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          <BookingDetailContent reservationId={reservationId} onDismiss={onClose} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
```

- [ ] **Step 3: Verify**

```bash
pnpm -C apps/web typecheck
pnpm -C apps/web test --run
```
Expected: 0 errors. Same test count, same pass count.

- [ ] **Step 4: Smoke-test the portal**

```bash
pnpm dev:web
```
- Visit `/portal/me-bookings`, click any booking row, confirm drawer renders identically (status strip, rows, bundle, actions, audit).
- Click cancel button → CancelWithScopeDialog opens.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(bookings): extract BookingDetailContent from drawer"
```

---

## Slice 2 — Desk split-pane

### Task 2.1: Add `BookingDetailPanel`

**Files:**
- Create: `apps/web/src/components/booking-detail/booking-detail-panel.tsx`

The panel renders an inline header bar (title + ref + close + expand) and the shared body underneath. Sized to fill its parent `Panel`.

- [ ] **Step 1: Create**

```tsx
// apps/web/src/components/booking-detail/booking-detail-panel.tsx
import { useNavigate } from 'react-router-dom';
import { Maximize2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReservationDetail } from '@/api/room-booking';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

interface Props {
  reservationId: string | null;
  spaceName?: string | null;
  onClose: () => void;
}

/**
 * Right-side panel for the desk split-pane bookings view. Fills its parent
 * `<Panel>`; the parent must give it a positioning context (the standard
 * `<Panel className="relative">` from /desk/tickets does this).
 */
export function BookingDetailPanel({ reservationId, spaceName, onClose }: Props) {
  const navigate = useNavigate();
  const { data: reservation } = useReservationDetail(reservationId ?? '');

  return (
    <div className="absolute inset-0 flex flex-col overflow-hidden border-l bg-background">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 border-b px-5 py-4 shrink-0">
        <div className="min-w-0">
          {reservation && (
            <code
              data-chip
              className="font-mono text-xs text-muted-foreground tabular-nums mb-1 inline-block"
            >
              {formatRef('reservation', reservation.module_number)}
            </code>
          )}
          <h2 className="truncate text-lg font-semibold tracking-tight">
            {spaceName ?? reservation?.space_id ? spaceName ?? 'Booking' : 'Booking'}
          </h2>
          <p className="text-xs text-muted-foreground">
            {reservation
              ? `Booked ${formatRelativeTime(reservation.created_at)}`
              : 'Loading…'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {reservationId && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Open full page"
              onClick={() => navigate(`/desk/bookings/${reservationId}`)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        <BookingDetailContent reservationId={reservationId} onDismiss={onClose} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm -C apps/web typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat(bookings): BookingDetailPanel for desk split-pane"
```

### Task 2.2: Convert `/desk/bookings` to split-pane

**Files:**
- Modify: `apps/web/src/pages/desk/bookings.tsx`

- [ ] **Step 1: Refactor return into Group/Panel layout**

Replace the imports + the final return + the drawer mount. Mirror `apps/web/src/pages/desk/tickets.tsx:558-583`:

```tsx
// imports — replace BookingDetailDrawer with Group/Panel/Separator + BookingDetailPanel
import { Group, Panel, Separator } from 'react-resizable-panels';
import { BookingDetailPanel } from '@/components/booking-detail/booking-detail-panel';

// remove: import { BookingDetailDrawer } from '@/components/booking-detail/booking-detail-drawer';
```

Replace the `return (...)` block. The current single column becomes a `BookingsListView` component (extract the existing JSX from the top-level `return` into a function component). Then:

```tsx
return (
  <>
    <Group orientation="horizontal" style={{ height: '100%' }}>
      {selectedId ? (
        <>
          <Panel id="list" defaultSize="55%" className="relative">
            <BookingsListView {...listProps} />
          </Panel>
          <Separator />
          <Panel id="detail" defaultSize="45%" className="relative">
            <BookingDetailPanel
              reservationId={selectedId}
              spaceName={allItems.find((r) => r.id === selectedId)?.space_name ?? null}
              onClose={closeDetail}
            />
          </Panel>
        </>
      ) : (
        <Panel id="list" className="relative">
          <BookingsListView {...listProps} />
        </Panel>
      )}
    </Group>
  </>
);
```

The list view's outermost element should be `<div className="absolute inset-0 flex flex-col overflow-hidden">` to fill the panel cleanly (matches tickets).

Remove the bottom `<BookingDetailDrawer ... />` mount.

- [ ] **Step 2: Verify typecheck + tests**

```bash
pnpm -C apps/web typecheck
pnpm -C apps/web test --run
```

- [ ] **Step 3: Smoke-test in browser**

`pnpm dev:web` → `/desk/bookings`:
- Click a row → URL updates to `?id=:id`, right panel opens.
- Resize handle works.
- Close button on panel removes `?id`.
- Switch scope chip with detail open → detail stays open.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(bookings): split-pane layout on /desk/bookings"
```

---

## Slice 3 — Full route

### Task 3.1: Create `BookingDetailPage`

**Files:**
- Create: `apps/web/src/components/booking-detail/booking-detail-page.tsx`

- [ ] **Step 1: Create**

```tsx
// apps/web/src/components/booking-detail/booking-detail-page.tsx
import { useParams } from 'react-router-dom';
import {
  SettingsPageShell, SettingsPageHeader,
} from '@/components/ui/settings-page';
import { Badge } from '@/components/ui/badge';
import { useReservationDetail } from '@/api/room-booking';
import { useSpace } from '@/api/spaces';
import { formatRelativeTime } from '@/lib/format';
import { formatRef } from '@/lib/format-ref';
import { BookingDetailContent } from './booking-detail-content';

export function BookingDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const { data: reservation, isPending } = useReservationDetail(id);
  const { data: space } = useSpace(reservation?.space_id ?? null);

  if (isPending) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          title="Loading…"
          backTo="/desk/bookings"
        />
      </SettingsPageShell>
    );
  }

  if (!reservation) {
    return (
      <SettingsPageShell width="default">
        <SettingsPageHeader
          title="Booking not found"
          description="This booking either doesn't exist or you don't have access to it."
          backTo="/desk/bookings"
        />
      </SettingsPageShell>
    );
  }

  return (
    <SettingsPageShell width="default">
      <SettingsPageHeader
        title={space?.name ?? 'Booking'}
        description={
          <span className="inline-flex items-center gap-2">
            <code data-chip className="font-mono tabular-nums">
              {formatRef('reservation', reservation.module_number)}
            </code>
            <span>· Booked {formatRelativeTime(reservation.created_at)}</span>
          </span>
        }
        backTo="/desk/bookings"
      />
      <div className="rounded-md border bg-card overflow-hidden">
        <BookingDetailContent reservationId={id} />
      </div>
    </SettingsPageShell>
  );
}
```

If `useSpace` doesn't exist, fall back to using `reservation.space_id` directly (the page is still valuable; the title just becomes the ref). Investigate during implementation: grep for `useSpace` under `apps/web/src/api/`.

- [ ] **Step 2: Add barrel exports**

```tsx
// apps/web/src/components/booking-detail/index.ts
export { BookingDetailContent } from './booking-detail-content';
export { BookingDetailDrawer } from './booking-detail-drawer';
export { BookingDetailPanel } from './booking-detail-panel';
export { BookingDetailPage } from './booking-detail-page';
```

- [ ] **Step 3: Verify typecheck**

`pnpm -C apps/web typecheck`

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(bookings): full-route BookingDetailPage"
```

### Task 3.2: Wire route in App.tsx

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Lazy import + route**

After line 72 (`const DeskBookingsPage = …`), add:

```tsx
const BookingDetailPage = lazyNamed(
  () => import('@/components/booking-detail/booking-detail-page'),
  'BookingDetailPage',
);
```

After line 204 (the existing `bookings` route), insert:

```tsx
<Route path="bookings/:id" element={<BookingDetailPage />} />
```

- [ ] **Step 2: Verify route resolves**

`pnpm dev:web` → click a booking row → expand button → `/desk/bookings/:id` → page renders. Back link returns to list.

- [ ] **Step 3: Direct-visit + 404**

- Visit `/desk/bookings/<known-id>` directly → loads detail.
- Visit `/desk/bookings/00000000-0000-0000-0000-000000000000` → "Booking not found" page.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(bookings): /desk/bookings/:id route"
```

---

## Slice 4 — Search backend

### Task 4.1: Add `reservation_visibility_ids` SQL function

The TS service in `reservation-visibility.service.ts` enforces three tiers:
1. Participant (`requester_person_id`, `host_person_id`, `attendee_person_ids[]` contains the user's `person_id`, `booked_by_user_id` = user.id).
2. Operator (`rooms.read_all` permission).
3. Admin (`rooms.admin` permission).

Mirror this in SQL so search can filter without N+1.

**Files:**
- Create: `supabase/migrations/00157_reservation_visibility_ids.sql`

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/00157_reservation_visibility_ids.sql
-- Per-user reservation visibility predicate. Mirrors ticket_visibility_ids.
--
-- Used by search_global to filter reservation hits without N+1 round-trips.
-- The TS-side ReservationVisibilityService remains the canonical enforcement
-- point for API CRUD; this function exists for set-based read paths.

create or replace function public.reservation_visibility_ids(
  p_user_id uuid,
  p_tenant_id uuid
)
returns table (id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select u.id as user_id, u.person_id
    from public.users u
    where u.id = p_user_id and u.tenant_id = p_tenant_id
  ),
  has_admin as (
    select coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'rooms.admin'), false) as v
  ),
  has_read_all as (
    select coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'rooms.read_all'), false) as v
  )
  select r.id
  from public.reservations r, me, has_admin, has_read_all
  where r.tenant_id = p_tenant_id
    and (
      has_admin.v
      or has_read_all.v
      or r.requester_person_id = me.person_id
      or r.host_person_id = me.person_id
      or r.booked_by_user_id = me.user_id
      or me.person_id = any(r.attendee_person_ids)
    );
$$;

revoke all on function public.reservation_visibility_ids(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reservation_visibility_ids(uuid, uuid) to service_role;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Test locally**

```bash
pnpm db:reset
```
Expected: clean apply. Then sanity-check via psql against the local Supabase:
```bash
PGPASSWORD=postgres psql "postgresql://postgres@127.0.0.1:54322/postgres" -c "select count(*) from public.reservation_visibility_ids('00000000-0000-0000-0000-000000000000'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);"
```
Expected: `0` (no real ids).

- [ ] **Step 3: Push to remote**

User has authorized DB push for this workstream. Try `pnpm db:push` first; if that fails (per memory `supabase_remote_push.md`), fall back to psql:
```bash
PGPASSWORD='<DB_PASSWORD_FROM_ENV>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00157_reservation_visibility_ids.sql
```
Then notify schema reload (already in the file).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00157_reservation_visibility_ids.sql
git commit -m "feat(db): reservation_visibility_ids SQL predicate"
```

### Task 4.2: Extend `search_global` with reservation kind

**Files:**
- Create: `supabase/migrations/00158_search_global_reservations.sql`

The migration replaces `search_global` (CREATE OR REPLACE) with the existing body plus a new reservations branch. To keep the diff small, copy the full function from `00151_search_global_defense_in_depth.sql` and append a reservations clause before the final `end;`.

- [ ] **Step 1: Write migration**

```sql
-- supabase/migrations/00158_search_global_reservations.sql
-- Add 'reservation' kind to search_global. Filters via reservation_visibility_ids.

create or replace function public.search_global(
  p_user_id uuid,
  p_tenant_id uuid,
  p_q text,
  p_types text[] default null,
  p_per_type_limit int default 4
)
returns table (
  kind text,
  id uuid,
  title text,
  subtitle text,
  breadcrumb text,
  score real,
  extra jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_q text := lower(trim(coalesce(p_q, '')));
  v_pat text;
  v_is_operator boolean;
  v_limit int := greatest(1, least(coalesce(p_per_type_limit, 4), 20));
  v_wants_all boolean := p_types is null or array_length(p_types, 1) is null;
begin
  if length(v_q) < 2 then return; end if;

  if not exists (
    select 1 from public.users u
    where u.id = p_user_id and u.tenant_id = p_tenant_id
  ) then return; end if;

  v_pat := '%' || v_q || '%';

  select exists (
    select 1
    from public.user_role_assignments ura
    where ura.user_id = p_user_id
      and ura.tenant_id = p_tenant_id
      and ura.active = true
  ) or coalesce(public.user_has_permission(p_user_id, p_tenant_id, 'tickets.read_all'), false)
  into v_is_operator;

  -- ── Tickets ──────────────────────────────────────────────────────────────
  if v_wants_all or 'ticket' = any(p_types) then
    return query
      with visible as (
        select v.id from public.ticket_visibility_ids(p_user_id, p_tenant_id) v(id)
      ),
      hits as (
        select
          t.id, t.title, t.status, t.status_category, t.created_at,
          t.requester_person_id, t.location_id,
          greatest(
            similarity(lower(coalesce(t.title, '')), v_q),
            similarity(lower(coalesce(t.description, '')), v_q) * 0.6::real,
            case when lower(coalesce(t.title, '')) like v_q || '%' then 0.95::real else 0::real end,
            case when right(t.id::text, 12) ilike v_q || '%' then 0.99::real else 0::real end
          )::real as score
        from public.tickets t
        join visible on visible.id = t.id
        where t.tenant_id = p_tenant_id
          and (
            t.title ilike v_pat
            or coalesce(t.description, '') ilike v_pat
            or t.id::text ilike v_pat
            or t.title % v_q
            or coalesce(t.description, '') % v_q
          )
      )
      select 'ticket'::text, h.id, h.title,
        upper(left(h.id::text, 8)) || ' · ' || h.status as subtitle,
        null::text, h.score,
        jsonb_build_object(
          'status', h.status,
          'status_category', h.status_category,
          'created_at', h.created_at,
          'requester_person_id', h.requester_person_id,
          'location_id', h.location_id
        )
      from hits h
      order by h.score desc, h.created_at desc
      limit v_limit;
  end if;

  -- ── Persons (operator-only) ──────────────────────────────────────────────
  if v_is_operator and (v_wants_all or 'person' = any(p_types)) then
    return query
      select 'person'::text, p.id,
        (p.first_name || ' ' || p.last_name)::text as title,
        coalesce(p.email, p.cost_center, p.type) as subtitle,
        null::text,
        greatest(
          similarity(lower(p.first_name || ' ' || p.last_name), v_q),
          similarity(lower(coalesce(p.email, '')), v_q) * 0.9::real,
          case when lower(p.first_name) like v_q || '%' or lower(p.last_name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'email', p.email, 'cost_center', p.cost_center,
          'type', p.type, 'active', p.active
        )
      from public.persons p
      where p.tenant_id = p_tenant_id and p.active = true
        and (
          p.first_name ilike v_pat or p.last_name ilike v_pat
          or coalesce(p.email, '') ilike v_pat
          or p.first_name % v_q or p.last_name % v_q
        )
      order by score desc
      limit v_limit;
  end if;

  -- ── Spaces / locations / rooms ───────────────────────────────────────────
  if v_wants_all or 'space' = any(p_types) or 'room' = any(p_types) or 'location' = any(p_types) then
    return query
      select case when s.reservable then 'room' else 'space' end as kind,
        s.id, s.name, s.type::text as subtitle,
        public.space_breadcrumb(s.id) as breadcrumb,
        greatest(
          similarity(lower(s.name), v_q),
          similarity(lower(coalesce(s.code, '')), v_q) * 0.9::real,
          case when lower(s.name) like v_q || '%' then 0.95::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'type', s.type, 'code', s.code,
          'reservable', s.reservable, 'capacity', s.capacity
        )
      from public.spaces s
      where s.tenant_id = p_tenant_id and s.active = true
        and (s.name ilike v_pat or coalesce(s.code, '') ilike v_pat or s.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- ── Assets (operator-only) ───────────────────────────────────────────────
  if v_is_operator and (v_wants_all or 'asset' = any(p_types)) then
    return query
      select 'asset'::text, a.id, a.name,
        coalesce(at.name, a.asset_role) || case when a.tag is not null then ' · ' || a.tag else '' end as subtitle,
        public.space_breadcrumb(a.assigned_space_id) as breadcrumb,
        greatest(
          similarity(lower(a.name), v_q),
          similarity(lower(coalesce(a.tag, '')), v_q) * 0.95::real,
          similarity(lower(coalesce(a.serial_number, '')), v_q) * 0.85::real,
          case when lower(coalesce(a.tag, '')) like v_q || '%' then 0.99::real else 0::real end
        )::real as score,
        jsonb_build_object(
          'tag', a.tag, 'serial_number', a.serial_number,
          'status', a.status, 'asset_role', a.asset_role,
          'asset_type_name', at.name
        )
      from public.assets a
      left join public.asset_types at on at.id = a.asset_type_id
      where a.tenant_id = p_tenant_id
        and (a.name ilike v_pat or coalesce(a.tag, '') ilike v_pat
             or coalesce(a.serial_number, '') ilike v_pat or a.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- ── Vendors (operator-only) ──────────────────────────────────────────────
  if v_is_operator and (v_wants_all or 'vendor' = any(p_types)) then
    return query
      select 'vendor'::text, v.id, v.name,
        coalesce(v.contact_email, 'Vendor') as subtitle,
        null::text,
        similarity(lower(v.name), v_q)::real as score,
        jsonb_build_object('contact_email', v.contact_email,
          'contact_phone', v.contact_phone, 'active', v.active)
      from public.vendors v
      where v.tenant_id = p_tenant_id and v.active = true
        and (v.name ilike v_pat or v.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- ── Teams (operator-only) ────────────────────────────────────────────────
  if v_is_operator and (v_wants_all or 'team' = any(p_types)) then
    return query
      select 'team'::text, t.id, t.name,
        coalesce(t.domain_scope, 'Team') as subtitle,
        null::text,
        similarity(lower(t.name), v_q)::real as score,
        jsonb_build_object('domain_scope', t.domain_scope, 'active', t.active)
      from public.teams t
      where t.tenant_id = p_tenant_id and t.active = true
        and (t.name ilike v_pat or t.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- ── Request types ────────────────────────────────────────────────────────
  if v_wants_all or 'request_type' = any(p_types) then
    return query
      select 'request_type'::text, rt.id, rt.name,
        coalesce(rt.domain, 'Request type') as subtitle,
        null::text,
        similarity(lower(rt.name), v_q)::real as score,
        jsonb_build_object('domain', rt.domain, 'active', rt.active)
      from public.request_types rt
      where rt.tenant_id = p_tenant_id and rt.active = true
        and (rt.name ilike v_pat or rt.name % v_q)
      order by score desc
      limit v_limit;
  end if;

  -- ── Reservations ─────────────────────────────────────────────────────────
  -- Hits visible per reservation_visibility_ids (participant / rooms.read_all
  -- / rooms.admin). Search by space name, requester name, ref number suffix.
  if v_wants_all or 'reservation' = any(p_types) then
    return query
      with visible as (
        select v.id from public.reservation_visibility_ids(p_user_id, p_tenant_id) v(id)
      ),
      hits as (
        select
          r.id, r.module_number, r.start_at, r.end_at, r.status,
          s.name as space_name, s.id as space_id,
          (req.first_name || ' ' || req.last_name) as requester_name,
          public.space_breadcrumb(s.id) as breadcrumb,
          greatest(
            similarity(lower(coalesce(s.name, '')), v_q),
            similarity(lower(coalesce(req.first_name || ' ' || req.last_name, '')), v_q) * 0.85::real,
            case when r.module_number::text ilike v_q || '%' then 0.99::real else 0::real end,
            case when lower(coalesce(s.name, '')) like v_q || '%' then 0.93::real else 0::real end
          )::real as score
        from public.reservations r
        join visible on visible.id = r.id
        join public.spaces s on s.id = r.space_id
        left join public.persons req on req.id = r.requester_person_id
        where r.tenant_id = p_tenant_id
          and (
            s.name ilike v_pat
            or coalesce(req.first_name, '') ilike v_pat
            or coalesce(req.last_name, '') ilike v_pat
            or r.module_number::text ilike v_pat
            or s.name % v_q
            or coalesce(req.first_name || ' ' || req.last_name, '') % v_q
          )
      )
      select 'reservation'::text, h.id, h.space_name as title,
        coalesce(h.requester_name, '—') || ' · ' || to_char(h.start_at at time zone 'UTC', 'Mon DD, HH24:MI') as subtitle,
        h.breadcrumb,
        h.score,
        jsonb_build_object(
          'module_number', h.module_number,
          'start_at', h.start_at,
          'end_at', h.end_at,
          'status', h.status,
          'space_id', h.space_id
        )
      from hits h
      order by h.score desc, h.start_at desc
      limit v_limit;
  end if;
end;
$$;

notify pgrst, 'reload schema';
```

- [ ] **Step 2: Local apply**

```bash
pnpm db:reset
```
Expected: clean apply.

- [ ] **Step 3: Push to remote (psql fallback path)**

```bash
PGPASSWORD='<DB_PASSWORD>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00158_search_global_reservations.sql
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/00158_search_global_reservations.sql
git commit -m "feat(search): index reservations in global search RPC"
```

### Task 4.3: Add `'reservation'` to backend SearchKind enum

**Files:**
- Modify: `apps/api/src/modules/search/search.service.ts:5-14`

- [ ] **Step 1: Edit type**

```ts
export type SearchKind =
  | 'ticket'
  | 'person'
  | 'space'
  | 'room'
  | 'location'
  | 'asset'
  | 'vendor'
  | 'team'
  | 'request_type'
  | 'reservation';
```

- [ ] **Step 2: Verify**

```bash
pnpm -C apps/api typecheck
pnpm -C apps/api test --run
```

- [ ] **Step 3: Smoke-test the RPC end-to-end**

```bash
pnpm dev:api & pnpm dev:web
```
Open Cmd-K palette, type a known room name → verify reservation results appear (after ⌘1 etc. all-scope) and route lands on `/desk/bookings/:id`.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/search/search.service.ts
git commit -m "feat(api): add 'reservation' to SearchKind"
```

---

## Slice 5 — Search frontend (command palette)

### Task 5.1: Add 'reservation' to frontend `SearchKind` + `KIND_META`

**Files:**
- Modify: `apps/web/src/api/search.ts` (locate via grep)
- Modify: `apps/web/src/components/command-palette/command-palette-body.tsx`

- [ ] **Step 1: Add to type**

Find the type and append `| 'reservation'`.

- [ ] **Step 2: Add KIND_META entry**

In `command-palette-body.tsx` after line ~131 (after `request_type`):

```tsx
reservation: {
  label: 'Bookings',
  singular: 'booking',
  icon: CalendarClock,
  href: (id, { scope }) =>
    scope === 'public' ? `/portal/me-bookings?id=${id}` : `/desk/bookings/${id}`,
  listHref: (q) => `/desk/bookings?q=${encodeURIComponent(q)}`,
},
```

Import `CalendarClock` from `lucide-react` (alongside `CalendarDays` already there).

- [ ] **Step 3: Add to `RESULT_KIND_ORDER`**

```tsx
const RESULT_KIND_ORDER: SearchKind[] = [
  'ticket',
  'person',
  'reservation', // bookings rank above rooms because they're the actionable item
  'room',
  'space',
  'asset',
  'vendor',
  'team',
  'request_type',
];
```

- [ ] **Step 4: Verify typecheck**

`pnpm -C apps/web typecheck`

- [ ] **Step 5: Manual test**

`pnpm dev` → ⌘K → type a room name → confirm "Bookings" group appears with rows. Click one → `/desk/bookings/:id` opens for an operator, `/portal/me-bookings?id=:id` for a portal user.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(web): surface bookings in command palette"
```

---

## Slice 6 — Verification + review

### Task 6.1: Full test suite + lint

- [ ] **Step 1**

```bash
pnpm -C apps/web typecheck && pnpm -C apps/web test --run
pnpm -C apps/api typecheck && pnpm -C apps/api test --run
pnpm -C apps/web lint
```
Expected: all green.

### Task 6.2: Codex review

Per `feedback_codex_reviews.md`, run codex against the diff after each substantive slice. Final pass:

```bash
codex exec --full-auto -C /Users/x/Desktop/XPQT \
  "Review the diff between origin/main and HEAD for the bookings split-view + global search change. Look for: (1) regressions in portal me-bookings flow, (2) visibility-correctness in reservation_visibility_ids and the new search_global branch (could a non-participant non-operator see a booking?), (3) form/field/toast guideline drift, (4) typecheck holes, (5) react-resizable-panels integration regressions in the desk layout. Output: list of specific issues with file:line references, severity (high/med/low), and a one-line fix per issue. Skip nits."
```

Address any high/med findings before merge. Fold codex's review into the spec doc as a footer if there are persistent observations.

### Task 6.3: Manual smoke test — golden + edges

- [ ] **Golden:** desk operator visits `/desk/bookings`, scope toggle works, click row → split panel. Expand → `/desk/bookings/:id`. Back link → list. ⌘K → "espresso" returns the bookings group, click → opens `/desk/bookings/:id`.
- [ ] **Edge: portal requester** visits `/portal/me-bookings`, drawer renders identically to before.
- [ ] **Edge: 404** — visit `/desk/bookings/00000000-…` → "not found" page.
- [ ] **Edge: cancel flow** — click Cancel inside the panel → CancelWithScopeDialog opens, cancel works, panel updates.
- [ ] **Edge: edit flow** — click Edit, change time, save, panel returns to read view.
- [ ] **Edge: reduced motion** — verify the resize handle and panel transitions clamp under `prefers-reduced-motion: reduce`.

### Task 6.4: Final commit, push branch, PR

```bash
git push origin <branch-name>
gh pr create --title "feat(bookings): split-view + full route + global search" --body "$(cat <<'EOF'
## Summary
- /desk/bookings now mirrors /desk/tickets: split-pane on row click, full /desk/bookings/:id route, expand button on the panel
- Portal /me-bookings keeps the existing Sheet drawer
- Global search adds a 'reservation' kind backed by a new reservation_visibility_ids SQL predicate

Spec: docs/superpowers/specs/2026-04-27-bookings-split-view-design.md

## Test plan
- [ ] /desk/bookings click row → panel
- [ ] Expand → /desk/bookings/:id
- [ ] ⌘K → search → reservation hit → /desk/bookings/:id
- [ ] Portal /me-bookings drawer unchanged
- [ ] 404 / direct visit edge cases
EOF
)"
```

---

## Out of scope (flagged in spec)

- Table view toggle on `/desk/bookings`.
- Vendor visibility on bundle services for desk operators.
- Bulk operations on the desk bookings list.
- Cross-scope server-side search inside `/desk/bookings`.
