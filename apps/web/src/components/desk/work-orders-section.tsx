import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useWorkOrders, WorkOrderRow } from '@/hooks/use-work-orders';

interface WorkOrdersSectionProps {
  parentId: string;
  /** Called when the user clicks "Add work order". Task 7 wires this to a Dialog. */
  onAddClick: () => void;
  /**
   * Bumped by the parent when the dialog closes after a successful dispatch,
   * so the section re-fetches. The parent holds the nonce so it can also invalidate
   * its own ticket query in lockstep.
   */
  refreshNonce?: number;
}

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'outline'> = {
  new: 'outline',
  assigned: 'secondary',
  in_progress: 'default',
  waiting: 'secondary',
  resolved: 'secondary',
  closed: 'outline',
};

function formatAssignee(row: WorkOrderRow): string {
  if (row.assigned_vendor_id) return 'Vendor';
  if (row.assigned_user_id) return 'User';
  if (row.assigned_team_id) return 'Team';
  return 'Unassigned';
}

export function WorkOrdersSection({ parentId, onAddClick, refreshNonce = 0 }: WorkOrdersSectionProps) {
  const navigate = useNavigate();
  const { data, loading, error, refetch } = useWorkOrders(parentId);
  const [lastNonce, setLastNonce] = useState(refreshNonce);

  if (refreshNonce !== lastNonce) {
    setLastNonce(refreshNonce);
    refetch();
  }

  return (
    <section className="border-t py-4 px-6">
      <header className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Wrench className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Work Orders</h3>
          {data.length > 0 && (
            <span className="text-xs text-muted-foreground">({data.length})</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={onAddClick}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add work order
        </Button>
      </header>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}

      {error && !loading && (
        <div className="text-sm text-destructive flex items-center gap-2">
          <span>Failed to load work orders.</span>
          <Button size="sm" variant="ghost" onClick={refetch}>Retry</Button>
        </div>
      )}

      {!loading && !error && data.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No work orders yet. Add one to send work to a vendor, team, or teammate.
        </p>
      )}

      {!loading && !error && data.length > 0 && (
        <ul className="divide-y rounded-md border">
          {data.map((row) => (
            <li
              key={row.id}
              className="flex items-center gap-3 px-3 py-2 hover:bg-muted/50 cursor-pointer"
              onClick={() => navigate(`/desk/tickets/${row.id}`)}
            >
              <span className="flex-1 truncate text-sm">{row.title}</span>
              <Badge variant={STATUS_VARIANT[row.status_category] ?? 'outline'} className="text-xs">
                {row.status_category.replace('_', ' ')}
              </Badge>
              <span className="text-xs text-muted-foreground w-20 text-right">
                {formatAssignee(row)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
