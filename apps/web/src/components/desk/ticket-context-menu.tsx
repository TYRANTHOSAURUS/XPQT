import { useMemo, useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toastError, toastSuccess } from '@/lib/toast';
import {
  ExternalLink,
  PanelRightOpen,
  Copy,
  Link2,
  Tag as TagIcon,
  UserPlus,
  UserMinus,
  Eye,
  EyeOff,
  Replace,
  Wrench,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuCheckboxItem,
  ContextMenuGroup,
  ContextMenuLabel,
} from '@/components/ui/context-menu';
import { useAuth } from '@/providers/auth-provider';
import {
  ticketKeys,
  useUpdateTicket,
  useReassignTicket,
  useTicketTagSuggestions,
  type TicketDetail,
} from '@/api/tickets';
import { type Ticket } from './ticket-row-cells';
import { formatTicketRef } from '@/lib/format-ref';

const STATUS_OPTIONS = [
  { value: 'new', label: 'New' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'resolved', label: 'Resolved' },
  { value: 'closed', label: 'Closed' },
] as const;

const WAITING_REASONS = [
  { value: 'requester', label: 'Awaiting requester' },
  { value: 'vendor', label: 'Awaiting vendor' },
  { value: 'approval', label: 'Awaiting approval' },
  { value: 'scheduled_work', label: 'Scheduled work' },
  { value: 'other', label: 'Other' },
] as const;

