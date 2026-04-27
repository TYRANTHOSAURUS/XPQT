import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import type { NoShowWatchlistRow } from '@/api/booking-reports/types';

export function NoShowWatchlist({ rows }: { rows: NoShowWatchlistRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No-show watchlist</CardTitle>
        <CardDescription>
          Confirmed bookings whose start time passed without a check-in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No no-shows in this window.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Building</TableHead>
                <TableHead>Organizer</TableHead>
                <TableHead className="text-right">Attendees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.reservation_id}>
                  <TableCell>
                    <time dateTime={r.start_at} title={formatFullTimestamp(r.start_at)}>
                      {formatRelativeTime(r.start_at)}
                    </time>
                  </TableCell>
                  <TableCell className="font-medium">{r.room_name}</TableCell>
                  <TableCell className="text-muted-foreground">{r.building_name ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{r.organizer_name || '—'}</span>
                      {r.organizer_email && (
                        <span className="text-xs text-muted-foreground">{r.organizer_email}</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.attendee_count ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
