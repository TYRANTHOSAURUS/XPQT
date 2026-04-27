import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { useBookingsNoShows } from '@/api/booking-reports';
import { formatCount, formatRelativeTime, formatFullTimestamp, formatShortDate } from '@/lib/format';
import { pct } from './format';
import { BookingsReportShell, EmptyWindow, useReportFilters } from './components/report-shell';

const trendConfig = {
  no_shows:      { label: 'No-shows',      color: 'oklch(0.65 0.21 25)' },
  cancellations: { label: 'Cancellations', color: 'oklch(0.78 0.04 270)' },
} satisfies ChartConfig;

const ttcConfig = {
  count: { label: 'Cancellations', color: 'oklch(0.62 0.19 250)' },
} satisfies ChartConfig;

export function RoomBookingNoShowsReport() {
  const [filters, setFilters, tz] = useReportFilters();
  const { data, isLoading, error, isFetching } = useBookingsNoShows({
    from: filters.from, to: filters.to, building_id: filters.buildingId, tz,
  });

  return (
    <BookingsReportShell
      filters={filters}
      onFiltersChange={setFilters}
      isLoading={isLoading}
      error={error}
      isFetching={isFetching}
      hasData={!!data && (data.kpis.total_no_shows > 0 || data.kpis.total_cancellations > 0)}
      emptyState={<EmptyWindow message="No no-shows or cancellations in this window. Healthy fleet." />}
    >
      {data ? <NoShowsBody data={data} /> : null}
    </BookingsReportShell>
  );
}

function NoShowsBody({ data }: { data: NonNullable<ReturnType<typeof useBookingsNoShows>['data']> }) {
  const k = data.kpis;
  const kpis: SectionCardItem[] = [
    {
      description: 'No-shows',
      title: formatCount(k.total_no_shows),
      trend: { direction: k.no_show_rate > 0.1 ? 'down' : 'up', label: `${pct(k.no_show_rate, 1)} rate` },
      footerPrimary: 'Confirmed but not checked in',
      footerSecondary: `Of ${formatCount(k.total_eligible)} eligible`,
    },
    {
      description: 'Cancellations',
      title: formatCount(k.total_cancellations),
      trend: { direction: k.cancellation_rate > 0.15 ? 'down' : 'up', label: `${pct(k.cancellation_rate, 1)} rate` },
      footerPrimary: 'Cancelled before start',
      footerSecondary: 'All reasons',
    },
    {
      description: 'Avg lead to cancel',
      title: k.avg_time_to_cancel_hours == null ? '—' : `${k.avg_time_to_cancel_hours.toFixed(1)}h`,
      trend: { direction: 'up', label: 'before start' },
      footerPrimary: 'How early people cancel',
      footerSecondary: 'Lower = more last-minute',
    },
    {
      description: 'Last-minute cancels',
      title: formatCount(data.time_to_cancel_buckets.lt_1h + data.time_to_cancel_buckets.after_start),
      trend: { direction: 'down', label: '< 1h before start' },
      footerPrimary: 'Room held until last-minute',
      footerSecondary: 'Effectively a soft no-show',
    },
  ];

  return (
    <>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <TrendChart points={data.trend_by_day} />
      </div>
      <div className="px-4 lg:px-6">
        <TimeToCancelChart buckets={data.time_to_cancel_buckets} />
      </div>
      <div className="grid gap-4 px-4 lg:px-6 md:grid-cols-2">
        <TopNoShowOrganizers rows={data.top_no_show_organizers} />
        <TopCancellationOrganizers rows={data.top_cancellation_organizers} />
      </div>
      <div className="px-4 lg:px-6">
        <Watchlist rows={data.watchlist} />
      </div>
    </>
  );
}

function TrendChart({ points }: { points: Array<{ date: string; no_shows: number; cancellations: number }> }) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Trend</CardTitle>
        <CardDescription>No-shows and cancellations by day.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={trendConfig} className="aspect-auto h-[240px] w-full">
          <AreaChart data={points}>
            <defs>
              {(['no_shows', 'cancellations'] as const).map((k) => (
                <linearGradient key={k} id={`fill-trend-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={`var(--color-${k})`} stopOpacity={0.7} />
                  <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32}
                   tickFormatter={(v) => formatShortDate(v)} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => formatShortDate(v as string)} indicator="dot" />} />
            <ChartLegend content={<ChartLegendContent />} />
            <Area dataKey="no_shows"      type="natural" stackId="a" fill="url(#fill-trend-no_shows)"      stroke="var(--color-no_shows)" />
            <Area dataKey="cancellations" type="natural" stackId="a" fill="url(#fill-trend-cancellations)" stroke="var(--color-cancellations)" />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function TimeToCancelChart({ buckets }: { buckets: { lt_1h: number; lt_24h: number; lt_7d: number; ge_7d: number; after_start: number } }) {
  const data = [
    { bucket: '< 1h',      count: buckets.lt_1h },
    { bucket: '< 24h',     count: buckets.lt_24h },
    { bucket: '1–7 days',  count: buckets.lt_7d },
    { bucket: '≥ 7 days',  count: buckets.ge_7d },
    { bucket: 'After start', count: buckets.after_start },
  ];
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Time to cancel</CardTitle>
        <CardDescription>How early bookings get cancelled. Earlier is healthier — late cancels hold rooms.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6 sm:pt-4">
        <ChartContainer config={ttcConfig} className="aspect-auto h-[200px] w-full">
          <BarChart data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <Bar dataKey="count" fill="var(--color-count)" radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function TopNoShowOrganizers({ rows }: { rows: Array<{ person_id: string; name: string; email: string | null; no_show_count: number; total: number; rate: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top no-show organizers</CardTitle>
        <CardDescription>Frequent absentees. Useful for policy nudges.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No no-shows.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organizer</TableHead>
                <TableHead className="text-right">No-shows</TableHead>
                <TableHead className="text-right">Of total</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.person_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{r.name || '—'}</span>
                      {r.email && <span className="text-xs text-muted-foreground">{r.email}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.no_show_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.rate, 1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TopCancellationOrganizers({ rows }: { rows: Array<{ person_id: string; name: string; email: string | null; cancel_count: number; total: number; rate: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top cancellation organizers</CardTitle>
        <CardDescription>Frequent cancellers — good or bad depending on lead time.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cancellations.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Organizer</TableHead>
                <TableHead className="text-right">Cancels</TableHead>
                <TableHead className="text-right">Of total</TableHead>
                <TableHead className="text-right">Rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.person_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{r.name || '—'}</span>
                      {r.email && <span className="text-xs text-muted-foreground">{r.email}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.cancel_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.total}</TableCell>
                  <TableCell className="text-right tabular-nums">{pct(r.rate, 1)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function Watchlist({ rows }: { rows: Array<{ reservation_id: string; room_name: string; organizer_name: string; organizer_email: string | null; start_at: string; released_at: string | null; attendee_count: number | null }> }) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent no-show watchlist</CardTitle>
        <CardDescription>Latest 20 bookings whose start time passed without a check-in.</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Room</TableHead>
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
                <TableCell>
                  <div className="flex flex-col">
                    <span>{r.organizer_name || '—'}</span>
                    {r.organizer_email && <span className="text-xs text-muted-foreground">{r.organizer_email}</span>}
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">{r.attendee_count ?? '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export default RoomBookingNoShowsReport;
