import { useMemo, useState } from 'react';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { AlertTriangle, CheckCircle2, CircleSlash } from 'lucide-react';
import { TableLoading, TableEmpty } from '@/components/table-states';
import { useApi } from '@/hooks/use-api';

type ChosenBy =
  | 'rule'
  | 'asset_override'
  | 'asset_type_default'
  | 'location_team'
  | 'parent_location_team'
  | 'space_group_team'
  | 'domain_fallback'
  | 'request_type_default'
  | 'policy_row'
  | 'policy_default'
  | 'scope_override'
  | 'scope_override_unassigned'
  | 'unassigned';

interface DecisionRow {
  id: string;
  ticket_id: string;
  decided_at: string;
  strategy: string;
  chosen_by: ChosenBy;
  rule_id: string | null;
  rule_name: string | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
  context: Record<string, unknown>;
}

type RoutingHook = 'case_owner' | 'child_dispatch';

interface SideView {
  chosen_by: string | null;
  target_kind: 'team' | 'user' | 'vendor' | null;
  target_id: string | null;
  target_name: string | null;
}

interface DualRunLogRow {
  id: string;
  evaluated_at: string;
  hook: RoutingHook;
  mode: 'dualrun' | 'shadow' | 'v2_only';
  ticket_id: string | null;
  request_type_id: string | null;
  request_type_name: string | null;
  legacy: SideView;
  v2: SideView;
  target_match: boolean | null;
  chosen_by_match: boolean | null;
  diff_summary: Record<string, unknown>;
}

const CHOSEN_BY_OPTIONS: ChosenBy[] = [
  'rule',
  'asset_override',
  'asset_type_default',
  'location_team',
  'parent_location_team',
  'space_group_team',
  'domain_fallback',
  'request_type_default',
  'policy_row',
  'policy_default',
  'scope_override',
  'scope_override_unassigned',
  'unassigned',
];

