import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Clock,
  AlertTriangle,
  ChevronRight,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { useAuth } from '@/providers/auth-provider';

interface Ticket {
  id: string;
  title: string;
  status_category: string;
  priority: string;
  assigned_team?: { name: string };
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  created_at: string;
}

interface TicketListResponse {
  items: Ticket[];
  next_cursor: string | null;
}

const statusLabels: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  new: { label: 'Submitted', variant: 'default' },
  assigned: { label: 'Assigned', variant: 'default' },
  in_progress: { label: 'In Progress', variant: 'default' },
  waiting: { label: 'Pending', variant: 'secondary' },
  resolved: { label: 'Resolved', variant: 'outline' },
  closed: { label: 'Closed', variant: 'outline' },
};

function SlaIndicator({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return null;
  if (breachedAt) {
    return <span className="text-sm text-red-500 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Delayed</span>;
  }
  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) {
    return <span className="text-sm text-red-500 flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Delayed</span>;
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  return <span className="text-sm text-muted-foreground flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Est. {timeStr}</span>;
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export function MyRequestsPage() {
  const navigate = useNavigate();
  const { person } = useAuth();
  const [filter, setFilter] = useState('open');

  const statusParam = filter === 'open'
    ? '&status_category=new&status_category=assigned&status_category=in_progress&status_category=waiting'
    : filter === 'closed'
    ? '&status_category=resolved&status_category=closed'
    : '';
  const requesterParam = person?.id ? `&requester_person_id=${person.id}` : '';

  const { data, loading } = useApi<TicketListResponse>(
    `/tickets?parent_ticket_id=null${statusParam}${requesterParam}`,
    [filter, person?.id],
  );
  const tickets = person?.id ? (data?.items ?? []) : [];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Requests</h1>
          <p className="text-muted-foreground mt-1">Track the status of your submitted requests</p>
        </div>
        <Button onClick={() => window.location.href = '/portal'}>New Request</Button>
      </div>

      <Tabs value={filter} onValueChange={setFilter} className="mb-6">
        <TabsList>
          <TabsTrigger value="open">Open</TabsTrigger>
          <TabsTrigger value="closed">Closed</TabsTrigger>
          <TabsTrigger value="all">All</TabsTrigger>
        </TabsList>
      </Tabs>

      {loading && tickets.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">Loading your requests...</div>
      )}

      {!loading && tickets.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-lg font-medium text-muted-foreground">No requests found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {filter === 'open' ? "You don't have any open requests" : "No requests match this filter"}
            </p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {tickets.map((ticket) => {
          const status = statusLabels[ticket.status_category] ?? statusLabels.new;
          return (
            <Card key={ticket.id} className="cursor-pointer hover:bg-accent/30 transition-colors" onClick={() => navigate(`/portal/my-requests/${ticket.id}`)}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <CardTitle className="text-base">{ticket.title}</CardTitle>
                    <div className="flex items-center gap-3 mt-2">
                      <Badge variant={status.variant}>{status.label}</Badge>
                      {ticket.assigned_team && (
                        <span className="text-sm text-muted-foreground">{ticket.assigned_team.name}</span>
                      )}
                      <span className="text-sm text-muted-foreground">{formatDate(ticket.created_at)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <SlaIndicator dueAt={ticket.sla_resolution_due_at} breachedAt={ticket.sla_resolution_breached_at} />
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              </CardHeader>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
