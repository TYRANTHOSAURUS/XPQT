import { Link } from 'react-router-dom';
import { Map } from 'lucide-react';
import {
  SettingsPageShell,
  SettingsPageHeader,
} from '@/components/ui/settings-page';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { useAdminFloorPlansIndex, type FloorPlanIndexRow } from '@/api/floor-plans/hooks';

export function FloorPlansIndexPage() {
  const { data, isLoading } = useAdminFloorPlansIndex();

  const isEmpty = !isLoading && (data?.length ?? 0) === 0;

  return (
    <SettingsPageShell>
      <SettingsPageHeader
        backTo="/admin"
        title="Floor plans"
        description="Upload floor images and trace room polygons to enable the visual room picker in the booking portal."
        actions={
          <Link
            to="/admin/locations"
            className={cn(buttonVariants({ variant: 'outline' }), 'gap-1.5')}
          >
            Manage buildings &amp; floors →
          </Link>
        }
      />

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading…</div>
      )}

      {isEmpty && (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <Map className="size-10 text-muted-foreground/50" />
          <p className="text-sm font-medium">No floors yet</p>
          <p className="max-w-xs text-sm text-muted-foreground">
            Add buildings and floors under{' '}
            <Link to="/admin/locations" className="underline underline-offset-2">
              Locations
            </Link>
            , then come back here to draw floor plans.
          </p>
        </div>
      )}

      {!isLoading && data && data.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Floor</TableHead>
              <TableHead>Building</TableHead>
              <TableHead className="w-[120px]">Plan</TableHead>
              <TableHead className="w-[180px]">Last published</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((row: FloorPlanIndexRow) => (
              <TableRow key={row.id}>
                <TableCell className="font-medium">
                  <Link
                    to={`/admin/floor-plans/${row.id}`}
                    className="hover:underline underline-offset-2"
                  >
                    {row.name}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.building_name}
                </TableCell>
                <TableCell>
                  <Badge variant={row.has_plan ? 'default' : 'secondary'}>
                    {row.has_plan ? 'published' : 'no plan'}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {row.last_published_at ? (
                    <time
                      dateTime={row.last_published_at}
                      title={formatFullTimestamp(row.last_published_at)}
                    >
                      {formatRelativeTime(row.last_published_at)}
                    </time>
                  ) : (
                    '—'
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </SettingsPageShell>
  );
}
