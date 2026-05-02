/**
 * Visitor detail panel rendered alongside the /desk/visitors list.
 *
 * Mirrors the shape of `ticket-detail.tsx`: header with title + status
 * + close button, sectioned body covering identity / times / host /
 * pass / notes, primary actions inline at the top.
 *
 * Spec: docs/superpowers/specs/2026-05-01-visitor-management-v1-design.md §2, §6, §7
 */
import { useMemo, useState } from 'react';
import {
  Building2,
  Calendar as CalendarIcon,
  KeyRound,
  LogOut,
  Mail,
  Maximize2,
  Phone,
  StickyNote,
  UserCheck,
  Users as UsersIcon,
  X,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { VisitorStatusBadge } from '@/components/visitors/visitor-status-badge';
import { useVisitorDetail } from '@/api/visitors';
import {
  useMarkArrived,
  useMarkCheckedOut,
  useMarkNoShow,
} from '@/api/visitors/reception';
import { useSpaces } from '@/api/spaces';
import { usePerson, personFullName } from '@/api/persons';
import { CheckoutDialog } from '@/components/desk/visitor-checkout-dialog';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  formatFullTimestamp,
  formatRelativeTime,
  formatTimeShort,
} from '@/lib/format';

interface VisitorDetailProps {
  visitorId: string;
  /** Building scope for the reception mutations. The page resolves this
   *  per-row when it knows the visitor's building. */
  buildingId: string | null;
  onClose: () => void;
  onAssignPass: () => void;
  /** Optional — render an Expand button that navigates to a full-route
   *  visitor detail page once one exists. v1 has no such page so the
   *  prop is left out by the parent today. */
  onExpand?: () => void;
}

