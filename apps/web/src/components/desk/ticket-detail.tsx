import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Clock,
  MapPin,
  User,
  Users,
  AlertTriangle,
  MessageSquare,
  Send,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';

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

const priorityConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  critical: { label: 'Critical', variant: 'destructive' },
  high: { label: 'High', variant: 'destructive' },
  medium: { label: 'Medium', variant: 'default' },
  low: { label: 'Low', variant: 'secondary' },
};

const statusConfig: Record<string, { label: string; className: string }> = {
  new: { label: 'New', className: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300' },
  assigned: { label: 'Assigned', className: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300' },
  in_progress: { label: 'In Progress', className: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300' },
  waiting: { label: 'Waiting', className: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300' },
  resolved: { label: 'Resolved', className: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300' },
  closed: { label: 'Closed', className: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
};

function SlaTimer({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return null;

  if (breachedAt) {
    return (
      <span className="text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Breached
      </span>
    );
  }

  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) {
    return (
      <span className="text-xs font-medium text-red-600 dark:text-red-400 flex items-center gap-1">
        <AlertTriangle className="h-3 w-3" /> Overdue
      </span>
    );
  }

  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const totalMs = new Date(dueAt).getTime() - Date.now();
  const urgencyClass = totalMs < 3600000 ? 'text-red-600 dark:text-red-400' :
    totalMs < 7200000 ? 'text-yellow-600 dark:text-yellow-400' :
    'text-green-600 dark:text-green-400';

  return (
    <span className={`text-xs font-medium flex items-center gap-1 ${urgencyClass}`}>
      <Clock className="h-3 w-3" /> {timeStr}
    </span>
  );
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function TicketDetail({ ticketId }: { ticketId: string }) {
  const { data: ticket, loading: ticketLoading } = useApi<TicketData>(`/tickets/${ticketId}`, [ticketId]);
  const { data: activities, refetch: refetchActivities } = useApi<Activity[]>(`/tickets/${ticketId}/activities`, [ticketId]);
  const [commentText, setCommentText] = useState('');
  const [commentVisibility, setCommentVisibility] = useState<'internal' | 'external'>('internal');

  if (ticketLoading || !ticket) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">Loading...</div>;
  }

  const status = statusConfig[ticket.status_category] ?? statusConfig.new;
  const priority = priorityConfig[ticket.priority] ?? priorityConfig.medium;

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
    <div className="flex h-screen flex-col">
      {/* Header */}
      <div className="border-b p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold leading-tight">{ticket.title}</h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${status.className}`}>
                {status.label}
              </span>
              <Badge variant={priority.variant} className="text-xs">
                {priority.label}
              </Badge>
              {ticket.request_type && (
                <span className="text-xs text-muted-foreground">{ticket.request_type.name}</span>
              )}
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <SlaTimer dueAt={ticket.sla_resolution_due_at} breachedAt={ticket.sla_resolution_breached_at} />
            <span className="text-xs text-muted-foreground">{timeAgo(ticket.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Meta info */}
      <div className="border-b px-4 py-3 grid grid-cols-2 gap-3 text-sm">
        {ticket.requester && (
          <div className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Requester:</span>
            <span>{ticket.requester.first_name} {ticket.requester.last_name}</span>
          </div>
        )}
        {ticket.assigned_team && (
          <div className="flex items-center gap-2">
            <Users className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Team:</span>
            <span>{ticket.assigned_team.name}</span>
          </div>
        )}
        {ticket.location && (
          <div className="flex items-center gap-2">
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Location:</span>
            <span>{ticket.location.name}</span>
          </div>
        )}
        {ticket.assigned_agent && (
          <div className="flex items-center gap-2">
            <User className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-muted-foreground">Agent:</span>
            <span>{ticket.assigned_agent.email}</span>
          </div>
        )}
      </div>

      {/* Description */}
      {ticket.description && (
        <div className="border-b px-4 py-3">
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{ticket.description}</p>
        </div>
      )}

      {/* Activity timeline */}
      <ScrollArea className="flex-1 px-4">
        <div className="py-3 space-y-3">
          {(activities ?? []).map((activity) => (
            <div key={activity.id} className="flex gap-3">
              <div className="mt-1">
                {activity.visibility === 'system' ? (
                  <div className="h-6 w-6 rounded-full bg-muted flex items-center justify-center">
                    <Clock className="h-3 w-3 text-muted-foreground" />
                  </div>
                ) : (
                  <div className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-medium ${
                    activity.visibility === 'internal'
                      ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300'
                      : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300'
                  }`}>
                    {activity.author?.first_name?.[0] ?? '?'}
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {activity.author && (
                    <span className="text-sm font-medium">
                      {activity.author.first_name} {activity.author.last_name}
                    </span>
                  )}
                  {activity.visibility === 'internal' && (
                    <Badge variant="outline" className="text-[10px] px-1 py-0 text-yellow-600">Internal</Badge>
                  )}
                  {activity.visibility === 'system' && (
                    <span className="text-xs text-muted-foreground">System</span>
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">{timeAgo(activity.created_at)}</span>
                </div>
                {activity.content && (
                  <p className="text-sm text-muted-foreground mt-0.5 whitespace-pre-wrap">{activity.content}</p>
                )}
                {activity.metadata && activity.visibility === 'system' && (
                  <p className="text-xs text-muted-foreground mt-0.5 italic">
                    {(activity.metadata as Record<string, unknown>).event as string}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      <Separator />

      {/* Comment input */}
      <div className="p-3">
        <div className="flex items-center gap-2 mb-2">
          <Tabs value={commentVisibility} onValueChange={(v) => setCommentVisibility(v as 'internal' | 'external')}>
            <TabsList className="h-7">
              <TabsTrigger value="internal" className="text-xs px-2 py-0.5">
                <MessageSquare className="h-3 w-3 mr-1" /> Internal
              </TabsTrigger>
              <TabsTrigger value="external" className="text-xs px-2 py-0.5">
                <Send className="h-3 w-3 mr-1" /> Reply
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex gap-2">
          <textarea
            className="flex-1 rounded-md border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-ring"
            placeholder={commentVisibility === 'internal' ? 'Add internal note...' : 'Reply to requester...'}
            rows={2}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                handleSubmitComment();
              }
            }}
          />
          <Button size="sm" onClick={handleSubmitComment} disabled={!commentText.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
