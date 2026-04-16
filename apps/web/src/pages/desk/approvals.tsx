import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle2, XCircle, Inbox } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { useAuth } from '@/providers/auth-provider';

/* ---------- Types ---------- */

interface Approval {
  id: string;
  target_entity_type: string;
  target_entity_id: string;
  approval_chain_id: string | null;
  step_number: number | null;
  parallel_group: string | null;
  approver_person_id: string | null;
  approver_team_id: string | null;
  status: string;
  requested_at: string;
  responded_at: string | null;
  comments: string | null;
  created_at: string;
}

/* ---------- Helpers ---------- */

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

function entityTypeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1).replace(/_/g, ' ');
}

/* ---------- Main page ---------- */

export function ApprovalsPage() {
  const { person } = useAuth();
  const personId = person?.id;

  const { data: approvals, loading, error, refetch } = useApi<Approval[]>(
    personId ? `/approvals/pending/${personId}` : '',
    [personId],
  );

  const [comments, setComments] = useState<Record<string, string>>({});
  const [responding, setResponding] = useState<Record<string, boolean>>({});

  const handleRespond = async (approvalId: string, status: 'approved' | 'rejected') => {
    if (!personId) return;
    setResponding((prev) => ({ ...prev, [approvalId]: true }));
    try {
      await apiFetch(`/approvals/${approvalId}/respond`, {
        method: 'POST',
        body: JSON.stringify({
          status,
          comments: comments[approvalId] || undefined,
          responding_person_id: personId,
        }),
      });
      setComments((prev) => {
        const next = { ...prev };
        delete next[approvalId];
        return next;
      });
      refetch();
    } catch {
      // Error handled silently for now — apiFetch will throw on non-OK
    } finally {
      setResponding((prev) => ({ ...prev, [approvalId]: false }));
    }
  };

  // No person loaded yet (auth still hydrating)
  if (!personId) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-muted-foreground">
          {loading ? 'Loading...' : 'No person record linked to your account.'}
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p className="text-destructive">Failed to load approvals: {error}</p>
      </div>
    );
  }

  const items = approvals ?? [];

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Approvals</h1>
        <p className="text-muted-foreground mt-1">
          Pending approval requests assigned to you
        </p>
      </div>

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center py-16">
          <p className="text-muted-foreground">Loading approvals...</p>
        </div>
      ) : items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <Inbox className="h-10 w-10 text-muted-foreground/50" />
            <p className="text-lg font-medium text-muted-foreground">No pending approvals</p>
            <p className="text-sm text-muted-foreground">
              You're all caught up. New approval requests will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Pending
              <Badge variant="secondary" className="tabular-nums">
                {items.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entity</TableHead>
                  <TableHead className="w-[140px]">Requested</TableHead>
                  <TableHead className="w-[100px]">Status</TableHead>
                  <TableHead className="min-w-[200px]">Comment</TableHead>
                  <TableHead className="w-[180px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((approval) => (
                  <TableRow key={approval.id}>
                    <TableCell>
                      <div>
                        <span className="font-medium">{entityTypeLabel(approval.target_entity_type)}</span>
                        <span className="block text-xs text-muted-foreground font-mono mt-0.5">
                          {approval.target_entity_id.slice(0, 8)}...
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(approval.requested_at)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          approval.status === 'pending'
                            ? 'outline'
                            : approval.status === 'approved'
                              ? 'default'
                              : 'destructive'
                        }
                        className="capitalize"
                      >
                        {approval.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Input
                        placeholder="Optional comment..."
                        className="h-8 text-sm"
                        value={comments[approval.id] ?? ''}
                        onChange={(e) =>
                          setComments((prev) => ({ ...prev, [approval.id]: e.target.value }))
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          className="gap-1.5 bg-green-600 hover:bg-green-700 text-white"
                          disabled={responding[approval.id]}
                          onClick={() => handleRespond(approval.id, 'approved')}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          className="gap-1.5"
                          disabled={responding[approval.id]}
                          onClick={() => handleRespond(approval.id, 'rejected')}
                        >
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
