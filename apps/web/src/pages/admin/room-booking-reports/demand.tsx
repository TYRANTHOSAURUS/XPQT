import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { useBookingsDemand } from '@/api/booking-reports';
import { formatCount, formatShortDate } from '@/lib/format';
import { dowLabel, hourLabel, pct } from './format';
import { BookingsReportShell, EmptyWindow, useReportFilters } from './components/report-shell';

const dailyConfig = {
  bookings:           { label: 'Bookings',           color: 'oklch(0.62 0.19 250)' },
  distinct_organizers: { label: 'Distinct organizers', color: 'oklch(0.70 0.16 155)' },
} satisfies ChartConfig;

const leadConfig = {
  count: { label: 'Bookings', color: 'oklch(0.62 0.19 250)' },
} satisfies ChartConfig;

export function RoomBookingDemandReport() {
  const [filters, setFilters, tz] = useReportFilters();
  const { data, isLoading, error, isFetching } = useBookingsDemand({
    from: filters.from, to: filters.to, building_id: filters.buildingId, tz,
  });

  return (
    <BookingsReportShell
      filters={filters}
      onFiltersChange={setFilters}
      isLoading={isLoading}
      error={error}
      isFetching={isFetching}
      hasData={!!data && data.kpis.total_bookings > 0}
      emptyState={<EmptyWindow message="No bookings to analyze in this window." />}
    >
      {data ? <DemandBody data={data} /> : null}
    </BookingsReportShell>
  );
}

function DemandBody({ data }: { data: NonNullable<ReturnType<typeof useBookingsDemand>['data']> }) {
  const k = data.kpis;
  const peak = k.peak_hour_local != null && k.peak_dow != null
    ? `${dowLabel(k.peak_dow)} ${hourLabel(k.peak_hour_local)}`
    : '—';
  const kpis: SectionCardItem[] = [
    {
      description: 'Total bookings',
      title: formatCount(k.total_bookings),
      trend: { direction: 'up', label: `${formatCount(k.rooms_in_scope)} rooms` },
      footerPrimary: 'In selected window',
      footerSecondary: 'Excludes drafts',
    },
    {
      description: 'Avg / business day',
      title: k.avg_bookings_per_business_day.toFixed(1),
      trend: { direction: 'up', label: 'bookings' },
      footerPrimary: 'Mon–Fri average',
      footerSecondary: 'Demand baseline',
    },
    {
      description: 'Peak slot',
      title: peak,
      trend: { direction: 'up', label: 'busiest hour' },
      footerPrimary: 'When the most bookings start',
      footerSecondary: 'Local time',
    },
    {
      description: 'Last-minute bookings',
      title: formatCount(data.creation_lead_buckets.same_day),
      trend: { direction: 'up', label: '< 2h ahead' },
      footerPrimary: 'Same-day creates',
      footerSecondary: 'Friction signal',
    },
  ];

  return (
    <>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <DemandHeatmap cells={data.demand_by_hour_dow} />
      </div>
      <div className="px-4 lg:px-6">
        <DailyDemandChart points={data.demand_by_day} />
      </div>
      <div className="grid gap-4 px-4 lg:px-6 md:grid-cols-2">
        <CreationLeadChart buckets={data.creation_lead_buckets} />
        <ContendedRoomsTable rows={data.top_contended_rooms} />
      </div>
    </>
  );
}

const HOURS = Array.from({ length: 13 }, (_, i) => 8 + i);
const DOWS  = [1, 2, 3, 4, 5, 6, 7];

function rampColor(util: number): string {
  if (util <= 0)   return 'transparent';
  if (util < 0.10) return 'oklch(0.92 0.04 250 / 0.7)';
  if (util < 0.25) return 'oklch(0.85 0.07 250)';
  if (util < 0.50) return 'oklch(0.75 0.13 250)';
  if (util < 0.75) return 'oklch(0.65 0.18 250)';
  return                  'oklch(0.55 0.22 250)';
}

function DemandHeatmap({ cells }: { cells: Array<{ dow: number; hour: number; occupied_rooms: number; bookings: number; rooms_in_scope: number; utilization: number }> }) {
  const lookup = new Map<string, typeof cells[number]>();
  for (const c of cells) lookup.set(`${c.dow}:${c.hour}`, c);

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Demand heatmap</CardTitle>
        <CardDescription>Bookings overlapping each (day, hour) cell. Local time, business hours.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="inline-block min-w-full">
          <div className="grid gap-1 text-xs text-muted-foreground" style={{ gridTemplateColumns: `48px repeat(${HOURS.length}, 1fr)` }}>
            <div />
            {HOURS.map((h) => <div key={h} className="text-center tabular-nums">{hourLabel(h)}</div>)}
          </div>
          <div className="mt-1 flex flex-col gap-1">
            {DOWS.map((dow) => (
              <div key={dow} className="grid gap-1" style={{ gridTemplateColumns: `48px repeat(${HOURS.length}, 1fr)` }}>
                <div className="text-xs text-muted-foreground self-center">{dowLabel(dow)}</div>
                {HOURS.map((hour) => {
                  const cell = lookup.get(`${dow}:${hour}`);
                  const util = cell?.utilization ?? 0;
                  const occ  = cell?.occupied_rooms ?? 0;
                  const cap  = cell?.rooms_in_scope ?? 0;
                  const bookings = cell?.bookings ?? 0;
                  return (
                    <div key={hour}
                      className="aspect-square rounded-sm border border-border/40"
                      style={{ backgroundColor: rampColor(util) }}
                      title={`${dowLabel(dow)} ${hourLabel(hour)} — ${pct(util)} (${occ}/${cap}) · ${bookings} overlapping`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function DailyDemandChart({ points }: { points: Array<{ date: string; bookings: number; distinct_organizers: number }> }) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Daily volume</CardTitle>
        <CardDescription>Bookings + distinct organizers per day.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={dailyConfig} className="aspect-auto h-[240px] w-full">
          <LineChart data={points}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32}
                   tickFormatter={(v) => formatShortDate(v)} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(v) => formatShortDate(v as string)} indicator="dot" />} />
            <Line dataKey="bookings"            type="natural" stroke="var(--color-bookings)"            strokeWidth={2} dot={false} />
            <Line dataKey="distinct_organizers" type="natural" stroke="var(--color-distinct_organizers)" strokeWidth={2} dot={false} />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function CreationLeadChart({ buckets }: { buckets: { same_day: number; lt_24h: number; lt_7d: number; ge_7d: number } }) {
  const data = [
    { bucket: 'Same day', count: buckets.same_day },
    { bucket: '< 24h',    count: buckets.lt_24h },
    { bucket: '1–7 days', count: buckets.lt_7d },
    { bucket: '≥ 7 days', count: buckets.ge_7d },
  ];
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>How far ahead people book</CardTitle>
        <CardDescription>Lead time from booking creation to start.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6 sm:pt-4">
        <ChartContainer config={leadConfig} className="aspect-auto h-[180px] w-full">
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

function ContendedRoomsTable({ rows }: { rows: Array<{ space_id: string; name: string; capacity: number | null; bookings: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Most contended rooms</CardTitle>
        <CardDescription>Top 10 by booking count. Add capacity here first.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No bookings yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Room</TableHead>
                <TableHead className="text-right">Capacity</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.space_id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.capacity ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.bookings)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default RoomBookingDemandReport;
