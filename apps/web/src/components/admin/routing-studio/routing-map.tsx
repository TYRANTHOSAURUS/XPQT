import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleHelp,
  Info,
  Users,
  Wrench,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { ResolverPipelineStrip } from './resolver-pipeline-strip';
import { RoutingModeToggle } from './routing-mode-toggle';

interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  default_team_id: string | null;
  default_vendor_id: string | null;
  case_owner_policy_entity_id: string | null;
  child_dispatch_policy_entity_id: string | null;
}

interface Team { id: string; name: string }
interface Vendor { id: string; name: string }

interface CaseOwnerPolicy {
  schema_version: 1;
  rows: Array<{ id: string; match: { operational_scope_ids?: string[] }; target: { kind: 'team'; team_id: string } }>;
  default_target: { kind: 'team'; team_id: string };
}

interface ChildDispatchPolicy {
  schema_version: 1;
  dispatch_mode: string;
  split_strategy: string;
  execution_routing: 'fixed' | 'by_location';
  fixed_target?: { kind: 'team' | 'vendor'; id: string };
  fallback_target?: { kind: 'team' | 'vendor'; id: string };
}

interface PublishedResponse<T> {
  published: { definition: T; version_id: string } | null;
}

interface DualRunLogRow {
  id: string;
  hook: 'case_owner' | 'child_dispatch';
  request_type_id: string | null;
  target_match: boolean | null;
  chosen_by_match: boolean | null;
  diff_summary: Record<string, unknown>;
}

type ReadinessStatus = 'untested' | 'matches' | 'divergent' | 'error';

interface Readiness {
  status: ReadinessStatus;
  matches: number;
  mismatches: number;
  errors: number;
}

interface Props {
  onOpenTab: (tab: string) => void;
  onOpenForRequestType: (tab: 'case-ownership' | 'child-dispatch', rtId: string) => void;
}

/**
 * Routing Map — primary landing view for the Studio (Artifact C).
 *
 * Answers "for each of my request types, what happens today and under v2?"
 * in a single scannable table grouped by domain. Each row shows legacy
 * default, v2 case owner summary, v2 child dispatch summary, plus a quick
 * link to the editor for that request type.
 *
 * Replaces the previous Overview tab as the Studio's landing experience.
 * When there are no request types (empty tenant), shows the same onboarding
 * checklist the old Overview carried.
 */
