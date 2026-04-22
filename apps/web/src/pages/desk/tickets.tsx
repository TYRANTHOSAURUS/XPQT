import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Search,
  Clock,
  AlertTriangle,
  X,
} from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { TicketDetail } from '@/components/desk/ticket-detail';
import { CreateTicketDialog } from '@/components/desk/create-ticket-dialog';
import { Group, Panel, Separator } from 'react-resizable-panels';

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
  tags: string[];
}

interface TicketListResponse {
  items: Ticket[];
  next_cursor: string | null;
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

function SlaCell({ dueAt, breachedAt }: { dueAt: string | null; breachedAt: string | null }) {
  if (!dueAt) return <span className="text-muted-foreground">--</span>;
  if (breachedAt) {
    return <span className="font-medium text-red-500 inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Breached</span>;
  }
  const remaining = new Date(dueAt).getTime() - Date.now();
  if (remaining <= 0) {
    return <span className="font-medium text-red-500 inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" /> Overdue</span>;
  }
  const hours = Math.floor(remaining / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const timeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
  const urgencyClass = remaining < 3600000 ? 'text-red-500' : remaining < 7200000 ? 'text-yellow-500' : 'text-green-500';
  return <span className={`font-medium inline-flex items-center gap-1 ${urgencyClass}`}><Clock className="h-3.5 w-3.5" /> {timeStr}</span>;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function TicketTable({
  tickets,
  loading,
  searchQuery,
  setSearchQuery,
  selectedTicketId,
  setSelectedTicketId,
  selectedIds,
  setSelectedIds,
}: {
  tickets: Ticket[];
  loading: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  selectedTicketId: string | null;
  setSelectedTicketId: (id: string | null) => void;
  selectedIds: Set<string>;
  setSelectedIds: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === tickets.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tickets.map((t) => t.id)));
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-6 py-4 shrink-0">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search tickets..."
            className="pl-9"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {selectedIds.size > 0 ? (
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{selectedIds.size} selected</Badge>
            <Select>
              <SelectTrigger className="w-[120px] h-8">
                <SelectValue placeholder="Assign" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="team-a">FM Team A</SelectItem>
                <SelectItem value="team-b">IT Desk</SelectItem>
              </SelectContent>
            </Select>
            <Select>
              <SelectTrigger className="w-[120px] h-8">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="waiting">Waiting</SelectItem>
                <SelectItem value="resolved">Resolved</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelectedIds(new Set())}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        ) : (
          <div className="ml-auto flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {tickets.length} ticket{tickets.length !== 1 ? 's' : ''}
            </span>
            <CreateTicketDialog />
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pl-6">
                <Checkbox
                  checked={tickets.length > 0 && selectedIds.size === tickets.length}
                  onCheckedChange={toggleSelectAll}
                />
              </TableHead>
              <TableHead className="min-w-[250px]">Title</TableHead>
              <TableHead className="w-[120px]">Status</TableHead>
              <TableHead className="w-[100px]">Priority</TableHead>
              <TableHead className="w-[150px]">Team</TableHead>
              <TableHead className="w-[110px]">SLA</TableHead>
              <TableHead className="w-[70px] pr-6">Age</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && tickets.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  Loading tickets...
                </TableCell>
              </TableRow>
            )}
            {!loading && tickets.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center">
                  <p className="text-lg font-medium text-muted-foreground">No tickets found</p>
                  <p className="text-sm text-muted-foreground mt-1">Try adjusting your filters or search</p>
                </TableCell>
              </TableRow>
            )}
            {tickets.map((ticket) => {
              const status = statusConfig[ticket.status_category] ?? statusConfig.new;
              const priority = priorityConfig[ticket.priority] ?? priorityConfig.medium;

              return (
                <TableRow
                  key={ticket.id}
                  className={`cursor-pointer ${selectedTicketId === ticket.id ? 'bg-accent' : ''}`}
                  onClick={() => setSelectedTicketId(ticket.id)}
                >
                  <TableCell className="pl-6" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(ticket.id)}
                      onCheckedChange={() => toggleSelect(ticket.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="min-w-0">
                      <span className="font-medium block truncate">{ticket.title}</span>
                      <span className="text-sm text-muted-foreground block truncate mt-0.5">
                        {ticket.requester ? `${ticket.requester.first_name} ${ticket.requester.last_name}` : ''}
                        {ticket.location ? ` · ${ticket.location.name}` : ''}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className={`h-2.5 w-2.5 rounded-full shrink-0 ${status.dotColor}`} />
                      <span className="text-sm">{status.label}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`text-sm font-medium ${priority.color}`}>{priority.label}</span>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground truncate block">
                      {ticket.assigned_team?.name ?? '--'}
                    </span>
                  </TableCell>
                  <TableCell>
                    <SlaCell dueAt={ticket.sla_resolution_due_at} breachedAt={ticket.sla_resolution_breached_at} />
                  </TableCell>
                  <TableCell className="pr-6">
                    <span className="text-sm text-muted-foreground">{timeAgo(ticket.created_at)}</span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

export function TicketsPage() {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const searchParam = searchQuery ? `&search=${encodeURIComponent(searchQuery)}` : '';
  const { data, loading } = useApi<TicketListResponse>(
    `/tickets?parent_ticket_id=null${searchParam}`,
    [searchQuery],
  );
  const tickets = data?.items ?? [];

  const tableProps = {
    tickets,
    loading,
    searchQuery,
    setSearchQuery,
    selectedTicketId,
    setSelectedTicketId,
    selectedIds,
    setSelectedIds,
  };

  // Conditional rendering approach from react-resizable-panels docs
  // When no ticket is selected, render table only (full width)
  // When a ticket is selected, render table + separator + detail panel
  return (
    <Group orientation="horizontal" style={{ height: '100%' }}>
      {selectedTicketId ? (
        <>
          <Panel id="table" defaultSize="55%">
            <TicketTable {...tableProps} />
          </Panel>
          <Separator />
          <Panel id="detail" defaultSize="45%">
            <div className="h-full overflow-auto border-l">
              <TicketDetail
                ticketId={selectedTicketId}
                onClose={() => setSelectedTicketId(null)}
                onOpenTicket={setSelectedTicketId}
              />
            </div>
          </Panel>
        </>
      ) : (
        <Panel id="table">
          <TicketTable {...tableProps} />
        </Panel>
      )}
    </Group>
  );
}
