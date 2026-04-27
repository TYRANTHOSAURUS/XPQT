import { useMemo, useState } from 'react';
import {
  Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell,
} from 'recharts';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Link } from 'react-router-dom';
import { useBookingsUtilization } from '@/api/booking-reports';
import { formatCount } from '@/lib/format';
import { pct } from './format';
import { BookingsReportShell, EmptyWindow, useReportFilters } from './components/report-shell';

const fitConfig = {
  count: { label: 'Bookings', color: 'oklch(0.62 0.19 250)' },
} satisfies ChartConfig;

const FIT_COLORS: Record<string, string> = {
  oversized:   'oklch(0.78 0.04 270)',
  right_sized: 'oklch(0.70 0.16 155)',
  undersized:  'oklch(0.65 0.21 25)',
  unknown:     'oklch(0.85 0.02 270)',
};

type SortKey = 'utilization' | 'booked_hours' | 'bookings' | 'no_show_count';

export function RoomBookingUtilizationReport() {
  const [filters, setFilters, tz] = useReportFilters();
  const { data, isLoading, error, isFetching } = useBookingsUtilization({
    from: filters.from, to: filters.to, building_id: filters.buildingId, tz,
  });

  return (
    <BookingsReportShell
      filters={filters}
      onFiltersChange={setFilters}
      isLoading={isLoading}
      error={error}
      isFetching={isFetching}
      hasData={!!data && data.kpis.rooms_in_scope > 0}
      emptyState={<EmptyWindow message="No rooms in scope. Add buildings or rooms to start tracking utilization." />}
    >
      {data ? <UtilizationBody data={data} /> : null}
    </BookingsReportShell>
  );
}

function UtilizationBody({ data }: { data: NonNullable<ReturnType<typeof useBookingsUtilization>['data']> }) {
  const k = data.kpis;
  const kpis: SectionCardItem[] = [
    {
      description: 'Avg utilization',
      title: pct(k.avg_utilization, 1),
      trend: { direction: 'up', label: `${formatCount(k.rooms_in_scope)} rooms` },
      footerPrimary: 'Across all rooms in scope',
      footerSecondary: 'Booked / bookable hours',
    },
    {
      description: 'Underused (<20%)',
      title: formatCount(k.underused_count),
      trend: { direction: k.underused_count > 0 ? 'down' : 'up', label: 'rooms' },
      footerPrimary: 'Candidates to repurpose',
      footerSecondary: 'Or merge / unbookable',
    },
    {
      description: 'Overused (>85%)',
      title: formatCount(k.overused_count),
      trend: { direction: k.overused_count > 0 ? 'up' : 'down', label: 'rooms' },
      footerPrimary: 'Hot rooms — capacity risk',
      footerSecondary: 'Consider adding capacity',
    },
    {
      description: 'Avg seat fill',
      title: k.avg_capacity_fit == null ? '—' : pct(k.avg_capacity_fit, 1),
      trend: { direction: 'up', label: 'of capacity' },
      footerPrimary: 'How full each booking was',
      footerSecondary: 'Right-size signal',
    },
  ];

  return (
    <>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <CapacityFitChart buckets={data.capacity_fit_buckets} />
      </div>
      <div className="px-4 lg:px-6">
        <ByBuildingTable rows={data.by_building} />
      </div>
      <div className="px-4 lg:px-6">
        <PerRoomTable rows={data.rooms} />
      </div>
    </>
  );
}

function CapacityFitChart({ buckets }: { buckets: { right_sized: number; oversized: number; undersized: number; unknown: number } }) {
  const chartData = [
    { bucket: 'Oversized',   subtitle: '< 60% full', count: buckets.oversized,   key: 'oversized' },
    { bucket: 'Right-sized', subtitle: '60–100%',    count: buckets.right_sized, key: 'right_sized' },
    { bucket: 'Undersized',  subtitle: '> 100%',     count: buckets.undersized,  key: 'undersized' },
    { bucket: 'Unknown',     subtitle: 'no data',    count: buckets.unknown,     key: 'unknown' },
  ];
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Capacity fit</CardTitle>
        <CardDescription>Are rooms right-sized for actual attendance?</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6 sm:pt-4">
        <ChartContainer config={fitConfig} className="aspect-auto h-[220px] w-full">
          <BarChart data={chartData}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Bar dataKey="count" radius={4}>
              {chartData.map((c) => <Cell key={c.key} fill={FIT_COLORS[c.key]} />)}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function ByBuildingTable({ rows }: { rows: Array<{ building_id: string; building_name: string; room_count: number; bookings: number; booked_hours: number; utilization: number }> }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>By building</CardTitle>
        <CardDescription>Aggregate utilization rolled up to each building.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Building</TableHead>
              <TableHead className="text-right">Rooms</TableHead>
              <TableHead className="text-right">Bookings</TableHead>
              <TableHead className="text-right">Hours</TableHead>
              <TableHead className="text-right">Utilization</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.building_id}>
                <TableCell className="font-medium">{r.building_name}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(r.room_count)}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCount(r.bookings)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.booked_hours.toFixed(1)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.utilization, 1)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PerRoomTable({ rows }: { rows: Array<{ space_id: string; name: string; building_name: string | null; capacity: number | null; bookings: number; booked_hours: number; utilization: number; avg_attendees: number | null; capacity_fit: number | null; no_show_count: number }> }) {
  const [sortKey, setSortKey] = useState<SortKey>('utilization');
  const sorted = useMemo(() =>
    [...rows].sort((a, b) => (b[sortKey] as number) - (a[sortKey] as number)),
    [rows, sortKey]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rooms</CardTitle>
        <CardDescription>Click a column to sort. Top rows are candidates for action.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No rooms in scope.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead>Building</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <SortHeader k="bookings" current={sortKey} onSort={setSortKey}>Bookings</SortHeader>
                <SortHeader k="booked_hours" current={sortKey} onSort={setSortKey}>Hours</SortHeader>
                <SortHeader k="utilization" current={sortKey} onSort={setSortKey}>Util.</SortHeader>
                <TableHead className="text-right">Avg attendees</TableHead>
                <TableHead className="text-right">Fit</TableHead>
                <SortHeader k="no_show_count" current={sortKey} onSort={setSortKey}>No-shows</SortHeader>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r) => (
                <TableRow key={r.space_id}>
                  <TableCell>
                    <Link to={`/admin/locations/${r.space_id}`} className="hover:underline font-medium">
                      {r.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{r.building_name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.capacity ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.bookings)}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.booked_hours.toFixed(1)}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.utilization, 1)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.avg_attendees == null ? '—' : r.avg_attendees.toFixed(1)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.capacity_fit == null ? '—' : pct(r.capacity_fit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.no_show_count}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function SortHeader({ k, current, onSort, children }: {
  k: SortKey; current: SortKey; onSort: (k: SortKey) => void; children: React.ReactNode;
}) {
  const active = current === k;
  return (
    <TableHead
      className={`text-right cursor-pointer select-none ${active ? 'text-foreground' : ''}`}
      onClick={() => onSort(k)}
    >
      {children} {active ? '↓' : ''}
    </TableHead>
  );
}

export default RoomBookingUtilizationReport;
