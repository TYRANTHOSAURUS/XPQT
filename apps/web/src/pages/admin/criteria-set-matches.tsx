import { useParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  SettingsPageHeader,
  SettingsPageShell,
} from '@/components/ui/settings-page';
import { useCriteriaSetMatches } from '@/api/criteria-sets';

/**
 * Drill-down page that shows every person currently matching a saved criteria
 * set. Reached from the Preview group's "Show all N matches" link when the
 * sample on the detail page couldn't fit everyone. Capped at 2000 rows by the
 * backend — tenants bigger than that will see a "+N more" note at the bottom.
 */
export function CriteriaSetMatchesPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading } = useCriteriaSetMatches(id);

  const backTo = id ? `/admin/criteria-sets/${id}` : '/admin/criteria-sets';

  if (isLoading) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader backTo={backTo} title="Loading matches…" />
      </SettingsPageShell>
    );
  }

  if (!data) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader
          backTo={backTo}
          title="Criteria set not found"
          description="It may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  const truncated = data.matches.length < data.count;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo={backTo}
        title={`Matches for "${data.criteriaSet.name}"`}
        description={
          data.criteriaSet.description
            ? `${data.criteriaSet.description} · ${data.count} ${data.count === 1 ? 'person matches' : 'persons match'}`
            : `${data.count} ${data.count === 1 ? 'person matches' : 'persons match'} right now.`
        }
      />

      {data.matches.length === 0 ? (
        <div className="rounded-lg border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No persons match this criteria set.
        </div>
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Email</TableHead>
                <TableHead className="w-[140px]">Type</TableHead>
                <TableHead className="w-[200px]">Primary org</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.matches.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">
                    {`${p.first_name} ${p.last_name}`.trim() || p.id}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">{p.email ?? '—'}</TableCell>
                  <TableCell>
                    {p.type ? (
                      <Badge variant="outline" className="font-normal">{p.type}</Badge>
                    ) : (
                      <span className="text-muted-foreground text-sm">—</span>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {p.primary_org ? (
                      <span className="flex items-center gap-2">
                        {p.primary_org.code && (
                          <Badge variant="secondary" className="font-mono text-[10px]">
                            {p.primary_org.code}
                          </Badge>
                        )}
                        <span className="truncate">{p.primary_org.name ?? '—'}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {truncated && (
            <div className="text-xs text-muted-foreground text-center py-2">
              Showing {data.matches.length} of {data.count} · refine the expression to narrow results.
            </div>
          )}
        </>
      )}
    </SettingsPageShell>
  );
}