export function VisitorDetail({
  visitorId,
  buildingId,
  onClose,
  onAssignPass,
  onExpand,
}: VisitorDetailProps) {
  const { data: visitor, isLoading, isError } = useVisitorDetail(visitorId);
  const { data: spaces } = useSpaces();
  const { data: primaryHost } = usePerson(visitor?.primary_host_person_id ?? null);

  const markArrived = useMarkArrived(buildingId);
  const markCheckedOut = useMarkCheckedOut(buildingId);
  const markNoShow = useMarkNoShow(buildingId);

  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const buildingName = useMemo(() => {
    if (!visitor?.building_id) return null;
    return (spaces ?? []).find((s) => s.id === visitor.building_id)?.name ?? null;
  }, [spaces, visitor?.building_id]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <DetailHeader title="Loading…" onClose={onClose} />
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      </div>
    );
  }

  if (isError || !visitor) {
    return (
      <div className="flex h-full flex-col">
        <DetailHeader title="Visitor" onClose={onClose} />
        <div className="px-6 py-8 text-sm text-muted-foreground">
          Couldn’t load this visitor. Try refreshing.
        </div>
      </div>
    );
  }

  const visitorName =
    [visitor.first_name, visitor.last_name].filter(Boolean).join(' ').trim() ||
    'Unnamed visitor';
  const isExpected =
    visitor.status === 'expected' || visitor.status === 'pending_approval';
  const isOnSite = visitor.status === 'arrived' || visitor.status === 'in_meeting';

  const handleArrive = () => {
    markArrived.mutate(
      { visitorId: visitor.id },
      {
        onSuccess: () => toastSuccess(`${visitorName} marked arrived`),
        onError: (err) =>
          toastError("Couldn't mark arrived", { error: err, retry: handleArrive }),
      },
    );
  };

  // The detail panel's "Mark left" routes through the explicit
  // pass-return dialog so reception can record returned / lost / skip
  // in one place. Same dialog handles the no-pass case.
  const openCheckout = () => setCheckoutOpen(true);

  const handleNoShow = () => {
    markNoShow.mutate(
      { visitorId: visitor.id },
      {
        onSuccess: () => toastSuccess(`${visitorName} marked no-show`),
        onError: (err) =>
          toastError("Couldn't mark no-show", { error: err, retry: handleNoShow }),
      },
    );
  };

  return (
    <div className="flex h-full flex-col">
      <DetailHeader
        title={visitorName}
        subtitle={visitor.company ?? null}
        statusBadge={<VisitorStatusBadge status={visitor.status} />}
        onClose={onClose}
        onExpand={onExpand}
      />

      {/* Action row.
       *
       * Demoted from filled-primary to outline so it doesn't compete with
       * the toolbar's `+ Invite` primary button. Same shape as ticket
       * detail's quiet header — destructive / state-change verbs are
       * outline-secondary and live next to the title rather than at the
       * top of a sidebar. Power users still have the right-click context
       * menu for the same set of actions. */}
      <div className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        {isExpected && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={handleArrive}
              disabled={markArrived.isPending}
            >
              <UserCheck className="size-4" /> Mark arrived
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={handleNoShow}
              disabled={markNoShow.isPending}
            >
              <XCircle className="size-4" /> No-show
            </Button>
          </>
        )}
        {isOnSite && (
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={openCheckout}
              disabled={markCheckedOut.isPending}
            >
              <LogOut className="size-4" /> Mark left
            </Button>
            {!visitor.visitor_pass_id && (
              <Button
                size="sm"
                variant="outline"
                onClick={onAssignPass}
                disabled={!buildingId}
              >
                <KeyRound className="size-4" /> Assign pass
              </Button>
            )}
          </>
        )}
        {!isExpected && !isOnSite && (
          <span className="text-xs text-muted-foreground">No actions for this status.</span>
        )}
      </div>

      <div className="flex-1 overflow-auto px-6 py-4">
        <Section title="When">
          <DetailRow
            icon={CalendarIcon}
            label="Expected"
            value={
              visitor.expected_at ? (
                <time
                  dateTime={visitor.expected_at}
                  title={formatFullTimestamp(visitor.expected_at)}
                  className="tabular-nums"
                >
                  {formatTimeShort(visitor.expected_at)}{' '}
                  <span className="text-muted-foreground">
                    · {formatRelativeTime(visitor.expected_at)}
                  </span>
                </time>
              ) : (
                <span className="text-muted-foreground">Not set</span>
              )
            }
          />
          {visitor.arrived_at && (
            <DetailRow
              icon={UserCheck}
              label="Arrived"
              value={
                <time
                  dateTime={visitor.arrived_at}
                  title={formatFullTimestamp(visitor.arrived_at)}
                  className="tabular-nums"
                >
                  {formatTimeShort(visitor.arrived_at)}{' '}
                  <span className="text-muted-foreground">
                    · {formatRelativeTime(visitor.arrived_at)}
                  </span>
                </time>
              }
            />
          )}
          {visitor.checked_out_at && (
            <DetailRow
              icon={LogOut}
              label="Checked out"
              value={
                <time
                  dateTime={visitor.checked_out_at}
                  title={formatFullTimestamp(visitor.checked_out_at)}
                  className="tabular-nums"
                >
                  {formatTimeShort(visitor.checked_out_at)}{' '}
                  <span className="text-muted-foreground">
                    · {formatRelativeTime(visitor.checked_out_at)}
                  </span>
                </time>
              }
            />
          )}
          {visitor.expected_until && (
            <DetailRow
              icon={CalendarIcon}
              label="Expected until"
              value={
                <time
                  dateTime={visitor.expected_until}
                  title={formatFullTimestamp(visitor.expected_until)}
                  className="tabular-nums"
                >
                  {formatTimeShort(visitor.expected_until)}
                </time>
              }
            />
          )}
        </Section>

        <Section title="Where">
          {buildingName && (
            <DetailRow icon={Building2} label="Building" value={buildingName} />
          )}
          {!buildingName && (
            <DetailRow icon={Building2} label="Building" value={
              <span className="text-muted-foreground">Not anchored</span>
            } />
          )}
        </Section>

        {(visitor.email || visitor.phone) && (
          <Section title="Contact">
            {visitor.email && (
              <DetailRow icon={Mail} label="Email" value={
                <a
                  href={`mailto:${visitor.email}`}
                  className="text-foreground underline underline-offset-2 hover:no-underline"
                >
                  {visitor.email}
                </a>
              } />
            )}
            {visitor.phone && (
              <DetailRow icon={Phone} label="Phone" value={
                <a
                  href={`tel:${visitor.phone}`}
                  className="text-foreground underline underline-offset-2 hover:no-underline"
                >
                  {visitor.phone}
                </a>
              } />
            )}
          </Section>
        )}

        <Section title="Pass">
          {visitor.visitor_pass_id ? (
            <DetailRow icon={KeyRound} label="Assigned" value={
              <span className="text-foreground tabular-nums">Active pass</span>
            } />
          ) : (
            <DetailRow icon={KeyRound} label="Status" value={
              <span className="text-muted-foreground">No pass assigned</span>
            } />
          )}
        </Section>

        <Section title="Hosts">
          <DetailRow icon={UsersIcon} label="Primary host" value={
            visitor.primary_host_person_id ? (
              primaryHost ? (
                <span className="text-foreground">
                  {personFullName(primaryHost) || primaryHost.email || '—'}
                </span>
              ) : (
                <span className="text-muted-foreground">—</span>
              )
            ) : (
              <span className="italic text-muted-foreground">No host</span>
            )
          } />
        </Section>

        {(visitor.notes_for_visitor || visitor.notes_for_reception) && (
          <Section title="Notes">
            {visitor.notes_for_reception && (
              <DetailRow icon={StickyNote} label="For reception" value={
                <span className="whitespace-pre-wrap text-foreground">
                  {visitor.notes_for_reception}
                </span>
              } />
            )}
            {visitor.notes_for_visitor && (
              <DetailRow icon={StickyNote} label="For the visitor" value={
                <span className="whitespace-pre-wrap text-muted-foreground">
                  {visitor.notes_for_visitor}
                </span>
              } />
            )}
          </Section>
        )}
      </div>

      {checkoutOpen && (
        <CheckoutDialog
          open
          onOpenChange={(open) => !open && setCheckoutOpen(false)}
          buildingId={buildingId}
          visitorId={visitor.id}
          visitorLabel={visitorName}
          hasPass={Boolean(visitor.visitor_pass_id)}
        />
      )}
    </div>
  );
}

function DetailHeader({
  title,
  subtitle,
  statusBadge,
  onClose,
  onExpand,
}: {
  title: string;
  subtitle?: string | null;
  statusBadge?: React.ReactNode;
  onClose: () => void;
  onExpand?: () => void;
}) {
  return (
    <div className="flex items-start gap-3 border-b px-6 py-4">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-lg font-medium">{title}</h2>
        {subtitle && (
          <p className="truncate text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {statusBadge}
      {onExpand && (
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onExpand}
          aria-label="Open in full page"
        >
          <Maximize2 className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        onClick={onClose}
        aria-label="Close detail panel"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 last:mb-0">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function DetailRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="mt-0.5 break-words">{value}</div>
      </div>
    </div>
  );
}
