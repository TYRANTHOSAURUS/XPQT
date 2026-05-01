import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Layout } from 'react-resizable-panels';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';
import { SidebarGroup } from '@/components/ui/sidebar-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PersonAvatar } from '@/components/person-avatar';
import { PickerItemBody } from '@/components/desk/editors/picker-item';
import {
  Clock,
  MapPin,
  User,
  AlertTriangle,
  Paperclip,
  MessageSquare,
  Send,
  MoreHorizontal,
  XIcon,
  TagIcon,
  Maximize2,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';
import {
  ticketKeys,
  useTicketDetail,
  useTicketActivities,
  useTicketTagSuggestions,
  useUpdateTicket,
  useUpdateWorkOrder,
  useReassignTicket,
  useReassignWorkOrder,
  useAddActivity,
  useCanPlanWorkOrder,
  type UpdateTicketPayload,
  type UpdateWorkOrderPayload,
} from '@/api/tickets';
import { useTeams } from '@/api/teams';
import { useUsers } from '@/api/users';
import { useVendors } from '@/api/vendors';
import { usePersons, usePersonsSearch } from '@/api/persons';
import { useSlaPolicies } from '@/api/sla-policies';
import { useRequestTypeDefaultFormSchema } from '@/api/request-types';
import { useConfigEntity } from '@/api/config-entities';
import { useTicketWorkflowInstances } from '@/api/workflows';
import { InlineProperty } from '@/components/desk/inline-property';
import { EntityPicker } from '@/components/desk/editors/entity-picker';
import { TicketMetaRow } from '@/components/desk/ticket-meta-row';
import { SubIssuesSection } from '@/components/desk/sub-issues-section';
import { AddSubIssueDialog } from '@/components/desk/add-sub-issue-dialog';
import { ReclassifyTicketDialog } from '@/components/desk/reclassify-ticket-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { TicketActivityFeed } from '@/components/desk/ticket-activity-feed';
import { TicketSlaEscalations } from '@/components/desk/ticket-sla-escalations';
import { PlanField } from '@/components/desk/plan-field';
import { PriorityIcon } from '@/components/desk/ticket-row-cells';
import { formatTicketRef } from '@/lib/format-ref';
import { MultiSelectPicker } from '@/components/desk/editors/multi-select-picker';
import { NumberEditor } from '@/components/desk/editors/number-editor';
import { InlineTextEditor } from '@/components/desk/editors/inline-text-editor';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { formatFullTimestamp } from '@/lib/format';
import { toastError, toastSuccess } from '@/lib/toast';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

function formatFormValue(field: FormField | undefined, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (field?.type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (field?.type === 'date') {
    try { return new Date(String(value)).toLocaleDateString(); } catch { return String(value); } // design-check:allow — date-only form value, not a timestamp
  }
  if (field?.type === 'datetime') {
    try { return new Date(String(value)).toLocaleString(); } catch { return String(value); } // design-check:allow — legacy; migrate to formatFullTimestamp
  }
  return String(value);
}

interface Activity {
  id: string;
  activity_type: string;
  visibility: string;
  content: string;
  attachments?: Array<{
    name: string;
    url?: string;
    path?: string;
    size: number;
    type: string;
  }>;
  author?: { first_name: string; last_name: string };
  metadata: Record<string, unknown> | null;
  created_at: string;
}

interface MentionPerson {
  id: string;
  first_name: string;
  last_name: string;
  email?: string | null;
  department?: string | null;
}

interface MentionMatch {
  start: number;
  end: number;
  query: string;
}

const statusConfig: Record<string, { label: string; dotColor: string }> = {
  new: { label: 'New', dotColor: 'bg-blue-500' },
  assigned: { label: 'Assigned', dotColor: 'bg-yellow-500' },
  in_progress: { label: 'In Progress', dotColor: 'bg-purple-500' },
  waiting: { label: 'Waiting', dotColor: 'bg-orange-500' },
  resolved: { label: 'Resolved', dotColor: 'bg-green-500' },
  closed: { label: 'Closed', dotColor: 'bg-gray-400' },
};

const priorityConfig: Record<string, { label: string; color: string }> = {
  critical: { label: 'Critical', color: 'text-red-500' },
  high: { label: 'High', color: 'text-orange-500' },
  medium: { label: 'Medium', color: 'text-blue-500' },
  low: { label: 'Low', color: 'text-muted-foreground' },
};

const MAX_MENTION_RESULTS = 8;
const SIDEBAR_LAYOUT_STORAGE_KEY = 'ticket-detail-sidebar-layout-v1';

function loadSidebarLayout(): Layout | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const raw = window.localStorage.getItem(SIDEBAR_LAYOUT_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Layout;
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.main === 'number'
      && typeof parsed.sidebar === 'number'
    ) {
      return parsed;
    }
  } catch {
    // ignored — fall through to default
  }
  return undefined;
}

