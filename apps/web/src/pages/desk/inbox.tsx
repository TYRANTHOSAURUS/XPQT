import { useSearchParams } from 'react-router-dom';
import { TicketDetail } from '@/components/desk/ticket-detail';

export function InboxPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const ticketId = searchParams.get('ticket');

  if (!ticketId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="text-center text-muted-foreground">
          <p className="text-lg font-medium">Select a ticket</p>
          <p className="text-sm mt-1">Choose a ticket from the inbox to view its details</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <TicketDetail
        ticketId={ticketId}
        onClose={() => setSearchParams({})}
        onOpenTicket={(id) => setSearchParams({ ticket: id })}
      />
    </div>
  );
}
