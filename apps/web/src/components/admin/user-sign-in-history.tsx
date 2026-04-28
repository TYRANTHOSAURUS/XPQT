import { useUserSignIns } from '@/api/users';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export function UserSignInHistory({ userId, limit = 10 }: { userId: string; limit?: number }) {
  const { data, isLoading, error } = useUserSignIns(userId, limit);

  if (isLoading) return <Skeleton className="h-48" />;
  if (error) {
    return <p className="text-sm text-muted-foreground">Couldn't load sign-in history.</p>;
  }
  if (!data || data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No sign-ins recorded yet for this account.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead className="w-[140px]">IP</TableHead>
          <TableHead>Device</TableHead>
          <TableHead className="w-[100px]">Method</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.map((row) => (
          <TableRow key={row.id}>
            <TableCell>
              <time
                className="tabular-nums text-sm"
                dateTime={row.signed_in_at}
                title={formatFullTimestamp(row.signed_in_at)}
              >
                {formatRelativeTime(row.signed_in_at)}
              </time>
            </TableCell>
            <TableCell className="font-mono text-xs">{row.ip_address ?? '—'}</TableCell>
            <TableCell className="text-xs text-muted-foreground truncate max-w-[280px]">
              {row.user_agent ?? '—'}
            </TableCell>
            <TableCell className="text-xs capitalize">{row.method ?? '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
