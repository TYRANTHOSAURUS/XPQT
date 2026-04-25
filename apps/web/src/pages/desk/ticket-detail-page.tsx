import { useNavigate, useParams } from 'react-router-dom';
import { TicketDetail } from '@/components/desk/ticket-detail';

export function TicketDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  if (!id) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Ticket not found.
      </div>
    );
  }

  return (
    <div className="h-full">
      <TicketDetail
        ticketId={id}
        onClose={() => navigate('/desk/tickets')}
        onOpenTicket={(nextId) => navigate(`/desk/tickets/${nextId}`)}
      />
    </div>
  );
}