const SINCE_OPTIONS = [
  { value: '24h', label: 'Last 24h' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];

type SincePreset = '24h' | '7d' | '30d' | 'all';

const PAGE_SIZE = 50;

function sinceIso(preset: SincePreset): string {
  if (preset === 'all') return '';
  const map = { '24h': 1, '7d': 7, '30d': 30 } as const;
  return new Date(Date.now() - map[preset] * 24 * 60 * 60 * 1000).toISOString();
}

export function RoutingAuditTab() {
  return (
    <Tabs defaultValue="decisions" className="flex flex-col gap-4">
      <TabsList>
        <TabsTrigger value="decisions">Decisions</TabsTrigger>
        <TabsTrigger value="dualrun">Dual-run diffs</TabsTrigger>
      </TabsList>
      <TabsContent value="decisions">
        <DecisionsAudit />
      </TabsContent>
      <TabsContent value="dualrun">
        <DualRunAudit />
      </TabsContent>
    </Tabs>
  );
}

function DecisionsAudit() {
  const [chosenByFilter, setChosenByFilter] = useState<'' | ChosenBy>('');
  const [ticketIdFilter, setTicketIdFilter] = useState('');
  const [sincePreset, setSincePreset] = useState<SincePreset>('7d');
  const [offset, setOffset] = useState(0);

  const since = useMemo(() => sinceIso(sincePreset), [sincePreset]);

  const path = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    if (chosenByFilter) qs.set('chosen_by', chosenByFilter);
    if (ticketIdFilter.trim()) qs.set('ticket_id', ticketIdFilter.trim());
    if (since) qs.set('since', since);
    return `/routing/studio/decisions?${qs.toString()}`;
  }, [chosenByFilter, ticketIdFilter, since, offset]);

  const { data, loading } = useApi<{ rows: DecisionRow[]; total: number }>(path, [path]);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        <FieldGroup className="flex flex-row flex-wrap gap-4">
          <Field className="w-48">
            <FieldLabel htmlFor="audit-chosen-by">Chosen by</FieldLabel>
            <Select
              value={chosenByFilter || '__all'}
              onValueChange={(v) => {
                setChosenByFilter(v === '__all' || !v ? '' : (v as ChosenBy));
                setOffset(0);
              }}
            >
              <SelectTrigger id="audit-chosen-by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All</SelectItem>
                {CHOSEN_BY_OPTIONS.map((c) => (
                  <SelectItem key={c} value={c}>{c.replace(/_/g, ' ')}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-40">
            <FieldLabel htmlFor="audit-since">Window</FieldLabel>
            <Select
              value={sincePreset}
              onValueChange={(v) => { setSincePreset((v ?? '7d') as SincePreset); setOffset(0); }}
            >
              <SelectTrigger id="audit-since">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SINCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-80">
            <FieldLabel htmlFor="audit-ticket">Ticket id</FieldLabel>
            <Input
              id="audit-ticket"
              placeholder="Filter by ticket id…"
              value={ticketIdFilter}
              onChange={(e) => { setTicketIdFilter(e.target.value); setOffset(0); }}
            />
          </Field>
        </FieldGroup>

        <div className="ml-auto text-xs text-muted-foreground">
          {total} decision{total === 1 ? '' : 's'}
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Ticket</TableHead>
              <TableHead>Chose</TableHead>
              <TableHead>Target</TableHead>
              <TableHead>Rule</TableHead>
              <TableHead>Context</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !data ? (
              <TableLoading cols={6} />
            ) : rows.length === 0 ? (
              <TableEmpty cols={6} message="No routing decisions match the filters." />
            ) : (
              rows.map((row) => <DecisionRowView key={row.id} row={row} />)
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination offset={offset} total={total} rowCount={rows.length} setOffset={setOffset} canPrev={canPrev} canNext={canNext} />
    </div>
  );
}

function DualRunAudit() {
  const [hookFilter, setHookFilter] = useState<'' | RoutingHook>('');
  const [sincePreset, setSincePreset] = useState<SincePreset>('7d');
  const [onlyDivergent, setOnlyDivergent] = useState(false);
  const [offset, setOffset] = useState(0);

  const since = useMemo(() => sinceIso(sincePreset), [sincePreset]);

  const path = useMemo(() => {
    const qs = new URLSearchParams();
    qs.set('limit', String(PAGE_SIZE));
    qs.set('offset', String(offset));
    if (hookFilter) qs.set('hook', hookFilter);
    if (onlyDivergent) qs.set('only_divergent', 'true');
    if (since) qs.set('since', since);
    return `/routing/studio/dualrun-logs?${qs.toString()}`;
  }, [hookFilter, onlyDivergent, since, offset]);

  const { data, loading } = useApi<{ rows: DualRunLogRow[]; total: number }>(path, [path]);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted-foreground">
        Every ticket create in <code>dualrun</code> or <code>shadow</code> mode writes a row here
        comparing what legacy and v2 would each choose. Set the tenant flag
        <code className="mx-1">routing_v2_mode</code> to enable. Users always see the legacy
        outcome until mode flips to <code>v2_only</code>.
      </p>

      <div className="flex flex-wrap items-end gap-4">
        <FieldGroup className="flex flex-row flex-wrap gap-4">
          <Field className="w-48">
            <FieldLabel htmlFor="dualrun-hook">Hook</FieldLabel>
            <Select
              value={hookFilter || '__all'}
              onValueChange={(v) => {
                setHookFilter(v === '__all' || !v ? '' : (v as RoutingHook));
                setOffset(0);
              }}
            >
              <SelectTrigger id="dualrun-hook">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all">All hooks</SelectItem>
                <SelectItem value="case_owner">Case owner</SelectItem>
                <SelectItem value="child_dispatch">Child dispatch</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-40">
            <FieldLabel htmlFor="dualrun-since">Window</FieldLabel>
            <Select
              value={sincePreset}
              onValueChange={(v) => { setSincePreset((v ?? '7d') as SincePreset); setOffset(0); }}
            >
              <SelectTrigger id="dualrun-since">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SINCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field className="w-56">
            <FieldLabel htmlFor="dualrun-divergent">Rows</FieldLabel>
            <Select
              value={onlyDivergent ? 'divergent' : 'all'}
              onValueChange={(v) => { setOnlyDivergent(v === 'divergent'); setOffset(0); }}
            >
              <SelectTrigger id="dualrun-divergent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="divergent">Only divergent</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FieldGroup>

        <div className="ml-auto text-xs text-muted-foreground">
          {total} row{total === 1 ? '' : 's'}
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Hook</TableHead>
              <TableHead>Request type</TableHead>
              <TableHead>Legacy</TableHead>
              <TableHead>v2</TableHead>
              <TableHead>Match</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && !data ? (
              <TableLoading cols={6} />
            ) : rows.length === 0 ? (
              <TableEmpty cols={6} message="No dual-run diffs. Flip tenants.feature_flags.routing_v2_mode to 'dualrun' to start capturing." />
            ) : (
              rows.map((row) => <DualRunRowView key={row.id} row={row} />)
            )}
          </TableBody>
        </Table>
      </div>

      <Pagination offset={offset} total={total} rowCount={rows.length} setOffset={setOffset} canPrev={canPrev} canNext={canNext} />
    </div>
  );
}

