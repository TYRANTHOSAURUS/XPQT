import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { PersonAvatar } from '@/components/person-avatar';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Clock,
  MapPin,
  User,
  AlertTriangle,
  Download,
  FileText,
  Paperclip,
  MessageSquare,
  Send,
  BellOff,
  MoreHorizontal,
  Star,
  XIcon,
  TagIcon,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { useTicketMutation, UpdateTicketPayload } from '@/hooks/use-ticket-mutation';
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
import { TicketSlaEscalations } from '@/components/desk/ticket-sla-escalations';
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
import { toast } from 'sonner';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

function formatFormValue(field: FormField | undefined, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (field?.type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (field?.type === 'date') {
    try { return new Date(String(value)).toLocaleDateString(); } catch { return String(value); }
  }
  if (field?.type === 'datetime') {
    try { return new Date(String(value)).toLocaleString(); } catch { return String(value); }
  }
  return String(value);
}

interface TicketData {
  id: string;
  ticket_kind: 'case' | 'work_order';
  parent_ticket_id: string | null;
  title: string;
  description: string;
  status: string;
  status_category: string;
  priority: string;
  waiting_reason: string | null;
  interaction_mode: string;
  tags: string[];
  sla_id: string | null;
  sla_at_risk: boolean;
  sla_response_due_at: string | null;
  sla_resolution_due_at: string | null;
  sla_response_breached_at: string | null;
  sla_resolution_breached_at: string | null;
  created_at: string;
  requester?: { id: string; first_name: string; last_name: string; email: string; department: string };
  location?: { id: string; name: string; type: string };
  asset?: { id: string; name: string; serial_number: string };
  assigned_team?: { id: string; name: string };
  assigned_agent?: { id: string; email: string };
  request_type?: { id: string; name: string; domain: string };
  form_data?: Record<string, unknown> | null;
  cost?: number | null;
  watchers?: string[];
  assigned_vendor?: { id: string; name: string } | null;
  reclassified_at?: string | null;
  reclassified_reason?: string | null;
  reclassified_from_id?: string | null;
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

interface UserOption {
  id: string;
  email: string;
  person?: { first_name?: string; last_name?: string } | null;
}

interface VendorOption {
  id: string;
  name: string;
  active?: boolean;
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
}

function isImageAttachment(attachment: NonNullable<Activity['attachments']>[number]): boolean {
  if (attachment.type?.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(attachment.name);
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

export function TicketDetail({ ticketId, onClose, onOpenTicket }: { ticketId: string; onClose?: () => void; onOpenTicket?: (id: string) => void }) {
  const { data: ticket, loading: ticketLoading, error: ticketError, refetch: refetchTicket } = useApi<TicketData>(`/tickets/${ticketId}`, [ticketId]);
  const { data: activities, refetch: refetchActivities } = useApi<Activity[]>(`/tickets/${ticketId}/activities`, [ticketId]);
  const { data: teams } = useApi<Array<{ id: string; name: string }>>('/teams', []);
  const { data: people } = useApi<MentionPerson[]>('/persons', []);
  const { data: users } = useApi<UserOption[]>('/users', []);
  const { data: vendors } = useApi<VendorOption[]>('/vendors', []);
  const { data: tagSuggestions } = useApi<string[]>('/tickets/tags', []);
  const { data: slaPolicies } = useApi<Array<{ id: string; name: string }>>('/sla-policies', []);
  const [schemaFields, setSchemaFields] = useState<FormField[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<'internal' | 'external'>('internal');
  const [mentionMatch, setMentionMatch] = useState<MentionMatch | null>(null);
  const [mentionResults, setMentionResults] = useState<MentionPerson[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [submittingComment, setSubmittingComment] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const mentionSearchRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const [addWorkOrderOpen, setAddWorkOrderOpen] = useState(false);
  const [workOrdersNonce, setWorkOrdersNonce] = useState(0);
  const [reclassifyOpen, setReclassifyOpen] = useState(false);

  const [overlay, setOverlay] = useState<Partial<UpdateTicketPayload> | null>(null);
  const { patch, updateAssignment } = useTicketMutation({
    ticketId,
    refetch: refetchTicket,
    onOptimistic: setOverlay,
  });

  const displayedTicket = ticket && overlay
    ? ({ ...ticket, ...overlay } as TicketData)
    : ticket;

  const handleSubmitComment = async () => {
    const trimmedComment = commentText.trim();
    if (!trimmedComment && attachmentFiles.length === 0) return;

    setSubmittingComment(true);
    try {
      let attachments: Activity['attachments'] = [];

      if (attachmentFiles.length > 0) {
        const formData = new FormData();
        attachmentFiles.forEach((file) => formData.append('files', file));

        attachments = await apiFetch<Activity['attachments']>(`/tickets/${ticketId}/attachments`, {
          method: 'POST',
          body: formData,
        });
      }

      await apiFetch(`/tickets/${ticketId}/activities`, {
        method: 'POST',
        body: JSON.stringify({
          activity_type: commentVisibility === 'internal' ? 'internal_note' : 'external_comment',
          visibility: commentVisibility,
          content: trimmedComment || undefined,
          attachments,
        }),
      });

      setCommentText('');
      setAttachmentFiles([]);
      if (attachmentInputRef.current) attachmentInputRef.current.value = '';
      closeMentionMenu();
      refetchActivities();
      toast.success(commentVisibility === 'internal' ? 'Note added' : 'Reply sent');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to send comment');
    } finally {
      setSubmittingComment(false);
    }
  };

  const closeMentionMenu = () => {
    if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
    setMentionMatch(null);
    setMentionResults([]);
    setMentionLoading(false);
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

  useEffect(() => {
    const rtId = ticket?.request_type?.id;
    if (!rtId) { setSchemaFields([]); return; }
    let cancelled = false;
    apiFetch<{ form_schema_id?: string | null }>(`/request-types/${rtId}`)
      .then((rt) => {
        if (cancelled || !rt.form_schema_id) { setSchemaFields([]); return null; }
        return apiFetch<{ current_version?: { definition: { fields: FormField[] } } | null }>(
          `/config-entities/${rt.form_schema_id}`,
        );
      })
      .then((entity) => {
        if (cancelled || !entity) return;
        setSchemaFields(entity.current_version?.definition?.fields ?? []);
      })
      .catch(() => { if (!cancelled) setSchemaFields([]); });
    return () => { cancelled = true; };
  }, [ticket?.request_type?.id]);

  useEffect(() => {
    if (!mentionMatch) return;

    if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);

    const localResults = filterMentionPeople(people ?? [], mentionMatch.query);
    if (mentionMatch.query.trim().length < 2) {
      setMentionLoading(false);
      setMentionResults(localResults);
      setMentionIndex(0);
      return;
    }

    setMentionLoading(true);
    mentionSearchRef.current = setTimeout(() => {
      apiFetch<MentionPerson[]>(`/persons?search=${encodeURIComponent(mentionMatch.query)}`)
        .then((results) => {
          setMentionResults(results.slice(0, MAX_MENTION_RESULTS));
          setMentionIndex(0);
        })
        .catch(() => {
          setMentionResults(localResults);
          setMentionIndex(0);
        })
        .finally(() => setMentionLoading(false));
    }, 180);

    return () => {
      if (mentionSearchRef.current) clearTimeout(mentionSearchRef.current);
    };
  }, [mentionMatch, people]);

  useEffect(() => {
    if (mentionIndex < mentionResults.length) return;
    setMentionIndex(0);
  }, [mentionIndex, mentionResults.length]);

  const mentionOpen = Boolean(mentionMatch);
  const canSubmitComment = Boolean(commentText.trim() || attachmentFiles.length > 0) && !submittingComment;

  if (ticketLoading || !ticket) {
    if (ticketError) {
      const isForbidden = /403|forbidden/i.test(ticketError);
      return (
        <div className="flex h-full items-center justify-center">
          <div className="p-6 max-w-[480px] mx-auto text-center">
            <h2 className="text-lg font-semibold mb-2">
              {isForbidden ? 'You do not have access to this ticket' : 'Failed to load ticket'}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isForbidden
                ? "Your role does not include this ticket. Contact an admin if you believe this is a mistake."
                : ticketError}
            </p>
          </div>
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top actions */}
        <div className="flex items-center gap-1 px-6 py-2 shrink-0">
          {onClose && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onClose}>
              <XIcon className="h-4 w-4" />
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="ghost" size="icon" className="h-8 w-8"><Star className="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" className="h-8 w-8"><BellOff className="h-4 w-4" /></Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={(props) => (
                <Button {...props} variant="ghost" size="icon" className="h-8 w-8">
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
          <div className="mx-auto w-full max-w-[960px] px-6 pb-10 sm:px-8">
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
                <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Custom Fields</h3>
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
                teams={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
                users={users ?? []}
                vendors={(vendors ?? []).map((v) => ({ id: v.id, label: v.name }))}
                onOpenTicket={onOpenTicket}
              />
            )}

            <Separator className="my-8" />

            {/* Activity */}
            <div className="flex items-center justify-between mb-6">
              <span className="text-sm font-medium">Activity</span>
            </div>

            <div className="space-y-6">
              {(activities ?? []).map((activity) => {
                if (activity.visibility === 'system') {
                  const eventText =
                    (activity.metadata as Record<string, unknown> | null)?.event as string | undefined
                    ?? activity.content;
                  const who = activity.author
                    ? `${activity.author.first_name ?? ''} ${activity.author.last_name ?? ''}`.trim() || 'System'
                    : 'System';
                  return (
                    <div key={activity.id} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3 shrink-0" />
                      <span className="text-foreground/80 font-medium shrink-0">{who}</span>
                      <span className="truncate">{eventText}</span>
                      <span className="shrink-0">· {timeAgo(activity.created_at)}</span>
                    </div>
                  );
                }
                return (
                <div key={activity.id} className="flex gap-4">
                  <div className="shrink-0 mt-0.5">
                    <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold ${
                      activity.visibility === 'internal'
                        ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                        : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                    }`}>
                      {activity.author?.first_name?.[0] ?? '?'}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <div className="flex items-center gap-2">
                      {activity.author ? (
                        <span className="text-sm font-medium">{activity.author.first_name} {activity.author.last_name}</span>
                      ) : (
                        <span className="text-sm text-muted-foreground">System</span>
                      )}
                      {activity.visibility === 'internal' && (
                        <span className="text-[11px] text-yellow-600 dark:text-yellow-400">internal</span>
                      )}
                      <span className="text-xs text-muted-foreground">{timeAgo(activity.created_at)}</span>
                    </div>
                    {(activity.content || (activity.attachments?.length ?? 0) > 0) ? (
                      <div className="mt-2 overflow-hidden rounded-2xl border border-border/70 bg-card/80">
                        {activity.content && (
                          <div className="px-4 py-3">
                            <p className="text-[15px] leading-relaxed text-foreground/85 whitespace-pre-wrap">{activity.content}</p>
                          </div>
                        )}
                        {activity.attachments && activity.attachments.length > 0 && (
                          <div className={cn('grid gap-2 p-2', activity.content && 'border-t border-border/60')}>
                            {activity.attachments.map((attachment) => {
                              const key = `${activity.id}-${attachment.path ?? attachment.url ?? attachment.name}`;
                              const imageAttachment = isImageAttachment(attachment) && attachment.url;

                              if (imageAttachment) {
                                return (
                                  <a
                                    key={key}
                                    href={attachment.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="group overflow-hidden rounded-xl border border-border/70 bg-muted/20 transition-colors hover:bg-muted/40"
                                  >
                                    <img
                                      src={attachment.url}
                                      alt={attachment.name}
                                      loading="lazy"
                                      className="max-h-80 w-full bg-muted/40 object-cover"
                                    />
                                    <div className="flex items-center justify-between gap-3 px-3 py-2">
                                      <div className="min-w-0">
                                        <div className="truncate text-sm font-medium">{attachment.name}</div>
                                        <div className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</div>
                                      </div>
                                      <Download className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                                    </div>
                                  </a>
                                );
                              }

                              const attachmentContent = (
                                <>
                                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                                    <FileText className="h-4 w-4 text-muted-foreground" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium">{attachment.name}</div>
                                    <div className="text-xs text-muted-foreground">{formatFileSize(attachment.size)}</div>
                                  </div>
                                  {attachment.url && <Download className="h-4 w-4 shrink-0 text-muted-foreground" />}
                                </>
                              );

                              return attachment.url ? (
                                <a
                                  key={key}
                                  href={attachment.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/40"
                                >
                                  {attachmentContent}
                                </a>
                              ) : (
                                <div
                                  key={key}
                                  className="flex items-center gap-3 rounded-xl border border-border/70 bg-muted/20 px-3 py-2"
                                >
                                  {attachmentContent}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : null}
                  </div>
                </div>
                );
              })}
            </div>

            {displayedTicket?.ticket_kind === 'case' && (
              <AddSubIssueDialog
                open={addWorkOrderOpen}
                onOpenChange={setAddWorkOrderOpen}
                parentId={displayedTicket.id}
                parentPriority={displayedTicket.priority ?? 'medium'}
                teamOptions={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
                userOptions={(users ?? []).map((u) => ({
                  id: u.id,
                  label: u.person
                    ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email
                    : u.email,
                  sublabel: u.email,
                  leading: <PersonAvatar size="sm" person={u.person ?? { email: u.email }} />,
                }))}
                vendorOptions={(vendors ?? []).map((v) => ({ id: v.id, label: v.name }))}
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
              <div className="rounded-xl border border-border/70 bg-card/70 transition-shadow focus-within:shadow-md">
                <Popover open={mentionOpen} onOpenChange={(open) => { if (!open) closeMentionMenu(); }}>
                  <div className="relative">
                    <PopoverTrigger
                      render={<div aria-hidden="true" className="pointer-events-none absolute left-4 top-4 size-px opacity-0" />}
                    />
                    <Textarea
                      ref={textareaRef}
                      className="min-h-[116px] resize-none border-0 bg-transparent px-4 py-3 text-[15px] leading-6 shadow-none focus-visible:ring-0"
                      placeholder={commentVisibility === 'internal' ? 'Add internal note... Use @ to mention someone.' : 'Reply to requester...'}
                      rows={4}
                      value={commentText}
                      onChange={(e) => {
                        const nextText = e.target.value;
                        setCommentText(nextText);
                        syncMentionMatch(nextText, e.target.selectionStart);
                      }}
                      onSelect={(e) => syncMentionMatch(commentText, e.currentTarget.selectionStart)}
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
                  </div>
                  <PopoverContent
                    className="w-[340px] gap-0 rounded-xl border border-border/70 bg-popover p-1 shadow-lg"
                    align="start"
                    sideOffset={8}
                  >
                    <Command shouldFilter={false} className="rounded-lg bg-transparent p-0">
                      <CommandList className="max-h-64">
                        {mentionLoading && (
                          <div className="flex items-center justify-center py-6">
                            <Spinner />
                          </div>
                        )}
                        {!mentionLoading && mentionResults.length === 0 && (
                          <CommandEmpty className="py-4 text-left text-xs text-muted-foreground">
                            No people found.
                          </CommandEmpty>
                        )}
                        {!mentionLoading && mentionResults.length > 0 && (
                          <CommandGroup heading={mentionMatch?.query ? 'People' : 'Suggested'} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.08em]">
                            {mentionResults.map((person, index) => (
                              <CommandItem
                                key={person.id}
                                value={`${getPersonLabel(person)} ${person.email ?? ''}`}
                                className={cn(
                                  'mx-1 h-7 gap-2.5 rounded-sm px-2 text-sm',
                                  index === mentionIndex && 'bg-accent text-accent-foreground',
                                )}
                                onMouseEnter={() => setMentionIndex(index)}
                                onMouseDown={(e) => e.preventDefault()}
                                onSelect={() => selectMention(person)}
                              >
                                <PersonAvatar size="sm" className="size-5" person={person} />
                                <div className="min-w-0 flex-1">
                                  <div className="truncate font-medium">{getPersonLabel(person)}</div>
                                </div>
                                <div className="truncate text-[11px] text-muted-foreground">
                                  {person.email ?? person.department ?? 'Person'}
                                </div>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        )}
                      </CommandList>
                    </Command>
                  </PopoverContent>
                </Popover>
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
                    >
                      <Paperclip className="h-3.5 w-3.5" />
                    </Button>
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">Cmd+Enter to send</span>
                    <Button onClick={handleSubmitComment} disabled={!canSubmitComment} size="icon" className="h-8 w-8 rounded-lg">
                      {submittingComment ? <Spinner className="h-3.5 w-3.5" /> : <Send className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Properties sidebar (right) */}
      <div className="w-[320px] shrink-0 border-l overflow-y-auto">
        <div className="p-5 space-y-5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Properties</div>

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
              <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(priorityConfig).map(([key, cfg]) => (
                  <SelectItem key={key} value={key}>
                    <span className={cfg.color}>{cfg.label}</span>
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
              options={(teams ?? []).map((t) => ({ id: t.id, label: t.name }))}
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
              options={(users ?? []).map((u) => ({
                id: u.id,
                label: u.person ? `${u.person.first_name ?? ''} ${u.person.last_name ?? ''}`.trim() || u.email : u.email,
                sublabel: u.email,
                leading: <PersonAvatar size="sm" person={u.person ?? { email: u.email }} />,
              }))}
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

          {/* SLA */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">SLA</div>
            {displayedTicket!.ticket_kind === 'work_order' ? (
              <Select
                value={displayedTicket!.sla_id ?? '__none__'}
                onValueChange={(v) => {
                  const next = v === '__none__' ? null : v;
                  if (next !== displayedTicket!.sla_id) patch({ sla_id: next } as Partial<UpdateTicketPayload>);
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
            ) : null}
            <div className={displayedTicket!.ticket_kind === 'work_order' ? 'mt-2' : ''}>
              <SlaTimer dueAt={displayedTicket!.sla_resolution_due_at} breachedAt={displayedTicket!.sla_resolution_breached_at} />
            </div>
          </div>

          <TicketSlaEscalations ticketId={displayedTicket!.id} />

          <Separator />

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

          <InlineProperty label="Labels" icon={<TagIcon className="h-3 w-3" />}>
            <MultiSelectPicker
              values={displayedTicket!.tags ?? []}
              options={(tagSuggestions ?? []).map((t) => ({ id: t, label: t }))}
              placeholder="label"
              allowCreate
              onChange={(next) => patch({ tags: next })}
            />
          </InlineProperty>

          <InlineProperty label="Watchers">
            <MultiSelectPicker
              values={displayedTicket!.watchers ?? []}
              options={(people ?? []).map((p) => ({
                id: p.id,
                label: `${p.first_name} ${p.last_name}`.trim(),
                sublabel: p.email ?? null,
                leading: <PersonAvatar size="sm" person={p} />,
              }))}
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

          <Separator />

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
                options={(vendors ?? [])
                  .filter((v) => v.active !== false)
                  .map((v) => ({ id: v.id, label: v.name }))}
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
            <div className="text-sm">{new Date(displayedTicket!.created_at).toLocaleDateString('en-GB', {
              day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
            })}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface TicketInstance {
  id: string;
  status: string;
  current_node_id: string | null;
  workflow_definition_id: string;
}

function WorkflowSection({ ticketId }: { ticketId: string }) {
  const { data: instances } = useApi<TicketInstance[]>(`/workflows/instances/ticket/${ticketId}`, [ticketId]);
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