const PRIORITY_OPTIONS = [
  { value: 'urgent', label: 'Urgent' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

const MAX_LABEL_SUGGESTIONS = 12;

/**
 * Floor for how long the pending spinner stays visible. On a fast network the
 * server can settle in <50ms, faster than the eye can perceive — without this
 * the user sees no feedback between clicking and the checkmark appearing.
 */
const MIN_PENDING_MS = 400;

function holdAtLeast(start: number, clear: () => void) {
  const remaining = Math.max(0, MIN_PENDING_MS - (Date.now() - start));
  window.setTimeout(clear, remaining);
}

/**
 * Spinner positioned exactly where the radio/checkbox indicator (checkmark)
 * would render — `absolute right-2`. Inherits `currentColor` so it stays
 * legible against both the popover background and the highlighted-item
 * `bg-accent`.
 */
function PendingDot() {
  return (
    <span className="pointer-events-none absolute right-2 inline-flex items-center justify-center">
      <Spinner className="size-3.5" />
    </span>
  );
}

interface TicketContextMenuProps {
  ticket: Ticket;
  onOpenDetail: (id: string) => void;
  onReclassify: (ticket: Ticket) => void;
  onAddWorkOrder: (ticket: Ticket) => void;
  /**
   * Render-prop child — receives the trigger props from base-ui and merges them
   * onto the row element (`<tr>` or `<div>`) so right-click on the row opens the
   * menu without breaking table semantics. The second argument exposes the
   * trigger state so the row can persistently highlight while the menu is open.
   */
  children: (
    triggerProps: Record<string, unknown>,
    state: { open: boolean },
  ) => ReactElement;
}

export function TicketContextMenu({
  ticket,
  onOpenDetail,
  onReclassify,
  onAddWorkOrder,
  children,
}: TicketContextMenuProps) {
  const qc = useQueryClient();
  const { person, appUser } = useAuth();
  const update = useUpdateTicket(ticket.id);
  const reassign = useReassignTicket(ticket.id);
  const { data: tagSuggestions } = useTicketTagSuggestions();

  // Local pending overlays so the user gets immediate "I heard you" feedback
  // on a property change. The list query isn't optimistically updated (only
  // the detail cache is), so without these the indicator would lag the
  // network round-trip.
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [pendingWaitingReason, setPendingWaitingReason] = useState<string | null>(null);
  const [pendingPriority, setPendingPriority] = useState<string | null>(null);
  const [pendingTags, setPendingTags] = useState<Set<string>>(() => new Set());

  // Pull the (likely-cached) full detail for fields the row doesn't carry
  // (watchers, request_type). The list view's hover prefetch primes this.
  const cachedDetail = qc.getQueryData<TicketDetail>(ticketKeys.detail(ticket.id));

  const ticketRef = formatTicketRef(ticket.ticket_kind, ticket.module_number);
  const isCase = ticket.ticket_kind === 'case';
  const isClosedOrResolved =
    ticket.status_category === 'closed' || ticket.status_category === 'resolved';

  const currentTags = useMemo(() => ticket.tags ?? [], [ticket.tags]);
  const labelOptions = useMemo(() => {
    const tagSet = new Set<string>(currentTags);
    (tagSuggestions ?? []).slice(0, MAX_LABEL_SUGGESTIONS).forEach((t) => tagSet.add(t));
    return Array.from(tagSet).slice(0, MAX_LABEL_SUGGESTIONS);
  }, [currentTags, tagSuggestions]);

  const isWatching = Boolean(
    person?.id && (cachedDetail?.watchers ?? []).includes(person.id),
  );

  const assignedToMe = Boolean(
    appUser?.id && cachedDetail?.assigned_agent?.id === appUser.id,
  );
  const hasAnyAssignee = Boolean(
    ticket.assigned_team || ticket.assigned_agent || cachedDetail?.assigned_vendor,
  );

  const handleOpenInNewTab = () => {
    window.open(`/desk/tickets/${ticket.id}`, '_blank', 'noopener,noreferrer');
  };

  const handleCopy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toastSuccess(`${label} copied`);
    } catch {
      toastError("Couldn't copy to clipboard", {
        description: 'Your browser blocked clipboard access. Select the text and copy manually.',
      });
    }
  };

  const setStatus = (status_category: string) => {
    if (status_category === ticket.status_category) return;
    const label = STATUS_OPTIONS.find((s) => s.value === status_category)?.label ?? status_category;
    const start = Date.now();
    setPendingStatus(status_category);
    update.mutate(
      { status_category, status: status_category },
      {
        onSuccess: () => toastSuccess(`Status set to ${label}`),
        onError: (err) => toastError("Couldn't update status", {
          error: err,
          retry: () => setStatus(status_category),
        }),
        // Guard against a stale completion clearing the spinner of a newer
        // in-flight click — only clear if our value is still the pending one.
        onSettled: () => holdAtLeast(start, () => {
          setPendingStatus((prev) => (prev === status_category ? null : prev));
        }),
      },
    );
  };

  const setWaitingReason = (waiting_reason: string) => {
    const label = WAITING_REASONS.find((r) => r.value === waiting_reason)?.label ?? waiting_reason;
    const start = Date.now();
    setPendingStatus('waiting');
    setPendingWaitingReason(waiting_reason);
    update.mutate(
      ticket.status_category === 'waiting'
        ? { waiting_reason }
        : { status_category: 'waiting', status: 'waiting', waiting_reason },
      {
        onSuccess: () => toastSuccess(`Status set to Waiting · ${label}`),
        onError: (err) => toastError("Couldn't update status", {
          error: err,
          retry: () => setWaitingReason(waiting_reason),
        }),
        onSettled: () => holdAtLeast(start, () => {
          setPendingStatus((prev) => (prev === 'waiting' ? null : prev));
          setPendingWaitingReason((prev) => (prev === waiting_reason ? null : prev));
        }),
      },
    );
  };

  const setPriority = (priority: string) => {
    if (priority === ticket.priority) return;
    const label = PRIORITY_OPTIONS.find((p) => p.value === priority)?.label ?? priority;
    const start = Date.now();
    setPendingPriority(priority);
    update.mutate(
      { priority },
      {
        onSuccess: () => toastSuccess(`Priority set to ${label}`),
        onError: (err) => toastError("Couldn't update priority", {
          error: err,
          retry: () => setPriority(priority),
        }),
        onSettled: () => holdAtLeast(start, () => {
          setPendingPriority((prev) => (prev === priority ? null : prev));
        }),
      },
    );
  };

  const assignToMe = () => {
    if (!appUser?.id) {
      toastError("Couldn't assign", {
        description: "Your account isn't linked to a desk user yet. Ask an admin.",
      });
      return;
    }
    if (assignedToMe) return;

    const previousLabel = cachedDetail?.assigned_agent?.email ?? null;
    const meName = person ? `${person.first_name} ${person.last_name}`.trim() : 'me';

    if (previousLabel === null) {
      update.mutate(
        { assigned_user_id: appUser.id },
        {
          onSuccess: () => toastSuccess('Assigned to you'),
          onError: (err) => toastError("Couldn't assign to you", { error: err, retry: assignToMe }),
        },
      );
      return;
    }

    reassign.mutate(
      {
        kind: 'user',
        id: appUser.id,
        nextLabel: meName,
        previousLabel,
        reason: `Self-assigned by ${meName} from tickets list`,
        actorPersonId: person?.id,
      },
      {
        onSuccess: () => toastSuccess('Assigned to you'),
        onError: (err) => toastError("Couldn't reassign to you", { error: err, retry: assignToMe }),
      },
    );
  };

  const unassign = async () => {
    if (!hasAnyAssignee) return;
    const actorName = person ? `${person.first_name} ${person.last_name}`.trim() : 'an agent';
    const reason = `Unassigned by ${actorName} from tickets list`;

    // Clear whichever assignment(s) exist. Each goes through reassign so the
    // server records a routing_decisions row. Run in parallel and toast once.
    const tasks: Promise<unknown>[] = [];
    if (cachedDetail?.assigned_agent?.id || ticket.assigned_agent) {
      tasks.push(reassign.mutateAsync({
        kind: 'user',
        id: null,
        nextLabel: null,
        previousLabel: cachedDetail?.assigned_agent?.email ?? ticket.assigned_agent?.email ?? 'agent',
        reason,
        actorPersonId: person?.id,
      }));
    }
    if (ticket.assigned_team || cachedDetail?.assigned_team) {
      tasks.push(reassign.mutateAsync({
        kind: 'team',
        id: null,
        nextLabel: null,
        previousLabel: ticket.assigned_team?.name ?? cachedDetail?.assigned_team?.name ?? 'team',
        reason,
        actorPersonId: person?.id,
      }));
    }
    if (cachedDetail?.assigned_vendor) {
      tasks.push(reassign.mutateAsync({
        kind: 'vendor',
        id: null,
        nextLabel: null,
        previousLabel: cachedDetail.assigned_vendor.name,
        reason,
        actorPersonId: person?.id,
      }));
    }

    try {
      await Promise.all(tasks);
      toastSuccess('Unassigned');
    } catch (err) {
      toastError("Couldn't unassign", { error: err, retry: unassign });
    }
  };

  const toggleWatch = () => {
    if (!person?.id) {
      toastError("Couldn't update watchers", {
        description: "Your account isn't linked to a person record. Ask an admin.",
      });
      return;
    }
    const current = cachedDetail?.watchers ?? [];
    const willWatch = !isWatching;
    const next = willWatch
      ? [...current, person.id]
      : current.filter((id) => id !== person.id);
    update.mutate(
      { watchers: next },
      {
        onSuccess: () => toastSuccess(willWatch ? 'Now watching' : 'Stopped watching'),
        onError: (err) => toastError("Couldn't update watchers", { error: err, retry: toggleWatch }),
      },
    );
  };

  const toggleLabel = (tag: string) => {
    const has = currentTags.includes(tag);
    const next = has ? currentTags.filter((t) => t !== tag) : [...currentTags, tag];
    const start = Date.now();
    setPendingTags((prev) => new Set(prev).add(tag));
    update.mutate(
      { tags: next },
      {
        onSuccess: () => toastSuccess(has ? `Removed label "${tag}"` : `Added label "${tag}"`),
        onError: (err) => toastError("Couldn't update labels", {
          error: err,
          retry: () => toggleLabel(tag),
        }),
        onSettled: () => holdAtLeast(start, () => setPendingTags((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(tag);
          return nextSet;
        })),
      },
    );
  };

  const link = `${window.location.origin}/desk/tickets/${ticket.id}`;

  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={(props, state) =>
          children(props as Record<string, unknown>, { open: Boolean(state?.open) })
        }
      />
      <ContextMenuContent className="w-56">
        <ContextMenuGroup>
          <ContextMenuLabel className="font-mono">{ticketRef}</ContextMenuLabel>
        </ContextMenuGroup>
        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => onOpenDetail(ticket.id)}>
          <PanelRightOpen /> Open
        </ContextMenuItem>
        <ContextMenuItem onClick={handleOpenInNewTab}>
          <ExternalLink /> Open in new tab
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={() => handleCopy(ticketRef, 'Reference')}>
          <Copy /> Copy reference
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handleCopy(link, 'Link')}>
          <Link2 /> Copy link
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger>Status</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-48">
            {/* Spinner shows only while the chosen value differs from what the
                row currently reflects. As soon as the list refetches and the
                ticket value matches, the spinner unmounts and the radio's own
                indicator (checkmark) takes over — never both at once. */}
            <ContextMenuRadioGroup
              value={ticket.status_category}
              onValueChange={(v) => v && setStatus(v)}
            >
              {STATUS_OPTIONS.map((s) => (
                <ContextMenuRadioItem key={s.value} value={s.value}>
                  <span className="flex-1">{s.label}</span>
                  {pendingStatus === s.value
                    && ticket.status_category !== s.value
                    && <PendingDot />}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger
                className={ticket.status_category === 'waiting' ? 'bg-accent' : undefined}
              >
                <span className="flex-1">Waiting</span>
                {pendingStatus === 'waiting' && ticket.status_category !== 'waiting' && (
                  <Spinner className="size-3.5" />
                )}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-52">
                <ContextMenuRadioGroup
                  value={
                    ticket.status_category === 'waiting'
                      ? cachedDetail?.waiting_reason ?? ''
                      : ''
                  }
                  onValueChange={(v) => v && setWaitingReason(v)}
                >
                  {WAITING_REASONS.map((r) => {
                    const isPending =
                      pendingWaitingReason === r.value
                      && (ticket.status_category !== 'waiting'
                        || cachedDetail?.waiting_reason !== r.value);
                    return (
                      <ContextMenuRadioItem key={r.value} value={r.value}>
                        <span className="flex-1">{r.label}</span>
                        {isPending && <PendingDot />}
                      </ContextMenuRadioItem>
                    );
                  })}
                </ContextMenuRadioGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSub>
          <ContextMenuSubTrigger>Priority</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-44">
            <ContextMenuRadioGroup
              value={ticket.priority}
              onValueChange={(v) => v && setPriority(v)}
            >
              {PRIORITY_OPTIONS.map((p) => (
                <ContextMenuRadioItem key={p.value} value={p.value}>
                  <span className="flex-1">{p.label}</span>
                  {pendingPriority === p.value
                    && ticket.priority !== p.value
                    && <PendingDot />}
                </ContextMenuRadioItem>
              ))}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>

        <ContextMenuSeparator />

        <ContextMenuItem onClick={assignToMe} disabled={!appUser || assignedToMe}>
          <UserPlus /> {assignedToMe ? 'Assigned to you' : 'Assign to me'}
        </ContextMenuItem>
        <ContextMenuItem onClick={unassign} disabled={!hasAnyAssignee}>
          <UserMinus /> Unassign
        </ContextMenuItem>
        <ContextMenuItem onClick={toggleWatch} disabled={!person?.id || !cachedDetail}>
          {isWatching ? <EyeOff /> : <Eye />} {isWatching ? 'Stop watching' : 'Watch'}
        </ContextMenuItem>

        <ContextMenuSeparator />

        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <TagIcon /> Labels
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-56">
            {labelOptions.length === 0 ? (
              <ContextMenuItem disabled>No labels available</ContextMenuItem>
            ) : (
              labelOptions.map((tag) => (
                <ContextMenuCheckboxItem
                  key={tag}
                  checked={currentTags.includes(tag)}
                  onCheckedChange={() => toggleLabel(tag)}
                  // Keep the menu open so multiple labels can be toggled.
                  closeOnClick={false}
                >
                  <span className="flex-1">{tag}</span>
                  {pendingTags.has(tag) && <PendingDot />}
                </ContextMenuCheckboxItem>
              ))
            )}
          </ContextMenuSubContent>
        </ContextMenuSub>

        {isCase && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem
              onClick={() => onReclassify(ticket)}
              disabled={isClosedOrResolved}
            >
              <Replace /> Change request type…
            </ContextMenuItem>
            <ContextMenuItem onClick={() => onAddWorkOrder(ticket)}>
              <Wrench /> Add work order…
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