function DecisionRowView({ row }: { row: DecisionRow }) {
  const ago = safeRelative(row.decided_at);
  const targetLabel =
    row.target_name ??
    (row.target_id ? row.target_id.slice(0, 8) : row.chosen_by === 'unassigned' ? '—' : null);

  return (
    <TableRow>
      <TableCell>
        <div className="text-sm">{ago}</div>
        <div className="text-xs text-muted-foreground">{new Date(row.decided_at).toLocaleString()}</div>
      </TableCell>
      <TableCell>
        <code className="text-xs">{row.ticket_id.slice(0, 8)}</code>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{row.chosen_by.replace(/_/g, ' ')}</Badge>
      </TableCell>
      <TableCell>
        {row.target_kind ? (
          <span>
            <span className="text-xs text-muted-foreground">{row.target_kind} · </span>
            {targetLabel}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {row.rule_name ? (
          <span className="text-sm">{row.rule_name}</span>
        ) : (
          <span className="text-xs text-muted-foreground">{row.strategy}</span>
        )}
      </TableCell>
      <TableCell>
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">view</summary>
          <pre className="mt-1 max-w-md overflow-auto rounded bg-muted px-2 py-1 text-xs">
{JSON.stringify(row.context, null, 2)}
          </pre>
        </details>
      </TableCell>
    </TableRow>
  );
}

function DualRunRowView({ row }: { row: DualRunLogRow }) {
  const hasV2Error = typeof row.diff_summary?.v2_error === 'string';
  const match = row.target_match === true;
  return (
    <TableRow>
      <TableCell>
        <div className="text-sm">{safeRelative(row.evaluated_at)}</div>
        <div className="text-xs text-muted-foreground">{new Date(row.evaluated_at).toLocaleString()}</div>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{row.hook.replace('_', ' ')}</Badge>
      </TableCell>
      <TableCell>
        <span className="text-sm">{row.request_type_name ?? <code className="text-xs">{row.request_type_id?.slice(0, 8) ?? '—'}</code>}</span>
      </TableCell>
      <TableCell>
        <SideSummary side={row.legacy} />
      </TableCell>
      <TableCell>
        <SideSummary side={row.v2} />
      </TableCell>
      <TableCell>
        {hasV2Error ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-destructive">
            <AlertTriangle className="size-4" />
            {String(row.diff_summary.v2_error).split(':')[0] || 'v2 error'}
          </span>
        ) : match ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700">
            <CheckCircle2 className="size-4" />
            matches
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-xs text-amber-700">
            <CircleSlash className="size-4" />
            divergent
          </span>
        )}
      </TableCell>
    </TableRow>
  );
}

function SideSummary({ side }: { side: SideView }) {
  if (!side.chosen_by && !side.target_kind) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <div className="flex flex-col">
      <span className="text-sm">
        {side.target_name ?? (side.target_id ? side.target_id.slice(0, 8) : <em>unassigned</em>)}
      </span>
      <span className="text-xs text-muted-foreground">
        {side.chosen_by?.replace(/_/g, ' ') ?? '—'}
      </span>
    </div>
  );
}

function Pagination({
  offset, total, rowCount, setOffset, canPrev, canNext,
}: {
  offset: number;
  total: number;
  rowCount: number;
  setOffset: (n: number) => void;
  canPrev: boolean;
  canNext: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <div className="text-xs text-muted-foreground">
        {rowCount > 0 ? `Showing ${offset + 1}–${offset + rowCount} of ${total}` : null}
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={!canPrev} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
          Previous
        </Button>
        <Button variant="outline" size="sm" disabled={!canNext} onClick={() => setOffset(offset + PAGE_SIZE)}>
          Next
        </Button>
      </div>
    </div>
  );
}

function safeRelative(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const sec = Math.round(diffMs / 1000);
    if (sec < 60) return `${sec}s ago`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    return `${day}d ago`;
  } catch {
    return iso;
  }
}