export function RoutingMap({ onOpenTab, onOpenForRequestType }: Props) {
  const { data: requestTypes, loading: rtLoading } = useApi<RequestType[]>('/request-types', []);
  const { data: teams } = useApi<Team[]>('/teams', []);
  const { data: vendors } = useApi<Vendor[]>('/vendors', []);

  // Per-RT published policy cache. One fetch per attached entity on mount;
  // the policy store controller already re-validates via zod on read.
  const [caseOwnerByRt, setCaseOwnerByRt] = useState<Map<string, CaseOwnerPolicy | null>>(new Map());
  const [childDispatchByRt, setChildDispatchByRt] = useState<Map<string, ChildDispatchPolicy | null>>(new Map());
  const [policyLoading, setPolicyLoading] = useState(true);
  const [readinessByRt, setReadinessByRt] = useState<Map<string, Readiness>>(new Map());

  // Fetch recent dualrun diffs and aggregate per request_type. Gives admins
  // an at-a-glance "ready for v2_only?" signal per RT. 7 days is arbitrary
  // but matches the plan's "< 0.1% diff rate over 7 days per tenant"
  // cutover criterion.
  useEffect(() => {
    let cancelled = false;
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    apiFetch<{ rows: DualRunLogRow[] }>(
      `/routing/studio/dualrun-logs?limit=500&since=${encodeURIComponent(since)}`,
    )
      .then((res) => {
        if (cancelled) return;
        const agg = new Map<string, Readiness>();
        for (const row of res.rows ?? []) {
          if (!row.request_type_id) continue;
          const cur = agg.get(row.request_type_id) ?? { status: 'untested' as ReadinessStatus, matches: 0, mismatches: 0, errors: 0 };
          if (typeof row.diff_summary?.v2_error === 'string') cur.errors++;
          else if (row.target_match === true) cur.matches++;
          else if (row.target_match === false) cur.mismatches++;
          cur.status = cur.errors > 0 ? 'error' : cur.mismatches > 0 ? 'divergent' : cur.matches > 0 ? 'matches' : 'untested';
          agg.set(row.request_type_id, cur);
        }
        setReadinessByRt(agg);
      })
      .catch(() => { /* readiness is best-effort — silent fail is OK */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!requestTypes || requestTypes.length === 0) {
      setPolicyLoading(false);
      return;
    }
    let cancelled = false;
    setPolicyLoading(true);

    const caseOwnerJobs = requestTypes
      .filter((rt) => rt.case_owner_policy_entity_id)
      .map((rt) =>
        apiFetch<PublishedResponse<CaseOwnerPolicy>>(
          `/admin/routing/policies/case_owner_policy/${rt.case_owner_policy_entity_id}`,
        )
          .then((res) => ({ rt_id: rt.id, def: res.published?.definition ?? null }))
          .catch(() => ({ rt_id: rt.id, def: null })),
      );
    const childDispatchJobs = requestTypes
      .filter((rt) => rt.child_dispatch_policy_entity_id)
      .map((rt) =>
        apiFetch<PublishedResponse<ChildDispatchPolicy>>(
          `/admin/routing/policies/child_dispatch_policy/${rt.child_dispatch_policy_entity_id}`,
        )
          .then((res) => ({ rt_id: rt.id, def: res.published?.definition ?? null }))
          .catch(() => ({ rt_id: rt.id, def: null })),
      );

    Promise.all([Promise.all(caseOwnerJobs), Promise.all(childDispatchJobs)]).then(
      ([coResults, cdResults]) => {
        if (cancelled) return;
        setCaseOwnerByRt(new Map(coResults.map((r) => [r.rt_id, r.def])));
        setChildDispatchByRt(new Map(cdResults.map((r) => [r.rt_id, r.def])));
        setPolicyLoading(false);
      },
    );
    return () => { cancelled = true; };
  }, [requestTypes]);

  const teamsById = useMemo(() => new Map((teams ?? []).map((t) => [t.id, t])), [teams]);
  const vendorsById = useMemo(() => new Map((vendors ?? []).map((v) => [v.id, v])), [vendors]);

  // Empty-state onboarding lives inside the Routing Map instead of a separate Overview tab.
  if (!rtLoading && (requestTypes ?? []).length === 0) {
    return <RoutingMapEmpty onOpenTab={onOpenTab} />;
  }

  // Group request types by domain for scannability.
  const byDomain = useMemo(() => {
    const map = new Map<string, RequestType[]>();
    for (const rt of requestTypes ?? []) {
      const key = rt.domain ?? '(no domain)';
      const list = map.get(key) ?? [];
      list.push(rt);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [requestTypes]);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium uppercase text-muted-foreground">Routing Map</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Every request type in one view. Legacy routing is what ships today; v2 runs in
            parallel when the tenant flag is on — flip request types to policies-based routing
            one at a time.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenTab('simulator')}>
            Simulate a ticket
          </Button>
        </div>
      </header>

      <RoutingModeToggle />

      {/* Pipeline strip lives here (and only here) so admins see the legacy
        * resolver order alongside the request-type summary table. Other tabs
        * are task-oriented and don't need the pedagogical context. */}
      <ResolverPipelineStrip onTabClick={(t) => onOpenTab(t)} />

      {rtLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {byDomain.map(([domain, rts]) => (
            <DomainGroup
              key={domain}
              domain={domain}
              requestTypes={rts}
              caseOwnerByRt={caseOwnerByRt}
              childDispatchByRt={childDispatchByRt}
              readinessByRt={readinessByRt}
              teamsById={teamsById}
              vendorsById={vendorsById}
              policyLoading={policyLoading}
              onOpenForRequestType={onOpenForRequestType}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RoutingMapEmpty({ onOpenTab }: { onOpenTab: (tab: string) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <Info className="size-4" />
        <AlertTitle>No request types yet</AlertTitle>
        <AlertDescription>
          The Routing Map shows how each request type would route. Create a request type first,
          then return here.
        </AlertDescription>
      </Alert>
      <ol className="divide-y rounded-md border">
        <OnboardingStep
          done={false}
          label="Create at least one team"
          hint="Teams are the assignment groups routing lands work on."
          action={<Link to="/admin/teams" className="text-sm text-primary hover:underline">Open teams →</Link>}
        />
        <OnboardingStep
          done={false}
          label="Create at least one request type"
          hint="Carries the domain, strategy, and defaults every ticket inherits."
          action={<Link to="/admin/request-types" className="text-sm text-primary hover:underline">Open request types →</Link>}
        />
        <OnboardingStep
          done={false}
          label="Attach a case ownership policy"
          hint="Optional. Picks the parent-case owner team, with location-scoped overrides."
          action={
            <button
              type="button"
              className="text-sm text-primary hover:underline"
              onClick={() => onOpenTab('case-ownership')}
            >
              Open →
            </button>
          }
        />
      </ol>
    </div>
  );
}

function OnboardingStep({
  done, label, hint, action,
}: {
  done: boolean;
  label: string;
  hint: string;
  action: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {done ? (
        <CheckCircle2 className="size-4 text-emerald-600" />
      ) : (
        <Circle className="size-4 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-sm">{label}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
      <div className="shrink-0">{action}</div>
    </li>
  );
}

function DomainGroup({
  domain,
  requestTypes,
  caseOwnerByRt,
  childDispatchByRt,
  readinessByRt,
  teamsById,
  vendorsById,
  policyLoading,
  onOpenForRequestType,
}: {
  domain: string;
  requestTypes: RequestType[];
  caseOwnerByRt: Map<string, CaseOwnerPolicy | null>;
  childDispatchByRt: Map<string, ChildDispatchPolicy | null>;
  readinessByRt: Map<string, Readiness>;
  teamsById: Map<string, Team>;
  vendorsById: Map<string, Vendor>;
  policyLoading: boolean;
  onOpenForRequestType: (tab: 'case-ownership' | 'child-dispatch', rtId: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const caseOwnerDone = requestTypes.filter((rt) => rt.case_owner_policy_entity_id).length;
  const childDispatchDone = requestTypes.filter((rt) => rt.child_dispatch_policy_entity_id).length;

  return (
    <section className="rounded-md border">
      <header className="flex items-center gap-3 border-b bg-muted/30 px-3 py-2">
        <button
          type="button"
          className="inline-flex items-center gap-1 text-sm font-medium"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <code className="text-xs">{domain}</code>
          <span className="text-xs text-muted-foreground">
            · {requestTypes.length} request type{requestTypes.length === 1 ? '' : 's'}
          </span>
        </button>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <CoverageBadge label="case owner" done={caseOwnerDone} total={requestTypes.length} />
          <CoverageBadge label="child dispatch" done={childDispatchDone} total={requestTypes.length} />
        </div>
      </header>
      {open && (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs uppercase text-muted-foreground">
              <th className="px-3 py-2 text-left font-medium">Request type</th>
              <th className="px-3 py-2 text-left font-medium">Legacy default</th>
              <th className="px-3 py-2 text-left font-medium">
                <span className="inline-flex items-center gap-1">
                  <Users className="size-3" /> Case owner (v2)
                </span>
              </th>
              <th className="px-3 py-2 text-left font-medium">
                <span className="inline-flex items-center gap-1">
                  <Wrench className="size-3" /> Child dispatch (v2)
                </span>
              </th>
              <th className="px-3 py-2 text-left font-medium">Ready</th>
              <th className="px-3 py-2 text-right font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {requestTypes.map((rt) => (
              <RoutingMapRow
                key={rt.id}
                rt={rt}
                caseOwner={caseOwnerByRt.get(rt.id)}
                childDispatch={childDispatchByRt.get(rt.id)}
                readiness={readinessByRt.get(rt.id)}
                teamsById={teamsById}
                vendorsById={vendorsById}
                policyLoading={policyLoading}
                onOpenForRequestType={onOpenForRequestType}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CoverageBadge({ label, done, total }: { label: string; done: number; total: number }) {
  const tone =
    done === 0 ? '' : done === total ? 'border-emerald-600 text-emerald-700' : 'border-amber-600 text-amber-700';
  return (
    <Badge variant="outline" className={tone}>
      {label} {done}/{total}
    </Badge>
  );
}

function RoutingMapRow({
  rt,
  caseOwner,
  childDispatch,
  readiness,
  teamsById,
  vendorsById,
  policyLoading,
  onOpenForRequestType,
}: {
  rt: RequestType;
  caseOwner: CaseOwnerPolicy | null | undefined;
  childDispatch: ChildDispatchPolicy | null | undefined;
  readiness: Readiness | undefined;
  teamsById: Map<string, Team>;
  vendorsById: Map<string, Vendor>;
  policyLoading: boolean;
  onOpenForRequestType: (tab: 'case-ownership' | 'child-dispatch', rtId: string) => void;
}) {
  const legacyLabel = rt.default_team_id
    ? teamsById.get(rt.default_team_id)?.name ?? rt.default_team_id.slice(0, 8)
    : rt.default_vendor_id
      ? vendorsById.get(rt.default_vendor_id)?.name ?? rt.default_vendor_id.slice(0, 8)
      : null;

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30">
      <td className="px-3 py-2">
        <div className="font-medium">{rt.name}</div>
      </td>
      <td className="px-3 py-2">
        {legacyLabel ? (
          <span className="text-sm">{legacyLabel}</span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700">
            <CircleAlert className="size-3" />
            no default
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <CaseOwnerCell policy={caseOwner} loading={policyLoading && rt.case_owner_policy_entity_id !== null} teamsById={teamsById} />
      </td>
      <td className="px-3 py-2">
        <ChildDispatchCell
          policy={childDispatch}
          loading={policyLoading && rt.child_dispatch_policy_entity_id !== null}
          teamsById={teamsById}
          vendorsById={vendorsById}
        />
      </td>
      <td className="px-3 py-2">
        <ReadinessCell readiness={readiness} />
      </td>
      <td className="px-3 py-2 text-right">
        <div className="inline-flex items-center gap-1">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => onOpenForRequestType('case-ownership', rt.id)}
          >
            Case <ArrowRight className="inline size-3" />
          </button>
          <button
            type="button"
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
            onClick={() => onOpenForRequestType('child-dispatch', rt.id)}
          >
            Child <ArrowRight className="inline size-3" />
          </button>
        </div>
      </td>
    </tr>
  );
}

function ReadinessCell({ readiness }: { readiness: Readiness | undefined }) {
  if (!readiness) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="No dual-run diffs in the last 7 days. Flip routing_v2_mode to dualrun to start capturing.">
        <CircleHelp className="size-3.5" />
        untested
      </span>
    );
  }
  const total = readiness.matches + readiness.mismatches + readiness.errors;
  if (readiness.errors > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive" title={`${readiness.errors} v2 errors in ${total} diffs`}>
        <AlertTriangle className="size-3.5" />
        error
      </span>
    );
  }
  if (readiness.mismatches > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={`${readiness.mismatches}/${total} diffs have target_match=false`}>
        <CircleAlert className="size-3.5" />
        divergent ({readiness.mismatches}/{total})
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-emerald-700" title={`${readiness.matches}/${total} diffs match legacy. Safe to flip to v2_only.`}>
      <CheckCircle2 className="size-3.5" />
      ready ({readiness.matches})
    </span>
  );
}

function CaseOwnerCell({
  policy, loading, teamsById,
}: {
  policy: CaseOwnerPolicy | null | undefined;
  loading: boolean;
  teamsById: Map<string, Team>;
}) {
  if (loading) return <Skeleton className="h-4 w-24" />;
  if (policy === undefined || policy === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const defaultTeam = teamsById.get(policy.default_target.team_id)?.name ?? policy.default_target.team_id.slice(0, 8);
  const rowCount = policy.rows.length;
  return (
    <div className="flex flex-col">
      <span className="text-sm">{defaultTeam}</span>
      {rowCount > 0 && (
        <span className="text-xs text-muted-foreground">+ {rowCount} scoped row{rowCount === 1 ? '' : 's'}</span>
      )}
    </div>
  );
}

function ChildDispatchCell({
  policy, loading, teamsById, vendorsById,
}: {
  policy: ChildDispatchPolicy | null | undefined;
  loading: boolean;
  teamsById: Map<string, Team>;
  vendorsById: Map<string, Vendor>;
}) {
  if (loading) return <Skeleton className="h-4 w-24" />;
  if (policy === undefined || policy === null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  if (policy.execution_routing === 'by_location') {
    const fb = policy.fallback_target;
    const fbName = fb
      ? fb.kind === 'team'
        ? teamsById.get(fb.id)?.name
        : vendorsById.get(fb.id)?.name
      : null;
    return (
      <div className="flex flex-col">
        <span className="text-sm">by location</span>
        {fbName && <span className="text-xs text-muted-foreground">fallback: {fbName}</span>}
      </div>
    );
  }
  const fixed = policy.fixed_target;
  if (!fixed) return <span className="text-xs text-amber-700">no target set</span>;
  const name =
    fixed.kind === 'team'
      ? teamsById.get(fixed.id)?.name ?? fixed.id.slice(0, 8)
      : vendorsById.get(fixed.id)?.name ?? fixed.id.slice(0, 8);
  return (
    <div className="flex flex-col">
      <span className="text-sm">{name}</span>
      <span className="text-xs text-muted-foreground">{fixed.kind}</span>
    </div>
  );
}
