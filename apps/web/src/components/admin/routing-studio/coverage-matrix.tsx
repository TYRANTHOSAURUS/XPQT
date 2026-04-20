import { useMemo, useState } from 'react';
import { useApi } from '@/hooks/use-api';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle } from 'lucide-react';

type CoverageChosenBy =
  | 'direct'
  | 'parent'
  | 'space_group'
  | 'domain_fallback'
  | 'uncovered';

interface CoverageSpace {
  id: string;
  name: string;
  parent_id: string | null;
  depth: number;
  path: string[];
}

interface CoverageCell {
  space_id: string;
  domain: string;
  chosen_by: CoverageChosenBy;
  target_kind: 'team' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
  via_parent_space_id: string | null;
  via_space_group_id: string | null;
  via_space_group_name: string | null;
  via_parent_domain: string | null;
}

interface CoverageResponse {
  spaces: CoverageSpace[];
  domains: string[];
  cells: CoverageCell[];
  truncated: boolean;
}

type Filter = 'all' | 'gaps' | 'explicit';

export function CoverageMatrix() {
  const [filter, setFilter] = useState<Filter>('all');

  const { data, loading, error } = useApi<CoverageResponse>('/routing/studio/coverage', []);

  const cellIndex = useMemo(() => {
    const map = new Map<string, CoverageCell>();
    for (const c of data?.cells ?? []) {
      map.set(`${c.space_id}::${c.domain}`, c);
    }
    return map;
  }, [data]);

  const visibleSpaces = useMemo(() => {
    const spaces = data?.spaces ?? [];
    const domains = data?.domains ?? [];
    if (filter === 'all') return spaces;
    return spaces.filter((s) =>
      domains.some((d) => {
        const cell = cellIndex.get(`${s.id}::${d}`);
        if (!cell) return false;
        if (filter === 'gaps') return cell.chosen_by === 'uncovered';
        if (filter === 'explicit') return cell.chosen_by === 'direct' || cell.chosen_by === 'space_group';
        return true;
      }),
    );
  }, [filter, data, cellIndex]);

  if (loading && !data) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-60 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Coverage failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!data || data.spaces.length === 0 || data.domains.length === 0) {
    return (
      <div className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        {data?.spaces.length === 0
          ? 'No spaces in this tenant yet.'
          : 'No domains in use. Create a request type or a location-team mapping first.'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Header + filter */}
      <div className="flex items-end gap-4">
        <FieldGroup className="flex flex-row gap-4">
          <Field className="w-44">
            <FieldLabel htmlFor="cov-filter">Show</FieldLabel>
            <Select value={filter} onValueChange={(v) => setFilter((v ?? 'all') as Filter)}>
              <SelectTrigger id="cov-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All spaces</SelectItem>
                <SelectItem value="gaps">Gaps only</SelectItem>
                <SelectItem value="explicit">With direct/group rule</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>
        <div className="ml-auto text-xs text-muted-foreground">
          {data.spaces.length} spaces × {data.domains.length} domains = {data.cells.length} cells
          {data.truncated ? ' — truncated, apply filters to narrow' : ''}
        </div>
      </div>

      {/* Matrix */}
      <div className="overflow-auto rounded-md border">
        <table className="min-w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-background">
            <tr>
              <th className="sticky left-0 z-20 border-b border-r bg-background px-3 py-2 text-left font-medium">
                Space
              </th>
              {data.domains.map((d) => (
                <th key={d} className="border-b px-3 py-2 text-left font-medium text-muted-foreground">
                  {d}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleSpaces.map((space) => (
              <tr key={space.id}>
                <th
                  scope="row"
                  className="sticky left-0 z-10 border-b border-r bg-background px-3 py-1.5 text-left font-normal"
                  style={{ paddingLeft: `${12 + space.depth * 12}px` }}
                  title={space.path.join(' / ')}
                >
                  {space.name}
                </th>
                {data.domains.map((d) => {
                  const cell = cellIndex.get(`${space.id}::${d}`);
                  return (
                    <td key={d} className="border-b px-3 py-1.5">
                      <Cell cell={cell} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Legend />
    </div>
  );
}

function Cell({ cell }: { cell: CoverageCell | undefined }) {
  if (!cell) return <span className="text-xs text-muted-foreground">—</span>;

  const tone = toneFor(cell);
  const prefix = prefixFor(cell);
  const label = cell.target_name ?? (cell.chosen_by === 'uncovered' ? 'no handler' : '—');
  const title = titleFor(cell);

  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${toneClass(tone)}`} title={title}>
      {prefix && <span className="text-xs opacity-70">{prefix}</span>}
      <span>{label}</span>
    </span>
  );
}

function Legend() {
  const items: Array<{ label: string; sample: string; prefix: string; tone: ReturnType<typeof toneFor> }> = [
    { label: 'direct', prefix: '', sample: 'FM Team', tone: 'direct' },
    { label: 'inherited from parent', prefix: '↑', sample: 'Campus FM', tone: 'inherited' },
    { label: 'via space group', prefix: '◇', sample: 'East FM', tone: 'group' },
    { label: 'domain fallback', prefix: '↳', sample: 'FM (via fm)', tone: 'fallback' },
    { label: 'uncovered', prefix: '⚠', sample: 'no handler', tone: 'uncovered' },
  ];
  return (
    <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
      {items.map((i) => (
        <div key={i.label} className="flex items-center gap-1">
          <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${toneClass(i.tone)}`}>
            {i.prefix && <span className="opacity-70">{i.prefix}</span>}
            <span>{i.sample}</span>
          </span>
          <span>{i.label}</span>
        </div>
      ))}
    </div>
  );
}

type Tone = 'direct' | 'inherited' | 'group' | 'fallback' | 'uncovered';

function toneFor(cell: CoverageCell): Tone {
  switch (cell.chosen_by) {
    case 'direct': return 'direct';
    case 'parent': return 'inherited';
    case 'space_group': return 'group';
    case 'domain_fallback': return 'fallback';
    case 'uncovered': return 'uncovered';
  }
}

function toneClass(tone: Tone): string {
  switch (tone) {
    case 'direct':     return 'bg-emerald-500/10 text-emerald-900 dark:text-emerald-200';
    case 'inherited':  return 'bg-muted text-muted-foreground';
    case 'group':      return 'bg-sky-500/10 text-sky-900 dark:text-sky-200 border border-dashed border-sky-500/40';
    case 'fallback':   return 'bg-amber-500/10 text-amber-900 dark:text-amber-200';
    case 'uncovered':  return 'bg-destructive/10 text-destructive';
  }
}

function prefixFor(cell: CoverageCell): string {
  switch (cell.chosen_by) {
    case 'direct': return '';
    case 'parent': return '↑';
    case 'space_group': return '◇';
    case 'domain_fallback': return '↳';
    case 'uncovered': return '⚠';
  }
}

function titleFor(cell: CoverageCell): string {
  switch (cell.chosen_by) {
    case 'direct': return 'Direct location-team row for this (space, domain).';
    case 'parent': return 'Inherited from a parent space in the location hierarchy.';
    case 'space_group': return `Resolved via space group${cell.via_space_group_name ? ` "${cell.via_space_group_name}"` : ''}.`;
    case 'domain_fallback': return `Resolved via domain fallback (matched parent domain "${cell.via_parent_domain}").`;
    case 'uncovered': return 'No handler resolves for this (space, domain). Ticket would fall through to request-type default or unassigned.';
  }
}
