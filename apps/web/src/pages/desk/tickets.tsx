import { useState } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
} from '@/components/ui/sheet';
import {
  Search,
  User,
  Users,
  AlertTriangle,
  Clock,
  Filter,
  X,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { TicketDetail } from '@/components/desk/ticket-detail';

interface Ticket {
  id: string;
  title: string;
  status_category: string;
  priority: string;
  requester?: { first_name: string; last_name: string };
  location?: { name: string };
  assigned_team?: { name: string };
  assigned_agent?: { email: string };
  sla_at_risk: boolean;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  created_at: string;
}

interface TicketListResponse {
  items: Ticket[];
  next_cursor: string | null;
}

type View = {
  id: string;
  label: string;
  icon: typeof User;
  params: string;
};

const views: View[] = [
  { id: 'assigned-to-me', label: 'Assigned to me', icon: User, params: '&assigned_user_id=current' },
  { id: 'all', label: 'All tickets', icon: Filter, params: '' },
  { id: 'unassigned', label: 'Unassigned', icon: Users, params: '&assigned_user_id=null' },
  { id: 'sla-at-risk', label: 'SLA at risk', icon: AlertTriangle, params: '&sla_at_risk=true' },
  { id: 'my-team', label: 'My team', icon: Users, params: '&assigned_team_id=current' },
  { id: 'recent', label: 'Recent', icon: Clock, params: '' },
];

const statusOptions = ['new', 'assigned', 'in_progress', 'waiting', 'resolved', 'closed'];
const priorityOptions = ['critical', 'high', 'medium', 'low'];

const statusColors: Record<string, string> = {
  new: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  assigned: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300',
  in_progress: 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  waiting: 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  resolved: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
  closed: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
};

const priorityIcons: Record<string, string> = {
  critical: 'text-red-600',
  high: 'text-orange-500',
  medium: 'text-blue-500',
  low: 'text-gray-400',
};

function SlaCell({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return <span className="text-xs text-muted-foreground">-</span>;

  if (breachedAt) {
    return <span className="text-xs font-medium text-red-600">Breached</span>;
  }

  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) return <span className="text-xs font-medium text-red-600">Overdue</span>;

  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

  const urgency = remaining < 3600000 ? 'text-red-600' :
    remaining < 7200000 ? 'text-yellow-600' : 'text-green-600';

  return <span className={`text-xs font-medium ${urgency}`}>{timeStr}</span>;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function TicketsPage() {
  const [activeView, setActiveView] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [priorityFilter, setPriorityFilter] = useState<string[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);

  const view = views.find((v) => v.id === activeView) ?? views[1];

  const statusParam = statusFilter.length > 0 ? `&status_category=${statusFilter[0]}` : '';
  const priorityParam = priorityFilter.length > 0 ? `&priority=${priorityFilter[0]}` : '';
  const searchParam = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : '';

  const { data, loading } = useApi<TicketListResponse>(
    `/tickets?parent_ticket_id=null${view.params}${statusParam}${priorityParam}${searchParam}`,
    [activeView, statusFilter, priorityFilter, searchQuery],
  );

  const tickets = data?.items ?? [];

  const toggleStatus = (s: string) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
  };

  const togglePriority = (p: string) => {
    setPriorityFilter((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  };

  return (
    <div className="flex h-screen">
      {/* Left: Views + Filters */}
      <div className="w-[220px] flex-shrink-0 border-r flex flex-col">
        <div className="p-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Views</h3>
        </div>
        <div className="px-1">
          {views.map((v) => (
            <button
              key={v.id}
              onClick={() => setActiveView(v.id)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-sm transition-colors ${
                activeView === v.id
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/50'
              }`}
            >
              <v.icon className="h-3.5 w-3.5" />
              {v.label}
            </button>
          ))}
        </div>

        <Separator className="my-3" />

        <ScrollArea className="flex-1 px-3">
          <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Filters</h3>

          <div className="mb-4">
            <p className="text-xs font-medium mb-1.5">Status</p>
            {statusOptions.map((s) => (
              <label key={s} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={statusFilter.includes(s)}
                  onChange={() => toggleStatus(s)}
                  className="rounded border-input"
                />
                <span className="text-xs capitalize">{s.replace('_', ' ')}</span>
              </label>
            ))}
          </div>

          <div className="mb-4">
            <p className="text-xs font-medium mb-1.5">Priority</p>
            {priorityOptions.map((p) => (
              <label key={p} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={priorityFilter.includes(p)}
                  onChange={() => togglePriority(p)}
                  className="rounded border-input"
                />
                <span className="text-xs capitalize">{p}</span>
              </label>
            ))}
          </div>

          {(statusFilter.length > 0 || priorityFilter.length > 0) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setStatusFilter([]); setPriorityFilter([]); }}
              className="w-full text-xs"
            >
              <X className="h-3 w-3 mr-1" /> Clear filters
            </Button>
          )}
        </ScrollArea>
      </div>

      {/* Center: Ticket table */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Search bar */}
        <div className="border-b p-3 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tickets..."
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Table header */}
        <div className="border-b px-4 py-2 grid grid-cols-[1fr_100px_80px_120px_100px_60px] gap-2 text-xs font-medium text-muted-foreground">
          <span>Title</span>
          <span>Status</span>
          <span>Priority</span>
          <span>Team</span>
          <span>SLA</span>
          <span>Age</span>
        </div>

        {/* Table body */}
        <ScrollArea className="flex-1">
          {loading && tickets.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
          )}
          {!loading && tickets.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">No tickets match your filters</div>
          )}

          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => setSelectedTicketId(ticket.id)}
              className={`w-full text-left px-4 py-2.5 border-b grid grid-cols-[1fr_100px_80px_120px_100px_60px] gap-2 items-center transition-colors hover:bg-accent/50 ${
                selectedTicketId === ticket.id ? 'bg-accent' : ''
              }`}
            >
              <div className="min-w-0">
                <span className="text-sm truncate block">{ticket.title}</span>
                <span className="text-xs text-muted-foreground truncate block">
                  {ticket.requester ? `${ticket.requester.first_name} ${ticket.requester.last_name}` : ''}
                  {ticket.location ? ` · ${ticket.location.name}` : ''}
                </span>
              </div>
              <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium w-fit ${statusColors[ticket.status_category] ?? ''}`}>
                {ticket.status_category.replace('_', ' ')}
              </span>
              <span className={`text-xs font-medium capitalize ${priorityIcons[ticket.priority] ?? ''}`}>
                {ticket.priority}
              </span>
              <span className="text-xs text-muted-foreground truncate">
                {ticket.assigned_team?.name ?? '-'}
              </span>
              <SlaCell dueAt={ticket.sla_resolution_due_at} breachedAt={ticket.sla_resolution_breached_at} />
              <span className="text-xs text-muted-foreground">{timeAgo(ticket.created_at)}</span>
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Right: Detail panel (slide-in sheet) */}
      <Sheet open={!!selectedTicketId} onOpenChange={(open) => { if (!open) setSelectedTicketId(null); }}>
        <SheetContent side="right" className="w-[30vw] min-w-[400px] p-0 sm:max-w-none">
          {selectedTicketId && <TicketDetail ticketId={selectedTicketId} />}
        </SheetContent>
      </Sheet>
    </div>
  );
}
