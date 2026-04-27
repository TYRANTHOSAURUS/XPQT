import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { browserTz, isoDaysAgo, todayIso } from '../format';
import { BookingsFilterBar } from './bookings-filter-bar';

export interface ReportFilters {
  from: string;
  to: string;
  buildingId: string | null;
}

export function useReportFilters(): [ReportFilters, (next: ReportFilters) => void, string] {
  const [params, setParams] = useSearchParams();
  const filters = useMemo<ReportFilters>(() => ({
    from: params.get('from') || isoDaysAgo(30),
    to:   params.get('to')   || todayIso(),
    buildingId: params.get('building') || null,
  }), [params]);
  const tz = useMemo(() => browserTz(), []);

  const setFilters = (next: ReportFilters) => {
    const out = new URLSearchParams(params);
    out.set('from', next.from);
    out.set('to', next.to);
    if (next.buildingId) out.set('building', next.buildingId);
    else                 out.delete('building');
    setParams(out);
  };

  return [filters, setFilters, tz];
}

interface BookingsReportShellProps {
  filters: ReportFilters;
  onFiltersChange: (next: ReportFilters) => void;
  isLoading: boolean;
  error: unknown;
  isFetching: boolean;
  hasData: boolean;
  emptyState?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * Shared shell for every bookings report. Provides the filter row, error
 * banner, loading skeleton, and stale-fade. Each report just renders its
 * own body inside.
 */
export function BookingsReportShell({
  filters, onFiltersChange,
  isLoading, error, isFetching, hasData,
  emptyState, children,
}: BookingsReportShellProps) {
  return (
    <div className="@container/main flex flex-1 flex-col gap-2">
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="flex flex-wrap items-center gap-2 px-4 lg:px-6">
          <BookingsFilterBar value={filters} onChange={onFiltersChange} />
        </div>

        {error ? (
          <div className="px-4 lg:px-6">
            <Alert variant="destructive">
              <AlertTitle>Couldn&apos;t load report</AlertTitle>
              <AlertDescription>
                {error instanceof Error ? error.message : 'Unexpected error'}
              </AlertDescription>
            </Alert>
          </div>
        ) : null}

        {isLoading ? (
          <ReportLoadingSkeleton />
        ) : !hasData && emptyState ? (
          emptyState
        ) : (
          <div className={`flex flex-col gap-4 md:gap-6 ${isFetching ? 'opacity-90' : ''}`}>
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

function ReportLoadingSkeleton() {
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
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

export function EmptyWindow({ message }: { message?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <h2 className="text-lg font-medium">No data in this window</h2>
      <p className="text-sm text-muted-foreground max-w-md">
        {message ?? 'Try widening the date range or selecting a different building.'}
      </p>
    </div>
  );
}
