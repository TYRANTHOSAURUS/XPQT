import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useTicketsByTeam } from '@/api/reports';
import { formatCount } from '@/lib/format';
import { ReportShell } from './_shell';

type ByTeamResponse = Record<string, { open: number; at_risk: number }>;

export function TeamsReport() {
  const { data } = useTicketsByTeam<ByTeamResponse>();
  const entries = Object.entries(data ?? {}).sort((a, b) => b[1].open - a[1].open);

  return (
    <ReportShell
      title="Team workload"
      description="Open tickets and SLA exposure by assigned team."
    >
      <div className="px-4 lg:px-6">
        <Card className="@container/card">
          <CardHeader>
            <CardTitle>Workload breakdown</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Team</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">At risk</TableHead>
                  <TableHead className="text-right">At-risk rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      No team data.
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map(([name, stats]) => {
                    const rate = stats.open > 0 ? Math.round((stats.at_risk / stats.open) * 100) : 0;
                    return (
                      <TableRow key={name}>
                        <TableCell className="font-medium">{name}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(stats.open)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatCount(stats.at_risk)}</TableCell>
                        <TableCell className="text-right">
                          <Badge variant={rate >= 30 ? 'destructive' : rate >= 10 ? 'secondary' : 'outline'}>
                            {rate}%
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </ReportShell>
  );
}