function SlaTimer({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return <span className="text-sm text-muted-foreground">No SLA</span>;
  if (breachedAt) {
    return <span className="text-sm font-medium text-red-500 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Breached</span>;
  }
  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) {
    return <span className="text-sm font-medium text-red-500 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" /> Overdue</span>;
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const urgencyClass = remaining < 3600000 ? 'text-red-500' : remaining < 7200000 ? 'text-yellow-500' : 'text-green-500';
  return <span className={`text-sm font-medium flex items-center gap-1.5 ${urgencyClass}`}><Clock className="h-4 w-4" /> {timeStr}</span>;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function getActiveMention(text: string, caret: number): MentionMatch | null {
  const beforeCaret = text.slice(0, caret);
  const mentionStart = beforeCaret.lastIndexOf('@');
  if (mentionStart === -1) return null;

  const previousChar = mentionStart === 0 ? '' : beforeCaret[mentionStart - 1];
  if (previousChar && !/[\s([{"']/.test(previousChar)) return null;

  const query = beforeCaret.slice(mentionStart + 1);
  if (/\s/.test(query)) return null;

  return { start: mentionStart, end: caret, query };
}

function getPersonLabel(person: MentionPerson): string {
  return `${person.first_name} ${person.last_name}`.trim();
}

function filterMentionPeople(people: MentionPerson[], query: string): MentionPerson[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return people.slice(0, MAX_MENTION_RESULTS);

  return people
    .filter((person) => {
      const fullName = getPersonLabel(person).toLowerCase();
      return (
        fullName.includes(normalizedQuery) ||
        person.email?.toLowerCase().includes(normalizedQuery) ||
        person.department?.toLowerCase().includes(normalizedQuery)
      );
    })
    .slice(0, MAX_MENTION_RESULTS);
}

export function TicketDetail({ ticketId, onClose, onOpenTicket, onExpand }: { ticketId: string; onClose?: () => void; onOpenTicket?: (id: string) => void; onExpand?: () => void }) {
  const qc = useQueryClient();
  const { person } = useAuth();
  const {
    data: ticket,
    isPending: ticketPending,
    isFetching: ticketFetching,
    error: ticketError,
  } = useTicketDetail(ticketId);
  const { data: activities } = useTicketActivities(ticketId) as { data: Activity[] | undefined };
  const refetchTicket = () => qc.invalidateQueries({ queryKey: ticketKeys.detail(ticketId) });
  const refetchActivities = () => qc.invalidateQueries({ queryKey: ticketKeys.activities(ticketId) });
  const { data: teams } = useTeams();
  const { data: people } = usePersons() as { data: MentionPerson[] | undefined };
  const { data: users } = useUsers();
  const { data: vendors } = useVendors();
  const { data: tagSuggestions } = useTicketTagSuggestions();
  const { data: slaPolicies } = useSlaPolicies();

  // Memoize the option-shape transforms. These feed pickers + dialogs that are
  // shallow-compared (or could be), so a stable reference per data tick avoids
  // rebuilding child trees on every keystroke / mutation in this view.
  const teamOptions = useMemo(
    () => (teams ?? []).map((t) => ({ id: t.id, label: t.name })),
    [teams],
  );
  const vendorOptions = useMemo(
    () => (vendors ?? []).map((v) => ({ id: v.id, label: v.name })),
    [vendors],
  );
  const activeVendorOptions = useMemo(
    () => (vendors ?? []).filter((v) => v.active !== false).map((v) => ({ id: v.id, label: v.name })),
    [vendors],
  );
  const userOptions = useMemo(
    () => (users ?? []).map((u) => ({
      id: u.id,
      label: u.person
        ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
        : u.email,
      sublabel: u.email,
      leading: <PersonAvatar size="sm" person={u.person ?? { email: u.email }} />,
    })),
    [users],
  );
  const tagOptions = useMemo(
    () => (tagSuggestions ?? []).map((t) => ({ id: t, label: t })),
    [tagSuggestions],
  );
  const watcherOptions = useMemo(
    () => (people ?? []).map((p) => ({
      id: p.id,
      label: `${p.first_name} ${p.last_name}`.trim(),
      sublabel: p.email ?? null,
      leading: <PersonAvatar size="sm" person={p} />,
    })),
    [people],
  );
  // Default form schema lives on request_type_form_variants now
  // (request_types.form_schema_id was dropped in migration 00098).
  const { data: defaultFormVariant } = useRequestTypeDefaultFormSchema(
    ticket?.request_type?.id ?? null,
  );
  const { data: configEntity } = useConfigEntity(defaultFormVariant?.form_schema_id ?? null);
  const schemaFields = configEntity?.current_version?.definition?.fields ?? [];
  const [commentText, setCommentText] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<'internal' | 'external'>('internal');
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const addActivity = useAddActivity(ticketId);
  const submittingComment = addActivity.isPending;

  const [addWorkOrderOpen, setAddWorkOrderOpen] = useState(false);
  const [workOrdersNonce, setWorkOrdersNonce] = useState(0);
  const [reclassifyOpen, setReclassifyOpen] = useState(false);

  const [sidebarLayout] = useState<Layout | undefined>(() => loadSidebarLayout());
  const persistSidebarLayout = useCallback((layout: Layout) => {
    try {
      window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    } catch {
      // ignored — storage may be unavailable (private mode, quota)
    }
  }, []);

  const updateTicket = useUpdateTicket(ticketId);
  // Plan-reviewer P1: the five Slice 2 per-field hooks (sla / plan / status /
  // priority / assignment) collapsed into a single `useUpdateWorkOrder` —
  // server orchestrator dispatches per-field gates internally. `patch()`
  // dispatches by `ticket_kind` to `useUpdateTicket` (cases) or
  // `useUpdateWorkOrder` (work_orders).
  const updateWorkOrder = useUpdateWorkOrder(ticketId);
  const reassignTicket = useReassignTicket(ticketId);
  const reassignWorkOrder = useReassignWorkOrder(ticketId);
  const { data: canPlanResp } = useCanPlanWorkOrder(ticketId);
  const canPlan = !!canPlanResp?.canPlan;

  const handlePlanChange = (next: { startsAt: string | null; durationMinutes: number | null }) => {
    updateWorkOrder.mutate(
      {
        planned_start_at: next.startsAt,
        planned_duration_minutes: next.durationMinutes,
      },
      {
        onError: (err) =>
          toastError("Couldn't update plan", {
            error: err,
            retry: () => handlePlanChange(next),
          }),
      },
    );
  };

  // Cases → PATCH /tickets/:id (single endpoint, all fields).
  // Work orders → PATCH /work-orders/:id (single endpoint, union DTO).
  // Plan-reviewer C4: defensive early-return so this function's contract is
  // local to itself, not implicit in JSX render order. The JSX paths only
  // call `patch` once `displayedTicket` exists, but a future refactor that
  // wires `patch` into a portal / hook / effect would otherwise silently
  // no-op-or-worse without `displayedTicket` set.
  const patch = (updates: Partial<UpdateTicketPayload>) => {
    if (!displayedTicket) return;
    if (displayedTicket.ticket_kind === 'work_order') {
      patchWorkOrder(updates);
      return;
    }
    updateTicket.mutate(updates as UpdateTicketPayload, {
      onError: (err) => {
        const field = Object.keys(updates)[0] ?? 'field';
        toastError(`Couldn't update ${field}`, {
          error: err,
          retry: () => patch(updates),
        });
      },
    });
  };

  // Work-order PATCH — narrow the case-shaped payload to the fields the
  // work-order endpoint accepts. Slice 3 deferred fields (cost / tags /
  // watchers / title / description) silently no-op for work_orders here
  // because the orchestrator does not accept them.
  const patchWorkOrder = (updates: Partial<UpdateTicketPayload>) => {
    const woUpdates: UpdateWorkOrderPayload = {};
    if (updates.sla_id !== undefined) woUpdates.sla_id = updates.sla_id;
    if (updates.status !== undefined) woUpdates.status = updates.status;
    if (updates.status_category !== undefined) woUpdates.status_category = updates.status_category;
    if (updates.waiting_reason !== undefined) woUpdates.waiting_reason = updates.waiting_reason;
    if (updates.priority !== undefined) {
      woUpdates.priority = updates.priority as 'low' | 'medium' | 'high' | 'critical';
    }
    if (updates.assigned_team_id !== undefined) woUpdates.assigned_team_id = updates.assigned_team_id;
    if (updates.assigned_user_id !== undefined) woUpdates.assigned_user_id = updates.assigned_user_id;
    if (updates.assigned_vendor_id !== undefined) woUpdates.assigned_vendor_id = updates.assigned_vendor_id;

    if (Object.keys(woUpdates).length === 0) return;

    updateWorkOrder.mutate(woUpdates, {
      onError: (err) => {
        const field = Object.keys(woUpdates)[0] ?? 'field';
        toastError(`Couldn't update ${field}`, {
          error: err,
          retry: () => updateWorkOrder.mutate(woUpdates),
        });
      },
    });
  };

  type AssignmentTarget = {
    kind: 'team' | 'user' | 'vendor';
    id: string | null;
    nextLabel: string | null;
    previousLabel: string | null;
  };

  const updateAssignment = (target: AssignmentTarget) => {
    if (!displayedTicket) return;

    const field = target.kind === 'team'
      ? 'assigned_team_id'
      : target.kind === 'user'
        ? 'assigned_user_id'
        : 'assigned_vendor_id';

    const isWorkOrder = displayedTicket.ticket_kind === 'work_order';

    // First-time assignment — silent PATCH, no routing_decisions audit needed.
    if (target.previousLabel === null) {
      if (isWorkOrder) {
        updateWorkOrder.mutate({ [field]: target.id } as UpdateWorkOrderPayload, {
          onError: (err) => toastError(`Couldn't assign ${target.kind}`, {
            error: err,
            retry: () => updateAssignment(target),
          }),
        });
      } else {
        updateTicket.mutate({ [field]: target.id } as UpdateTicketPayload, {
          onError: (err) => toastError(`Couldn't assign ${target.kind}`, {
            error: err,
            retry: () => updateAssignment(target),
          }),
        });
      }
      return;
    }

    // Reassignment — POST /reassign so the server records a routing_decisions row.
    const actorName = person ? `${person.first_name} ${person.last_name}`.trim() : 'an agent';
    const reason = `Reassigned ${target.kind} from ${target.previousLabel} to ${target.nextLabel ?? 'unassigned'} by ${actorName} via ticket sidebar`;

    const reassignVars = {
      kind: target.kind,
      id: target.id,
      nextLabel: target.nextLabel,
      previousLabel: target.previousLabel,
      reason,
      actorPersonId: person?.id,
    };
    const reassignOpts = {
      onError: (err: Error) => toastError(`Couldn't reassign ${target.kind}`, {
        error: err,
        retry: () => updateAssignment(target),
      }),
    };

    if (isWorkOrder) {
      reassignWorkOrder.mutate(reassignVars, reassignOpts);
    } else {
      reassignTicket.mutate(reassignVars, reassignOpts);
    }
  };

  const displayedTicket = ticket;

  const handleSubmitComment = () => {
    const trimmedComment = commentText.trim();
    if (!trimmedComment && attachmentFiles.length === 0) return;

    addActivity.mutate(
      { content: trimmedComment, visibility: commentVisibility, files: attachmentFiles },
      {
        onSuccess: () => {
          setCommentText('');
          setAttachmentFiles([]);
          if (attachmentInputRef.current) attachmentInputRef.current.value = '';
          closeMentionMenu();
          toastSuccess(commentVisibility === 'internal' ? 'Note added' : 'Reply sent');
        },
        onError: (err) => toastError(
          commentVisibility === 'internal' ? "Couldn't add note" : "Couldn't send reply",
          { error: err, retry: handleSubmitComment },
        ),
      },
    );
  };

  const closeMentionMenu = () => {
    setMentionMatch(null);
    setMentionIndex(0);
  };

  const syncMentionMatch = (text: string, caret: number | null) => {
    if (caret === null) {
      closeMentionMenu();
      return;
    }

    const nextMatch = getActiveMention(text, caret);
    if (!nextMatch) {
      closeMentionMenu();
      return;
    }

    setMentionMatch(nextMatch);
  };

  const selectMention = (person: MentionPerson) => {
    if (!mentionMatch) return;

    const mentionLabel = `@${getPersonLabel(person)}`;
    const nextText =
      commentText.slice(0, mentionMatch.start) +
      `${mentionLabel} ` +
      commentText.slice(mentionMatch.end);
    const nextCaret = mentionMatch.start + mentionLabel.length + 1;

    setCommentText(nextText);
    closeMentionMenu();

    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(nextCaret, nextCaret);
    });
  };

  // Debounce the mention query so fast typing doesn't fire a request per keystroke.
  // mentionPending tracks the in-flight debounce window so the dropdown shows
  // the spinner *immediately* on keystroke — otherwise stale results from the
  // previous query would remain visible for the full 180ms window.
  const [debouncedMentionQuery, setDebouncedMentionQuery] = useState('');
  const [mentionPending, setMentionPending] = useState(false);
  useEffect(() => {
    const q = mentionMatch?.query ?? '';
    if (q !== debouncedMentionQuery) setMentionPending(true);
    const t = setTimeout(() => {
      setDebouncedMentionQuery(q);
      setMentionPending(false);
    }, 180);
    return () => clearTimeout(t);
    // debouncedMentionQuery intentionally omitted — we only fire on query change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mentionMatch?.query]);

  const { data: remoteMentionResults, isFetching: mentionRemoteFetching } = usePersonsSearch(debouncedMentionQuery);
  const mentionLoading = mentionMatch !== null
    && mentionMatch.query.trim().length >= 2
    && (mentionPending || mentionRemoteFetching);

  // Derive the displayed mention list: server results (when available) → local filter fallback.
  const mentionResults: MentionPerson[] = mentionMatch === null
    ? []
    : mentionMatch.query.trim().length < 2
      ? filterMentionPeople(people ?? [], mentionMatch.query)
      : (remoteMentionResults ?? filterMentionPeople(people ?? [], mentionMatch.query)).slice(0, MAX_MENTION_RESULTS);

  useEffect(() => {
    if (mentionIndex < mentionResults.length) return;
    setMentionIndex(0);
  }, [mentionIndex, mentionResults.length]);

  const mentionOpen = Boolean(mentionMatch);
  const canSubmitComment = Boolean(commentText.trim() || attachmentFiles.length > 0) && !submittingComment;

  if (ticketError && !ticket) {
    const isForbidden = ticketError instanceof ApiError && ticketError.status === 403;
    const isNotFound = ticketError instanceof ApiError && ticketError.status === 404;
    return (
      <div className="flex h-full items-center justify-center">
        <div className="p-6 max-w-[480px] mx-auto text-center">
          <h2 className="text-lg font-semibold mb-2">
            {isForbidden
              ? 'You do not have access to this ticket'
              : isNotFound
                ? 'Ticket not found'
                : 'Failed to load ticket'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isForbidden
              ? "Your role does not include this ticket. Contact an admin if you believe this is a mistake."
              : isNotFound
                ? "This ticket may have been deleted or never existed."
                : ticketError.message}
          </p>
        </div>
      </div>
    );
  }

  if (ticketPending || !ticket) {
    // Main-column skeleton only. We don't render a sidebar skeleton
    // because the real ResizablePanel uses a persisted layout we can't
    // mirror here cheaply — a fixed-width skeleton would jump when the
    // panel hydrates. The sidebar simply slides in when data arrives.
    return (
      <div className="flex h-full">
        <div className="flex-1 min-w-0 overflow-hidden">
          <div className="mx-auto w-full max-w-[960px] px-6 pb-10 sm:px-8 pt-8 space-y-5">
            <div className="portal-skeleton h-3 w-20 rounded" />
            <div className="portal-skeleton h-9 w-2/3 rounded" />
            <div className="flex flex-wrap gap-2">
              <div className="portal-skeleton h-5 w-24 rounded-full" />
              <div className="portal-skeleton h-5 w-32 rounded-full" />
              <div className="portal-skeleton h-5 w-28 rounded-full" />
            </div>
            <div className="portal-skeleton h-20 rounded-md" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      defaultLayout={sidebarLayout}
      onLayoutChanged={persistSidebarLayout}
      className="h-full"
    >
      {/* Main content */}
      <ResizablePanel id="main" minSize="480px" className="flex flex-col min-w-0 relative overflow-hidden">
        {/* Background-refetch indicator — sliding indeterminate segment.
            Reads as "fetching" rather than the ambiguous "thinking" pulse;
            also matches what users see in Linear/Vercel during refetches. */}
        {ticketFetching && (
          <div className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden">
            <div className="desk-progress-slide h-full w-1/3 rounded-full bg-primary/60" />
          </div>
        )}
        {/* Top actions */}
        <div className="flex items-center gap-1 px-6 py-2 shrink-0">
          {onClose && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onClose}
              aria-label="Close ticket detail"
              title="Close"
            >
              <XIcon className="h-4 w-4" />
            </Button>
          )}
          <div className="flex-1" />
          {onExpand && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={onExpand}
              title="Open full view"
              aria-label="Open full view"
            >
              <Maximize2 className="h-4 w-4" />
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <Button
                  {...props}
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  aria-label="Ticket actions"
                  title="More actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              )}
            />
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem
                disabled={
                  !displayedTicket
                  || displayedTicket.ticket_kind !== 'case'
                  || displayedTicket.status_category === 'closed'
                  || displayedTicket.status_category === 'resolved'
                }
                onClick={() => setReclassifyOpen(true)}
              >
                Change request type
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <ScrollArea className="flex-1">
          {/* desk-stagger composes the page section-by-section on mount.
              Re-renders from refetches don't re-fire because the children
              keep their identity across React reconciles. */}
          <div className="desk-stagger mx-auto w-full max-w-[960px] px-6 pb-10 sm:px-8">
            {/* Reference number — copy-able, non-editable */}
            <code
              data-chip
              className="font-mono text-xs text-muted-foreground tabular-nums mb-1 inline-block"
            >
              {formatTicketRef(displayedTicket!.ticket_kind, displayedTicket!.module_number)}
            </code>

            {/* Title */}
            <InlineTextEditor
              value={displayedTicket!.title}
              placeholder="Untitled"
              singleLine
              onSave={(next) => { if (next) patch({ title: next }); }}
              renderView={(v) => <h1 className="text-2xl font-semibold leading-tight tracking-tight">{v || 'Untitled'}</h1>}
              editorClassName="text-2xl font-semibold leading-tight tracking-tight border-0 shadow-none focus-visible:ring-0 px-0"
              viewClassName="rounded-md"
            />

            <TicketMetaRow
              ticketId={displayedTicket!.id}
              ticketKind={displayedTicket!.ticket_kind}
              parentTicketId={displayedTicket!.parent_ticket_id}
              priority={displayedTicket!.priority}
              requestType={displayedTicket!.request_type ?? null}
              requester={displayedTicket!.requester ?? null}
              location={displayedTicket!.location ?? null}
              reclassifiedAt={displayedTicket!.reclassified_at ?? null}
              reclassifiedReason={displayedTicket!.reclassified_reason ?? null}
              onOpenTicket={onOpenTicket}
            />

            {/* Description */}
            <div className="mt-5">
              <InlineTextEditor
                value={displayedTicket!.description ?? ''}
                placeholder="Add a description..."
                onSave={(next) => patch({ description: next })}
                renderView={(v) => v
                  ? <p className="text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap">{v}</p>
                  : <p className="text-[15px] text-muted-foreground/60">Add a description...</p>}
                editorClassName="text-[15px] leading-relaxed min-h-[80px]"
              />
            </div>

            {displayedTicket?.form_data && Object.keys(displayedTicket.form_data).length > 0 && (
              <div className="mt-8 space-y-3">
                <h3 className="text-sm font-medium">Custom fields</h3>
                <div className="grid gap-3 rounded-md border p-4 bg-muted/20">
                  {Object.entries(displayedTicket.form_data).map(([key, value]) => {
                    const field = schemaFields.find((f) => f.id === key);
                    const label = field?.label ?? key;
                    const archived = !field;
                    return (
                      <div key={key} className="grid grid-cols-[180px_1fr] gap-2 text-sm">
                        <span className="text-muted-foreground">
                          {label}
                          {archived && <span className="ml-2 text-xs italic">(archived)</span>}
                        </span>
                        <span>{formatFormValue(field, value)}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {displayedTicket?.ticket_kind === 'case' && (
              <SubIssuesSection
                parentId={displayedTicket.id}
                onAddClick={() => setAddWorkOrderOpen(true)}
                refreshNonce={workOrdersNonce}
                teams={teamOptions}
                users={users ?? []}
                vendors={vendorOptions}
                onOpenTicket={onOpenTicket}
              />
            )}

            <Separator className="my-8" />

            {/* Activity */}
            <div className="flex items-center justify-between mb-6">
              <span className="text-sm font-medium">Activity</span>
            </div>

            <TicketActivityFeed activities={activities ?? []} />

            {displayedTicket?.ticket_kind === 'case' && (
              <AddSubIssueDialog
                open={addWorkOrderOpen}
                onOpenChange={setAddWorkOrderOpen}
                parentId={displayedTicket.id}
                parentPriority={displayedTicket.priority ?? 'medium'}
                teamOptions={teamOptions}
                userOptions={userOptions}
                vendorOptions={vendorOptions}
                onDispatched={() => {
                  setWorkOrdersNonce((n) => n + 1);
                  refetchTicket();
                }}
              />
            )}

            {displayedTicket?.ticket_kind === 'case' && (
              <ReclassifyTicketDialog
                open={reclassifyOpen}
                onOpenChange={setReclassifyOpen}
                ticketId={displayedTicket.id}
                currentRequestType={displayedTicket.request_type ?? null}
                onReclassified={() => {
                  setWorkOrdersNonce((n) => n + 1);
                  refetchTicket();
                  refetchActivities();
                }}
              />
            )}

            {/* Comment input */}
            <div className="mt-10">
              <Tabs value={commentVisibility} onValueChange={(v) => setCommentVisibility(v as 'internal' | 'external')}>
                <TabsList className="mb-3">
                  <TabsTrigger value="internal"><MessageSquare className="h-4 w-4 mr-1.5" /> Internal note</TabsTrigger>
                  <TabsTrigger value="external"><Send className="h-4 w-4 mr-1.5" /> Reply</TabsTrigger>
                </TabsList>
              </Tabs>
              <div
                className="
                  rounded-lg border border-border/70 bg-card/70
                  transition-[border-color,box-shadow]
                  focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/40
                "
                style={{ transitionTimingFunction: 'var(--ease-portal)', transitionDuration: 'var(--dur-portal-press)' }}
              >
                <div className="relative">
                  <Textarea
                    ref={textareaRef}
                    className="min-h-[116px] resize-none border-0 bg-transparent px-4 py-3 text-[15px] leading-6 shadow-none focus-visible:ring-0"
                    placeholder={commentVisibility === 'internal' ? 'Add internal note... Use @ to mention someone.' : 'Reply to requester...'}
                    rows={4}
                    value={commentText}
                    onChange={(e) => {
                      const nextText = e.target.value;
                      const nextCaret = e.target.selectionStart;
                      setCommentText(nextText);
                      syncMentionMatch(nextText, nextCaret);
                    }}
                    onKeyUp={(e) => {
                      // Caret-only moves (arrows / home / end) don't fire onChange, so
                      // keep the mention state in sync from the keyboard too.
                      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') {
                        syncMentionMatch(e.currentTarget.value, e.currentTarget.selectionStart);
                      }
                    }}
                    onBlur={() => {
                      // Close on blur, but defer so a mouse-click on a suggestion item
                      // (which blurs the textarea before its onMouseDown) still registers.
                      setTimeout(closeMentionMenu, 120);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        handleSubmitComment();
                        return;
                      }

                      if (!mentionOpen) return;

                      if (e.key === 'ArrowDown' && mentionResults.length > 0) {
                        e.preventDefault();
                        setMentionIndex((current) => (current + 1) % mentionResults.length);
                        return;
                      }

                      if (e.key === 'ArrowUp' && mentionResults.length > 0) {
                        e.preventDefault();
                        setMentionIndex((current) => (current - 1 + mentionResults.length) % mentionResults.length);
                        return;
                      }

                      if ((e.key === 'Enter' || e.key === 'Tab') && mentionResults[mentionIndex]) {
                        e.preventDefault();
                        selectMention(mentionResults[mentionIndex]);
                        return;
                      }

                      if (e.key === 'Escape') {
                        e.preventDefault();
                        closeMentionMenu();
                      }
                    }}
                  />
                  {mentionOpen && (
                    <div
                      role="listbox"
                      aria-label="Mention suggestions"
                      className="
                        absolute left-3 top-full z-20 mt-1 w-[340px]
                        overflow-hidden rounded-lg border border-border/70 bg-popover p-1 shadow-lg
                        animate-in fade-in-0 zoom-in-95
                      "
                      style={{
                        transformOrigin: 'top left',
                        animationDuration: '150ms',
                        animationTimingFunction: 'var(--ease-portal)',
                      }}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {mentionLoading && (
                        <div className="flex items-center justify-center py-6">
                          <Spinner />
                        </div>
                      )}
                      {!mentionLoading && mentionResults.length === 0 && (
                        <div className="px-2 py-3 text-left text-xs text-muted-foreground">
                          No people found.
                        </div>
                      )}
                      {!mentionLoading && mentionResults.length > 0 && (
                        <>
                          <div className="px-2 pt-2 pb-1 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                            {mentionMatch?.query ? 'People' : 'Suggested'}
                          </div>
                          <div className="max-h-64 overflow-y-auto">
                            {mentionResults.map((person, index) => (
                              <div
                                key={person.id}
                                role="option"
                                aria-selected={index === mentionIndex}
                                className={cn(
                                  'mx-1 flex cursor-pointer items-center rounded-sm px-2 py-1.5',
                                  index === mentionIndex && 'bg-accent text-accent-foreground',
                                )}
                                onMouseEnter={() => setMentionIndex(index)}
                                onClick={() => selectMention(person)}
                              >
                                <PickerItemBody
                                  leading={<PersonAvatar size="sm" person={person} />}
                                  label={getPersonLabel(person)}
                                  sublabel={person.email ?? person.department ?? null}
                                />
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {attachmentFiles.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-3 pb-2">
                    {attachmentFiles.map((file, index) => (
                      <div
                        key={`${file.name}-${file.size}-${index}`}
                        className="inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/30 px-2 py-1 text-xs"
                      >
                        <Paperclip className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="max-w-[220px] truncate font-medium">{file.name}</span>
                        <span className="text-muted-foreground">{formatFileSize(file.size)}</span>
                        <button
                          type="button"
                          className="text-muted-foreground transition-colors hover:text-foreground"
                          onClick={() => {
                            setAttachmentFiles((current) => current.filter((_, currentIndex) => currentIndex !== index));
                            if (attachmentInputRef.current && attachmentFiles.length === 1) {
                              attachmentInputRef.current.value = '';
                            }
                          }}
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-center justify-between px-3 py-2">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Type @ to mention teammates.</span>
                    <span className="hidden sm:inline">Tab selects.</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      ref={attachmentInputRef}
                      type="file"
                      multiple
                      className="hidden"
                      onChange={(e) => {
                        const nextFiles = Array.from(e.target.files ?? []);
                        if (nextFiles.length === 0) return;

                        setAttachmentFiles((current) => {
                          const existing = new Set(current.map((file) => `${file.name}-${file.size}-${file.lastModified}`));
                          const uniqueNext = nextFiles.filter(
                            (file) => !existing.has(`${file.name}-${file.size}-${file.lastModified}`),
                          );
                          return [...current, ...uniqueNext];
                        });
                      }}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 rounded-lg"
                      onClick={() => attachmentInputRef.current?.click()}
                      aria-label="Attach file"
                      title="Attach file"
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </Button>
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">Cmd+Enter to send</span>
                    <Button
                      onClick={handleSubmitComment}
                      disabled={!canSubmitComment}
                      size="icon"
                      className="h-8 w-8 rounded-lg"
                      aria-label="Send comment"
                      title="Send (⌘ + Enter)"
                    >
                      {submittingComment ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </ResizablePanel>

      <ResizableHandle className="w-px bg-border/60 transition-colors hover:bg-border data-[resize-handle-state=drag]:bg-primary/40 data-[resize-handle-state=hover]:bg-border" />

      {/* Properties sidebar (right) */}
      <ResizablePanel
        id="sidebar"
        defaultSize="320px"
        minSize="240px"
        maxSize="560px"
        className="overflow-y-auto"
      >
        <div className="space-y-2 p-3">
          <SidebarGroup title="Properties">
          <InlineProperty label="Status">
            <Select
              value={displayedTicket!.status_category}
              onValueChange={(v) => { if (v) patch({ status_category: v, status: v }); }}
            >
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(statusConfig).map(([key, cfg]) => (
                  <SelectItem key={key} value={key}>
                    <span className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${cfg.dotColor}`} /> {cfg.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineProperty>

          <InlineProperty label="Priority">
            <Select
              value={displayedTicket!.priority}
              onValueChange={(v) => { if (v) patch({ priority: v }); }}
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(priorityConfig).map(([key]) => (
                  <SelectItem key={key} value={key}>
                    <PriorityIcon priority={key} withLabel />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineProperty>

          {displayedTicket!.status_category === 'waiting' && (
            <InlineProperty label="Waiting reason">
              <Select
                value={displayedTicket!.waiting_reason ?? ''}
                onValueChange={(v) => patch({ waiting_reason: v || null })}
              >
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="Select reason" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="requester">Awaiting requester</SelectItem>
                  <SelectItem value="vendor">Awaiting vendor</SelectItem>
                  <SelectItem value="approval">Awaiting approval</SelectItem>
                  <SelectItem value="scheduled_work">Scheduled work</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </InlineProperty>
          )}

          <InlineProperty label="Team">
            <EntityPicker
              value={displayedTicket!.assigned_team?.id ?? null}
              options={teamOptions}
              placeholder="team"
              clearLabel="Clear team"
              onChange={(option) => {
                updateAssignment({
                  kind: 'team',
                  id: option?.id ?? null,
                  nextLabel: option?.label ?? null,
                  previousLabel: displayedTicket!.assigned_team?.name ?? null,
                });
              }}
            />
          </InlineProperty>

          <InlineProperty label="Assignee" icon={<User className="h-3 w-3 text-muted-foreground" />}>
            <EntityPicker
              value={displayedTicket!.assigned_agent?.id ?? null}
              options={userOptions}
              placeholder="assignee"
              clearLabel="Clear assignee"
              onChange={(option) => {
                updateAssignment({
                  kind: 'user',
                  id: option?.id ?? null,
                  nextLabel: option?.label ?? null,
                  previousLabel: displayedTicket!.assigned_agent?.email ?? null,
                });
              }}
            />
          </InlineProperty>
          </SidebarGroup>

          {displayedTicket!.ticket_kind === 'work_order' && (
            <SidebarGroup title="Plan">
              <InlineProperty label="Planned start">
                <PlanField
                  value={{
                    startsAt: displayedTicket!.planned_start_at ?? null,
                    durationMinutes: displayedTicket!.planned_duration_minutes ?? null,
                  }}
                  onChange={handlePlanChange}
                  disabled={!canPlan}
                  dueAt={displayedTicket!.sla_resolution_due_at}
                />
              </InlineProperty>
            </SidebarGroup>
          )}

          <SidebarGroup title="SLA">
            {displayedTicket!.ticket_kind === 'work_order' && (
              <InlineProperty label="Policy">
                <Select
                  value={displayedTicket!.sla_id ?? '__none__'}
                  onValueChange={(v) => {
                    const next = v === '__none__' ? null : v;
                    if (next === displayedTicket!.sla_id) return;
                    // Plan-reviewer P1: SLA edits on work_orders go through
                    // the unified PATCH /work-orders/:id endpoint. The
                    // server orchestrator dispatches the SLA branch (which
                    // still enforces the sla.override danger gate inside
                    // updateSla).
                    updateWorkOrder.mutate({ sla_id: next }, {
                      onError: (err) =>
                        toastError("Couldn't update SLA", {
                          error: err,
                          retry: () => updateWorkOrder.mutate({ sla_id: next }),
                        }),
                    });
                  }}
                >
                  <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="No SLA" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No SLA</SelectItem>
                    {(slaPolicies ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineProperty>
            )}
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Resolution</div>
              <SlaTimer dueAt={displayedTicket!.sla_resolution_due_at} breachedAt={displayedTicket!.sla_resolution_breached_at} />
            </div>
            <TicketSlaEscalations ticketId={displayedTicket!.id} />
          </SidebarGroup>

          <SidebarGroup title="Requester">
          {/* Requester */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Requester</div>
            {displayedTicket!.requester ? (
              <div>
                <div className="text-sm font-medium">{displayedTicket!.requester.first_name} {displayedTicket!.requester.last_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{displayedTicket!.requester.email}</div>
                {displayedTicket!.requester.department && <div className="text-xs text-muted-foreground">{displayedTicket!.requester.department}</div>}
              </div>
            ) : <span className="text-sm text-muted-foreground">Unknown</span>}
          </div>

          {/* Location */}
          {displayedTicket!.location && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Location</div>
              <div className="text-sm flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                {displayedTicket!.location.name}
              </div>
            </div>
          )}

          {/* Asset */}
          {displayedTicket!.asset && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Asset</div>
              <div className="text-sm">{displayedTicket!.asset.name}</div>
              <div className="text-xs text-muted-foreground">{displayedTicket!.asset.serial_number}</div>
            </div>
          )}
          </SidebarGroup>

          <SidebarGroup title="Labels">
          <InlineProperty label="Labels" icon={<TagIcon className="h-3 w-3" />}>
            <MultiSelectPicker
              values={displayedTicket!.tags ?? []}
              options={tagOptions}
              placeholder="label"
              allowCreate
              onChange={(next) => patch({ tags: next })}
            />
          </InlineProperty>

          <InlineProperty label="Watchers">
            <MultiSelectPicker
              values={displayedTicket!.watchers ?? []}
              options={watcherOptions}
              placeholder="watcher"
              onChange={(next) => patch({ watchers: next })}
            />
          </InlineProperty>

          <InlineProperty label="Cost">
            <NumberEditor
              value={displayedTicket!.cost ?? null}
              placeholder="cost"
              prefix="$"
              formatDisplay={(v) => v == null ? '' : `$${v.toFixed(2)}`}
              onChange={(next) => patch({ cost: next })}
            />
          </InlineProperty>
          </SidebarGroup>

          <SidebarGroup title="Details">
          {/* Request type */}
          {displayedTicket!.request_type && (
            <InlineProperty label="Type">
              {displayedTicket!.ticket_kind === 'case'
                && displayedTicket!.status_category !== 'closed'
                && displayedTicket!.status_category !== 'resolved' ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setReclassifyOpen(true);
                  }}
                  title="Click to change request type"
                  className="group flex h-8 w-full items-center justify-between rounded-md border border-input bg-background px-2.5 text-sm hover:bg-accent hover:border-accent-foreground/20 transition-colors cursor-pointer"
                >
                  <span className="truncate">{displayedTicket!.request_type.name}</span>
                  <span className="text-xs text-muted-foreground opacity-60 group-hover:opacity-100 ml-2 shrink-0">
                    change →
                  </span>
                </button>
              ) : (
                <div className="text-sm py-1">{displayedTicket!.request_type.name}</div>
              )}
            </InlineProperty>
          )}

          {displayedTicket!.interaction_mode === 'external' && (
            <InlineProperty label="Vendor">
              <EntityPicker
                value={displayedTicket!.assigned_vendor?.id ?? null}
                options={activeVendorOptions}
                placeholder="vendor"
                clearLabel="Clear vendor"
                onChange={(option) => {
                  updateAssignment({
                    kind: 'vendor',
                    id: option?.id ?? null,
                    nextLabel: option?.label ?? null,
                    previousLabel: displayedTicket!.assigned_vendor?.name ?? null,
                  });
                }}
              />
            </InlineProperty>
          )}

          {/* Workflow */}
          <WorkflowSection ticketId={ticketId} />

          {/* Created */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Created</div>
            <div className="text-sm">{formatFullTimestamp(displayedTicket!.created_at)}</div>
          </div>
          </SidebarGroup>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function WorkflowSection({ ticketId }: { ticketId: string }) {
  const { data: instances } = useTicketWorkflowInstances(ticketId);
  const first = instances?.[0];
  if (!first) return null;

  return (
    <div>
      <div className="text-xs text-muted-foreground mb-1.5">Workflow</div>
      <Link
        to={`/admin/workflow-templates/instances/${first.id}`}
        className="text-sm hover:underline flex items-center gap-2"
      >
        <Badge variant={first.status === 'completed' ? 'default' : first.status === 'waiting' ? 'secondary' : 'outline'} className="capitalize text-[10px]">
          {first.status}
        </Badge>
        <span className="text-xs text-muted-foreground">View →</span>
      </Link>
    </div>
  );
}
