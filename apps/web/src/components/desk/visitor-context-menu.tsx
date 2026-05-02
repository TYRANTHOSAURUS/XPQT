import { useCallback, useState, type ReactElement } from 'react';
import {
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  LogIn,
  LogOut,
  PanelRightOpen,
  UserCheck,
  XCircle,
} from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { CheckoutDialog } from '@/components/desk/visitor-checkout-dialog';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  formatReceptionRowName,
  useMarkArrived,
  useMarkCheckedOut,
  useMarkNoShow,
  type ReceptionVisitorRow as RowT,
} from '@/api/visitors/reception';

interface VisitorContextMenuProps {
  row: RowT;
  buildingId: string | null;
  onOpenDetail: (id: string) => void;
  onAssignPass: (row: RowT) => void;
  /**
   * Render-prop child — receives the trigger props from base-ui and
   * merges them onto the row element so right-click on the row opens
   * the menu without breaking semantics. The second arg exposes the
   * trigger state so the row can persistently highlight while the menu
   * is open.
   */
  children: (
    triggerProps: Record<string, unknown>,
    state: { open: boolean },
  ) => ReactElement;
}

function backdatedIso(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

/**
 * Right-click menu on a visitor row. Mirrors the shape of
 * `ticket-context-menu.tsx` so the desk's right-click affordances feel
 * consistent across surfaces. Action set differs because visitors and
 * tickets have different state machines, but the visual / submenu
 * pattern is the same.
 */
export function VisitorContextMenu({
  row,
  buildingId,
  onOpenDetail,
  onAssignPass,
  children,
}: VisitorContextMenuProps) {
  const markArrived = useMarkArrived(buildingId);
  const markCheckedOut = useMarkCheckedOut(buildingId);
  const markNoShow = useMarkNoShow(buildingId);
  const [checkoutDialog, setCheckoutDialog] = useState(false);

  const visitorLabel = formatReceptionRowName(row);
  const isExpected = row.status === 'expected' || row.status === 'pending_approval';
  const isOnSite = row.status === 'arrived' || row.status === 'in_meeting';
  const isClosed =
    row.status === 'checked_out' ||
    row.status === 'cancelled' ||
    row.status === 'no_show';

  // Wrap handlers in useCallback so the context-menu items don't re-create
  // their click handlers on every parent render — keeps memoised rows
  // memoised. Per-mutation isPending replaces the old shared `pending`
  // string state, so concurrent mark-arrived + mark-no-show on different
  // rows don't disable each other's items.
  const handleArrive = useCallback(
    (minutesAgo: number) => {
      markArrived.mutate(
        {
          visitorId: row.visitor_id,
          arrived_at: minutesAgo > 0 ? backdatedIso(minutesAgo) : undefined,
        },
        {
          onSuccess: () => toastSuccess(`${visitorLabel} marked arrived`),
          onError: (err) =>
            toastError("Couldn't mark arrived", {
              error: err,
              retry: () => handleArrive(minutesAgo),
            }),
        },
      );
    },
    [markArrived, row.visitor_id, visitorLabel],
  );

  const handleCheckout = useCallback(
    (passReturned: boolean | undefined) => {
      markCheckedOut.mutate(
        {
          visitorId: row.visitor_id,
          checkout_source: 'reception',
          pass_returned: passReturned,
        },
        {
          onSuccess: () => toastSuccess(`${visitorLabel} checked out`),
          onError: (err) =>
            toastError("Couldn't check out", {
              error: err,
              retry: () => handleCheckout(passReturned),
            }),
        },
      );
    },
    [markCheckedOut, row.visitor_id, visitorLabel],
  );

  const handleNoShow = useCallback(() => {
    markNoShow.mutate(
      { visitorId: row.visitor_id },
      {
        onSuccess: () => toastSuccess(`${visitorLabel} marked no-show`),
        onError: (err) =>
          toastError("Couldn't mark no-show", { error: err, retry: handleNoShow }),
      },
    );
  }, [markNoShow, row.visitor_id, visitorLabel]);

  const link = `${window.location.origin}/desk/visitors?id=${row.visitor_id}`;

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label} copied`);
    } catch {
      toastError("Couldn't copy to clipboard", {
        description:
          'Your browser blocked clipboard access. Select the text and copy manually.',
      });
    }
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={(props, state) =>
          children(props as Record<string, unknown>, { open: Boolean(state?.open) })
        }
      />
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate">{visitorLabel}</ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => onOpenDetail(row.visitor_id)}>
          <PanelRightOpen /> Open
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => window.open(link, '_blank', 'noopener,noreferrer')}
        >
          <ExternalLink /> Open in new tab
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => handleCopy(visitorLabel, 'Name')}>
          <Copy /> Copy name
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleCopy(link, 'Link')}>
          <Link2 /> Copy link
        </ContextMenuItem>

        <ContextMenuSeparator />

        {isExpected && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              <UserCheck /> Mark arrived
            </ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-48">
              <ContextMenuItem
                onClick={() => handleArrive(0)}
                disabled={markArrived.isPending}
              >
                Just now
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleArrive(5)}
                disabled={markArrived.isPending}
              >
                5 min ago
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleArrive(15)}
                disabled={markArrived.isPending}
              >
                15 min ago
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleArrive(30)}
                disabled={markArrived.isPending}
              >
                30 min ago
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => handleArrive(60)}
                disabled={markArrived.isPending}
              >
                1 hour ago
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}

        {isOnSite && (
          <>
            {/* "Mark left" routes to the explicit pass-return dialog
             *  rather than re-implementing the choice inline. The dialog
             *  also handles the no-pass case so the same affordance
             *  works for visitors without an assigned pass. */}
            <ContextMenuItem
              onClick={() => setCheckoutDialog(true)}
              disabled={markCheckedOut.isPending}
            >
              <LogOut /> Mark left…
            </ContextMenuItem>

            {!row.pass_number && (
              <ContextMenuItem
                onClick={() => onAssignPass(row)}
                disabled={!buildingId}
              >
                <KeyRound /> Assign pass…
              </ContextMenuItem>
            )}
          </>
        )}

        {isExpected && (
          <ContextMenuItem onClick={handleNoShow} disabled={markNoShow.isPending}>
            <XCircle /> Mark no-show
          </ContextMenuItem>
        )}

        {isClosed && (
          <ContextMenuItem disabled>
            <LogIn /> No actions — closed
          </ContextMenuItem>
        )}
      </ContextMenuContent>

      {checkoutDialog && (
        <CheckoutDialog
          open
          onOpenChange={(open) => !open && setCheckoutDialog(false)}
          buildingId={buildingId}
          visitorId={row.visitor_id}
          visitorLabel={visitorLabel}
          hasPass={Boolean(row.pass_number)}
        />
      )}
    </ContextMenu>
  );
}
