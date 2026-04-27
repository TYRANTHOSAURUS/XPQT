import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCount } from '@/lib/format';
import { pct } from '../format';

const TYPE_LABELS: Record<string, string> = {
  meeting:     'Meeting',
  event:       'Event',
  desk_day:    'Desk day',
  parking:     'Parking',
  hospitality: 'Hospitality',
  other:       'Other',
};

export function ServicesAttachSection({
  rate,
  breakdown,
}: {
  rate: number;
  breakdown: Record<string, number>;
}) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((sum, [, n]) => sum + n, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Services attach</CardTitle>
        <CardDescription>
          What share of bookings come with linked services (catering, AV, etc.).
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <div className="flex flex-col">
            <span className="text-3xl font-semibold tabular-nums">{pct(rate, 1)}</span>
            <span className="text-sm text-muted-foreground">of bookings have services</span>
          </div>
          <div className="flex-1">
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No services attached to bookings in this window.
              </p>
            ) : (
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {entries.map(([type, n]) => (
                  <li key={type} className="flex items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {TYPE_LABELS[type] ?? type}
                    </span>
                    <span className="tabular-nums">
                      {formatCount(n)}
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({total > 0 ? pct(n / total) : '—'})
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
