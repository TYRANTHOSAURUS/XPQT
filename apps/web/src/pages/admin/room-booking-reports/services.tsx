import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { useBookingsServices } from '@/api/booking-reports';
import { formatCount, formatCurrency, formatShortDate } from '@/lib/format';
import { pct } from './format';
import { BookingsReportShell, EmptyWindow, useReportFilters } from './components/report-shell';

const TYPE_LABELS: Record<string, string> = {
  meeting: 'Meeting', event: 'Event', desk_day: 'Desk day',
  parking: 'Parking', hospitality: 'Hospitality', other: 'Other',
};

const byTypeConfig = {
  bookings: { label: 'Bookings', color: 'oklch(0.62 0.19 250)' },
} satisfies ChartConfig;

const trendConfig = {
  est_cost: { label: 'Cost',     color: 'oklch(0.70 0.16 155)' },
} satisfies ChartConfig;

export function RoomBookingServicesReport() {
  const [filters, setFilters, tz] = useReportFilters();
  const { data, isLoading, error, isFetching } = useBookingsServices({
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
      emptyState={<EmptyWindow message="No bookings in this window. Services data will appear once bookings are created." />}
    >
      {data ? <ServicesBody data={data} /> : null}
    </BookingsReportShell>
  );
}

function ServicesBody({ data }: { data: NonNullable<ReturnType<typeof useBookingsServices>['data']> }) {
  const k = data.kpis;
  const kpis: SectionCardItem[] = [
    {
      description: 'Attach rate',
      title: pct(k.attach_rate, 1),
      trend: { direction: 'up', label: `${formatCount(k.bookings_with_services)} of ${formatCount(k.total_bookings)}` },
      footerPrimary: 'Bookings with services',
      footerSecondary: 'Catering / AV / setup',
    },
    {
      description: 'Total est. spend',
      title: formatCurrency(k.total_estimated_cost),
      trend: { direction: 'up', label: `${formatCount(k.total_orders)} orders` },
      footerPrimary: 'Sum of line totals',
      footerSecondary: 'Excludes cancelled lines',
    },
    {
      description: 'Avg cost / booking',
      title: formatCurrency(k.avg_cost_per_serviced_booking),
      trend: { direction: 'up', label: 'with services' },
      footerPrimary: 'Per serviced bundle',
      footerSecondary: 'Spend density',
    },
    {
      description: 'Bundles',
      title: formatCount(k.bundles_with_services),
      trend: { direction: 'up', label: 'with non-cancelled orders' },
      footerPrimary: 'Active bundles in window',
      footerSecondary: 'Counts unique bundles',
    },
  ];

  return (
    <>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <CostTrendChart points={data.trend_by_day} />
      </div>
      <div className="grid gap-4 px-4 lg:px-6 md:grid-cols-2">
        <ByBundleTypeChart rows={data.by_bundle_type} />
        <TopCatalogItemsTable rows={data.top_catalog_items} />
      </div>
      <div className="px-4 lg:px-6">
        <ByCostCenterTable rows={data.by_cost_center} />
      </div>
    </>
  );
}

function CostTrendChart({ points }: { points: Array<{ date: string; serviced_bundles: number; est_cost: number }> }) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Estimated spend over time</CardTitle>
        <CardDescription>Daily total cost across all serviced bookings.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={trendConfig} className="aspect-auto h-[240px] w-full">
          <AreaChart data={points}>
            <defs>
              <linearGradient id="fill-cost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="var(--color-est_cost)" stopOpacity={0.7} />
                <stop offset="95%" stopColor="var(--color-est_cost)" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32}
                   tickFormatter={(v) => formatShortDate(v)} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={48}
                   tickFormatter={(v) => formatCurrency(v as number)} />
            <ChartTooltip cursor={false} content={
              <ChartTooltipContent
                labelFormatter={(v) => formatShortDate(v as string)}
                formatter={(value, name) => name === 'est_cost'
                  ? [formatCurrency(value as number), 'Cost']
                  : [String(value), 'Bundles']
                }
                indicator="dot"
              />
            } />
            <Area dataKey="est_cost" type="natural" fill="url(#fill-cost)" stroke="var(--color-est_cost)" />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function ByBundleTypeChart({ rows }: { rows: Array<{ bundle_type: string; bookings: number; orders: number; est_cost: number }> }) {
  const data = rows.map((r) => ({
    bucket: TYPE_LABELS[r.bundle_type] ?? r.bundle_type,
    bookings: r.bookings,
    est_cost: r.est_cost,
  }));
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>By bundle type</CardTitle>
        <CardDescription>Where the services money goes.</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6 sm:pt-4">
        <ChartContainer config={byTypeConfig} className="aspect-auto h-[200px] w-full">
          <BarChart data={data}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="bucket" tickLine={false} axisLine={false} tickMargin={8} />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip cursor={false} content={
              <ChartTooltipContent
                formatter={(value, name) => name === 'bookings'
                  ? [String(value), 'Bookings']
                  : [formatCurrency(value as number), 'Cost']
                }
                indicator="dot"
              />
            } />
            <Bar dataKey="bookings" fill="var(--color-bookings)" radius={4} />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function TopCatalogItemsTable({ rows }: { rows: Array<{ catalog_item_id: string; name: string | null; line_count: number; total_qty: number; est_cost: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top catalog items</CardTitle>
        <CardDescription>By estimated spend in window.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No service line items.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.catalog_item_id}>
                  <TableCell className="font-medium">{r.name ?? '—'}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.total_qty)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.est_cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ByCostCenterTable({ rows }: { rows: Array<{ cost_center_id: string; code: string | null; name: string | null; bookings: number; est_cost: number }> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>By cost center</CardTitle>
        <CardDescription>Chargeback view — who's spending on services.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No cost-centered bookings.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Cost center</TableHead>
                <TableHead className="text-right">Bookings</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.cost_center_id}>
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{r.name ?? '—'}</span>
                      {r.code && <span className="text-xs text-muted-foreground">{r.code}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatCount(r.bookings)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCurrency(r.est_cost)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export default RoomBookingServicesReport;
