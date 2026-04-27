import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SectionCards, type SectionCardItem } from '@/components/section-cards';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useBookingsOverview } from '@/api/booking-reports';
import { formatCount } from '@/lib/format';
import { browserTz, isoDaysAgo, pct, todayIso } from './format';
import { BookingsFilterBar } from './components/bookings-filter-bar';
import { BookingsVolumeChart } from './components/bookings-volume-chart';
import { UtilizationHeatmap } from './components/utilization-heatmap';
import { TopRoomsTable } from './components/top-rooms-table';
import { NoShowWatchlist } from './components/no-show-watchlist';
import { LeadTimeChart, DurationChart } from './components/bucket-charts';
import { ServicesAttachSection } from './components/services-attach-section';

interface FilterState {
  from: string;
  to: string;
  buildingId: string | null;
}

function readFilters(params: URLSearchParams): FilterState {
  return {
    from: params.get('from') || isoDaysAgo(30),
    to:   params.get('to')   || todayIso(),
    buildingId: params.get('building') || null,
  };
}

function writeFilters(prev: URLSearchParams, next: FilterState): URLSearchParams {
  const out = new URLSearchParams(prev);
  out.set('from', next.from);
  out.set('to',   next.to);
  if (next.buildingId) out.set('building', next.buildingId);
  else                 out.delete('building');
  return out;
}

export function RoomBookingReportsPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => readFilters(params), [params]);
  const tz = useMemo(() => browserTz(), []);

  const { data, isLoading, error, isFetching } = useBookingsOverview({
    from: filters.from,
    to:   filters.to,
    building_id: filters.buildingId,
    tz,
  });

  const setFilters = (next: FilterState) => setParams(writeFilters(params, next));

  return (
    <div className="@container/main flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
          <BookingsFilterBar value={filters} onChange={setFilters} />
        </div>

        {error && (
          <div className="px-4 lg:px-6">
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load bookings overview</AlertTitle>
              <AlertDescription>
                {error instanceof Error ? error.message : 'Unexpected error'}
              </AlertDescription>
            </Alert>
          </div>
        )}

        {isLoading || !data ? (
          <ReportSkeleton />
        ) : data.kpis.total_bookings === 0 && data.kpis.rooms_in_scope > 0 ? (
          <EmptyWindow />
        ) : (
          <ReportBody data={data} stale={isFetching} />
        )}
      </div>
    </div>
  );
}

function ReportBody({
  data, stale,
}: {
  data: NonNullable<ReturnType<typeof useBookingsOverview>['data']>;
  stale: boolean;
}) {
  const k = data.kpis;
  const kpis: SectionCardItem[] = [
    {
      description: 'Total bookings',
      title: formatCount(k.total_bookings),
      trend: { direction: 'up', label: `${formatCount(k.active_bookings)} active` },
      footerPrimary: 'Bookings in window',
      footerSecondary: 'Excludes drafts',
    },
    {
      description: 'Utilization',
      title: pct(k.utilization, 1),
      trend: { direction: 'up', label: `${formatCount(k.rooms_in_scope)} rooms` },
      footerPrimary: 'Booked hours / bookable',
      footerSecondary: '08:00–18:00, weekdays',
    },
    {
      description: 'No-shows',
      title: formatCount(k.no_show_count),
      trend: {
        direction: k.no_show_rate > 0.1 ? 'down' : 'up',
        label: `${pct(k.no_show_rate, 1)} rate`,
      },
      footerPrimary: 'Confirmed but no check-in',
      footerSecondary: 'Released after grace expired',
    },
    {
      description: 'Cancellations',
      title: formatCount(k.cancellation_count),
      trend: {
        direction: k.cancellation_rate > 0.15 ? 'down' : 'up',
        label: `${pct(k.cancellation_rate, 1)} rate`,
      },
      footerPrimary: 'Cancelled before start',
      footerSecondary: 'All cancellation reasons',
    },
    {
      description: 'Avg seat fill',
      title: k.avg_seat_fill == null ? '—' : pct(k.avg_seat_fill, 1),
      trend: { direction: 'up', label: 'of capacity' },
      footerPrimary: 'How full each booking was',
      footerSecondary: 'Excludes rooms without capacity',
    },
    {
      description: 'Services attach',
      title: pct(k.services_attach_rate, 1),
      trend: { direction: 'up', label: 'with services' },
      footerPrimary: 'Bookings with bundled services',
      footerSecondary: 'Catering, AV, etc.',
    },
  ];

  return (
    <div className={`flex flex-col gap-4 md:gap-6 ${stale ? 'opacity-90' : ''}`}>
      <SectionCards items={kpis} />
      <div className="px-4 lg:px-6">
        <BookingsVolumeChart data={data.volume_by_day} />
      </div>
      <div className="px-4 lg:px-6">
        <UtilizationHeatmap cells={data.utilization_heatmap} />
      </div>
      <div className="px-4 lg:px-6">
        <TopRoomsTable rows={data.top_rooms} />
      </div>
      <div className="px-4 lg:px-6">
        <NoShowWatchlist rows={data.no_show_watchlist} />
      </div>
      <div className="grid gap-4 px-4 lg:px-6 md:grid-cols-2">
        <LeadTimeChart data={data.lead_time_buckets} />
        <DurationChart data={data.duration_buckets} />
      </div>
      <div className="px-4 lg:px-6">
        <ServicesAttachSection
          rate={data.kpis.services_attach_rate}
          breakdown={data.services_breakdown}
        />
      </div>
    </div>
  );
}

function ReportSkeleton() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-[140px] rounded-xl" />
        ))}
      </div>
      <div className="px-4 lg:px-6">
        <Skeleton className="h-[280px] rounded-xl" />
      </div>
      <div className="px-4 lg:px-6">
        <Skeleton className="h-[260px] rounded-xl" />
      </div>
    </div>
  );
}

function EmptyWindow() {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-medium">No bookings in this window</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        Try widening the date range or selecting a different building.
      </p>
    </div>
  );
}

export default RoomBookingReportsPage;
