import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Clock,
  MapPin,
  User,
  AlertTriangle,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

interface TicketData {
  id: string;
  title: string;
  description: string;
  status: string;
  status_category: string;
  priority: string;
  waiting_reason: string | null;
  interaction_mode: string;
  tags: string[];
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
}

interface Activity {
  id: string;
  activity_type: string;
  visibility: string;
  content: string;
  author?: { first_name: string; last_name: string };
  metadata: Record<string, unknown> | null;
  created_at: string;
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

export function TicketDetail({ ticketId, onClose }: { ticketId: string; onClose?: () => void }) {
  const { data: ticket, loading: ticketLoading, refetch: refetchTicket } = useApi<TicketData>(`/tickets/${ticketId}`, [ticketId]);
  const { data: activities, refetch: refetchActivities } = useApi<Activity[]>(`/tickets/${ticketId}/activities`, [ticketId]);
  const { data: teams } = useApi<Array<{ id: string; name: string }>>('/teams', []);
  const [commentText, setCommentText] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<'internal' | 'external'>('internal');

  const updateTicket = async (updates: Record<string, unknown>) => {
    await apiFetch(`/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(updates) });
    refetchTicket();
  };

  if (ticketLoading || !ticket) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading...</div>;
  }

  const handleSubmitComment = async () => {
    if (!commentText.trim()) return;
    await fetch(`/api/tickets/${ticketId}/activities`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        activity_type: commentVisibility === 'internal' ? 'internal_note' : 'external_comment',
        visibility: commentVisibility,
        content: commentText,
      }),
    });
    setCommentText('');
    refetchActivities();
  };

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
          <Button variant="ghost" size="icon" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button>
        </div>

        <ScrollArea className="flex-1">
          <div className="px-8 pb-10 max-w-3xl">
            {/* Title */}
            <h1 className="text-2xl font-semibold leading-tight tracking-tight">{ticket.title}</h1>

            {/* Description */}
            {ticket.description ? (
              <p className="mt-5 text-[15px] leading-relaxed text-foreground/80 whitespace-pre-wrap">{ticket.description}</p>
            ) : (
              <p className="mt-5 text-[15px] text-muted-foreground/60 cursor-pointer hover:text-muted-foreground">Add a description...</p>
            )}

            {/* Sub-issues placeholder */}
            <div className="mt-10">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-sm font-medium">Sub-issues</span>
                <span className="text-xs text-muted-foreground">0/0</span>
                <button className="ml-auto text-xs text-muted-foreground hover:text-foreground">+</button>
              </div>
              <div className="text-sm text-muted-foreground/50 py-2">No sub-issues yet</div>
            </div>

            <Separator className="my-8" />

            {/* Activity */}
            <div className="flex items-center justify-between mb-6">
              <span className="text-sm font-medium">Activity</span>
            </div>

            <div className="space-y-6">
              {(activities ?? []).map((activity) => (
                <div key={activity.id} className="flex gap-4">
                  <div className="shrink-0 mt-0.5">
                    {activity.visibility === 'system' ? (
                      <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center">
                        <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      </div>
                    ) : (
                      <div className={`h-8 w-8 rounded-full flex items-center justify-center text-xs font-semibold ${
                        activity.visibility === 'internal'
                          ? 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400'
                          : 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                      }`}>
                        {activity.author?.first_name?.[0] ?? '?'}
                      </div>
                    )}
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
                    {activity.content && (
                      <p className="text-[15px] text-foreground/80 mt-1.5 leading-relaxed whitespace-pre-wrap">{activity.content}</p>
                    )}
                    {activity.metadata && activity.visibility === 'system' && (
                      <p className="text-xs text-muted-foreground mt-1">{(activity.metadata as Record<string, unknown>).event as string}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Comment input */}
            <div className="mt-10">
              <Tabs value={commentVisibility} onValueChange={(v) => setCommentVisibility(v as 'internal' | 'external')}>
                <TabsList className="mb-3">
                  <TabsTrigger value="internal"><MessageSquare className="h-4 w-4 mr-1.5" /> Internal note</TabsTrigger>
                  <TabsTrigger value="external"><Send className="h-4 w-4 mr-1.5" /> Reply</TabsTrigger>
                </TabsList>
              </Tabs>
              <div className="flex gap-3">
                <Textarea
                  className="flex-1 min-h-[80px] resize-none"
                  placeholder={commentVisibility === 'internal' ? 'Add internal note...' : 'Reply to requester...'}
                  rows={3}
                  value={commentText}
                  onChange={(e) => setCommentText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmitComment(); }}
                />
                <Button onClick={handleSubmitComment} disabled={!commentText.trim()} size="icon" className="self-end">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>
      </div>

      {/* Properties sidebar (right) */}
      <div className="w-[220px] shrink-0 border-l overflow-y-auto">
        <div className="p-5 space-y-5">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Properties</div>

          {/* Status */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Status</div>
            <Select value={ticket.status_category} onValueChange={(v) => { if (v) updateTicket({ status_category: v, status: v }); }}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
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
          </div>

          {/* Priority */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Priority</div>
            <Select value={ticket.priority} onValueChange={(v) => { if (v) updateTicket({ priority: v }); }}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(priorityConfig).map(([key, cfg]) => (
                  <SelectItem key={key} value={key}>
                    <span className={cfg.color}>{cfg.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Team */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Team</div>
            <Select value={ticket.assigned_team?.id ?? ''} onValueChange={(v) => { if (v) updateTicket({ assigned_team_id: v }); }}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                {(teams ?? []).map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Assignee */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Assignee</div>
            <div className="text-sm flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              {ticket.assigned_agent?.email ?? <span className="text-muted-foreground">Unassigned</span>}
            </div>
          </div>

          {/* SLA */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">SLA</div>
            <SlaTimer dueAt={ticket.sla_resolution_due_at} breachedAt={ticket.sla_resolution_breached_at} />
          </div>

          <Separator />

          {/* Requester */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Requester</div>
            {ticket.requester ? (
              <div>
                <div className="text-sm font-medium">{ticket.requester.first_name} {ticket.requester.last_name}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{ticket.requester.email}</div>
                {ticket.requester.department && <div className="text-xs text-muted-foreground">{ticket.requester.department}</div>}
              </div>
            ) : <span className="text-sm text-muted-foreground">Unknown</span>}
          </div>

          {/* Location */}
          {ticket.location && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Location</div>
              <div className="text-sm flex items-center gap-2">
                <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
                {ticket.location.name}
              </div>
            </div>
          )}

          {/* Asset */}
          {ticket.asset && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Asset</div>
              <div className="text-sm">{ticket.asset.name}</div>
              <div className="text-xs text-muted-foreground">{ticket.asset.serial_number}</div>
            </div>
          )}

          {/* Tags */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5 flex items-center gap-1.5">
              <TagIcon className="h-3 w-3" /> Labels
            </div>
            {ticket.tags && ticket.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {ticket.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">{tag}</Badge>
                ))}
              </div>
            ) : (
              <button className="text-sm text-muted-foreground hover:text-foreground">+ Add label</button>
            )}
          </div>

          <Separator />

          {/* Request type */}
          {ticket.request_type && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Type</div>
              <div className="text-sm">{ticket.request_type.name}</div>
            </div>
          )}

          {/* Interaction mode */}
          {ticket.interaction_mode === 'external' && (
            <div>
              <div className="text-xs text-muted-foreground mb-1.5">Mode</div>
              <Badge variant="outline" className="text-xs">External vendor</Badge>
            </div>
          )}

          {/* Workflow */}
          <WorkflowSection ticketId={ticketId} />

          {/* Created */}
          <div>
            <div className="text-xs text-muted-foreground mb-1.5">Created</div>
            <div className="text-sm">{new Date(ticket.created_at).toLocaleDateString('en-GB', {
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
