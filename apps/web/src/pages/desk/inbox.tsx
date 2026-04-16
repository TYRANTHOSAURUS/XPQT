import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Search, Circle } from 'lucide-react';
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
  sla_at_risk: boolean;
  sla_resolution_due_at: string | null;
  created_at: string;
}

interface TicketListResponse {
  items: Ticket[];
  next_cursor: string | null;
}

const priorityColors: Record<string, string> = {
  critical: 'text-red-600',
  high: 'text-orange-500',
  medium: 'text-blue-500',
  low: 'text-gray-400',
};

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

export function InboxPage() {
  const [activeTab, setActiveTab] = useState('all');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const tabParams = activeTab === 'all' ? '' :
    activeTab === 'mine' ? '&assigned_user_id=current' :
    activeTab === 'team' ? '&assigned_team_id=current' : '';

  const searchParam = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : '';

  const { data, loading } = useApi<TicketListResponse>(
    `/tickets?parent_ticket_id=null${tabParams}${searchParam}`,
    [activeTab, searchQuery],
  );

  const tickets = data?.items ?? [];

  return (
    <div className="flex h-screen">
      {/* Left panel: ticket list */}
      <div className="flex w-[380px] flex-col border-r">
        {/* Tabs */}
        <div className="p-3 pb-0">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full">
              <TabsTrigger value="all" className="flex-1">All</TabsTrigger>
              <TabsTrigger value="mine" className="flex-1">Mine</TabsTrigger>
              <TabsTrigger value="team" className="flex-1">Team</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        {/* Search */}
        <div className="p-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search tickets..."
              className="pl-8"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        <Separator />

        {/* Ticket list */}
        <ScrollArea className="flex-1">
          {loading && tickets.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">Loading...</div>
          )}

          {!loading && tickets.length === 0 && (
            <div className="p-6 text-center text-sm text-muted-foreground">
              No tickets found
            </div>
          )}

          {tickets.map((ticket) => (
            <button
              key={ticket.id}
              onClick={() => setSelectedTicketId(ticket.id)}
              className={`w-full text-left p-3 border-b transition-colors hover:bg-accent ${
                selectedTicketId === ticket.id ? 'bg-accent' : ''
              }`}
            >
              <div className="flex items-start gap-2">
                <Circle
                  className={`mt-1 h-2.5 w-2.5 fill-current ${priorityColors[ticket.priority] ?? 'text-gray-400'}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">
                      {ticket.title}
                    </span>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {timeAgo(ticket.created_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 mt-0.5">
                    {ticket.requester && (
                      <span className="text-xs text-muted-foreground truncate">
                        {ticket.requester.first_name} {ticket.requester.last_name}
                      </span>
                    )}
                    {ticket.location && (
                      <span className="text-xs text-muted-foreground truncate">
                        {ticket.location.name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {ticket.status_category.replace('_', ' ')}
                    </Badge>
                    {ticket.sla_at_risk && (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                        SLA at risk
                      </Badge>
                    )}
                    {ticket.assigned_team && (
                      <span className="text-[10px] text-muted-foreground">
                        {ticket.assigned_team.name}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Right panel: ticket detail */}
      <div className="flex-1">
        {selectedTicketId ? (
          <TicketDetail ticketId={selectedTicketId} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            Select a ticket to view details
          </div>
        )}
      </div>
    </div>
  );
}
