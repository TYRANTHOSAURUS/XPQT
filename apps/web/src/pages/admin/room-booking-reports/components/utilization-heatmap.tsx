import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { HeatmapCell } from '@/api/booking-reports/types';
import { dowLabel, hourLabel, pct } from '../format';

const HOURS = Array.from({ length: 13 }, (_, i) => 8 + i);  // 08..20
const DOWS  = [1, 2, 3, 4, 5, 6, 7];                         // Mon..Sun

function rampColor(util: number): string {
  // Blue ramp aligned with the rest of the app's chart palette.
  if (util <= 0)         return 'transparent';
  if (util < 0.10)       return 'oklch(0.92 0.04 250 / 0.7)';
  if (util < 0.25)       return 'oklch(0.85 0.07 250)';
  if (util < 0.50)       return 'oklch(0.75 0.13 250)';
  if (util < 0.75)       return 'oklch(0.65 0.18 250)';
  return                        'oklch(0.55 0.22 250)';
}

export function UtilizationHeatmap({ cells }: { cells: HeatmapCell[] }) {
  // Index cells by (dow, hour) for O(1) lookup.
  const lookup = new Map<string, HeatmapCell>();
  for (const c of cells) lookup.set(`${c.dow}:${c.hour}`, c);

  return (
    <Card className="@container/card">
      <CardHeader>
        <CardTitle>Utilization heatmap</CardTitle>
        <CardDescription>
          Share of rooms occupied by hour and day. Local time, business hours only.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <div className="inline-block min-w-full">
          {/* hour header */}
          <div
            className="grid gap-1 text-xs text-muted-foreground"
            style={{ gridTemplateColumns: `48px repeat(${HOURS.length}, 1fr)` }}
          >
            <div />
            {HOURS.map((h) => (
              <div key={h} className="text-center tabular-nums">{hourLabel(h)}</div>
            ))}
          </div>
          {/* rows */}
          <div className="mt-1 flex flex-col gap-1">
            {DOWS.map((dow) => (
              <div
                key={dow}
                className="grid gap-1"
                style={{ gridTemplateColumns: `48px repeat(${HOURS.length}, 1fr)` }}
              >
                <div className="text-xs text-muted-foreground self-center">
                  {dowLabel(dow)}
                </div>
                {HOURS.map((hour) => {
                  const cell = lookup.get(`${dow}:${hour}`);
                  const util = cell?.utilization ?? 0;
                  const occ  = cell?.occupied_rooms ?? 0;
                  const cap  = cell?.rooms_in_scope ?? 0;
                  return (
                    <div
                      key={hour}
                      className="aspect-square rounded-sm border border-border/40"
                      style={{ backgroundColor: rampColor(util) }}
                      title={`${dowLabel(dow)} ${hourLabel(hour)} — ${pct(util)} (${occ}/${cap})`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* legend */}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <span>Less</span>
            {[0.05, 0.20, 0.40, 0.60, 0.85].map((u) => (
              <div
                key={u}
                className="size-3 rounded-sm border border-border/40"
                style={{ backgroundColor: rampColor(u) }}
              />
            ))}
            <span>More</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
