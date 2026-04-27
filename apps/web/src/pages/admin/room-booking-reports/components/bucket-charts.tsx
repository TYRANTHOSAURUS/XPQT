import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';
import {
  ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig,
} from '@/components/ui/chart';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const config = {
  count: { label: 'Bookings', color: 'oklch(0.62 0.19 250)' },
} satisfies ChartConfig;

interface BucketChartProps {
  title: string;
  description: string;
  data: Array<{ bucket: string; count: number }>;
}

function BucketChart({ title, description, data }: BucketChartProps) {
  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="px-2 pt-2 sm:px-6 sm:pt-4">
        <ChartContainer config={config} className="aspect-auto h-[180px] w-full">
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

export function LeadTimeChart({
  data,
}: {
  data: { same_day: number; lt_24h: number; lt_7d: number; ge_7d: number };
}) {
  return (
    <BucketChart
      title="Lead time"
      description="How far in advance bookings were made."
      data={[
        { bucket: 'Same day',  count: data.same_day },
        { bucket: '< 24h',     count: data.lt_24h },
        { bucket: '1–7 days',  count: data.lt_7d },
        { bucket: '≥ 7 days',  count: data.ge_7d },
      ]}
    />
  );
}

export function DurationChart({
  data,
}: {
  data: { le_30m: number; le_1h: number; le_2h: number; gt_2h: number };
}) {
  return (
    <BucketChart
      title="Duration"
      description="How long bookings were scheduled for."
      data={[
        { bucket: '≤ 30m',  count: data.le_30m },
        { bucket: '≤ 1h',   count: data.le_1h },
        { bucket: '≤ 2h',   count: data.le_2h },
        { bucket: '> 2h',   count: data.gt_2h },
      ]}
    />
  );
}
