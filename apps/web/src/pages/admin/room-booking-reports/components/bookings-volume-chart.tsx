import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer, ChartLegend, ChartLegendContent,
  ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatShortDate } from '@/lib/format';
import type { VolumeByDayPoint } from '@/api/booking-reports/types';

const config = {
  confirmed: { label: 'Confirmed', color: 'oklch(0.62 0.19 250)' },
  completed: { label: 'Completed', color: 'oklch(0.70 0.16 155)' },
  cancelled: { label: 'Cancelled', color: 'oklch(0.78 0.04 270)' },
  no_show:   { label: 'No-show',   color: 'oklch(0.65 0.21 25)' },
} satisfies ChartConfig;

export function BookingsVolumeChart({ data }: { data: VolumeByDayPoint[] }) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Bookings volume</CardTitle>
        <CardDescription>
          <span className="hidden @[540px]/card:block">By day in the selected window</span>
          <span className="@[540px]/card:hidden">By day</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-4 sm:px-6 sm:pt-6">
        <ChartContainer config={config} className="aspect-auto h-[260px] w-full">
          <AreaChart data={data}>
            <defs>
              {(['confirmed', 'completed', 'cancelled', 'no_show'] as const).map((k) => (
                <linearGradient key={k} id={`fill-${k}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={`var(--color-${k})`} stopOpacity={0.85} />
                  <stop offset="95%" stopColor={`var(--color-${k})`} stopOpacity={0.05} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false} axisLine={false} tickMargin={8} minTickGap={32}
              tickFormatter={(v) => formatShortDate(v)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={36} />
            <ChartTooltip
              cursor={false}
              content={
                <ChartTooltipContent
                  labelFormatter={(v) => formatShortDate(v as string)}
                  indicator="dot"
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area dataKey="confirmed" type="natural" stackId="a"
                  fill="url(#fill-confirmed)" stroke="var(--color-confirmed)" />
            <Area dataKey="completed" type="natural" stackId="a"
                  fill="url(#fill-completed)" stroke="var(--color-completed)" />
            <Area dataKey="cancelled" type="natural" stackId="a"
                  fill="url(#fill-cancelled)" stroke="var(--color-cancelled)" />
            <Area dataKey="no_show"   type="natural" stackId="a"
                  fill="url(#fill-no_show)"   stroke="var(--color-no_show)" />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
