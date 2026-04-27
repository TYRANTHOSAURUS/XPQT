import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { formatCount } from '@/lib/format';
import { Link } from 'react-router-dom';
import type { TopRoomRow } from '@/api/booking-reports/types';
import { pct } from '../format';

export function TopRoomsTable({ rows }: { rows: TopRoomRow[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top rooms</CardTitle>
        <CardDescription>By booked hours in the selected window. Top 10.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bookings in this window.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead>Building</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Hours</TableHead>
                <TableHead className="text-right">No-show</TableHead>
                <TableHead className="text-right">Services</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.space_id}>
                  <TableCell>
                    <Link
                      to={`/admin/locations/${r.space_id}`}
                      className="hover:underline font-medium"
                    >
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.building_name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.bookings)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.booked_hours.toFixed(1)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.no_show_rate)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.services_rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
