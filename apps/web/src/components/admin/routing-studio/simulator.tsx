import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertTriangle, CheckCircle2, ChevronDown, CircleSlash, Clock, PlayCircle, X } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';

// ---- DTO types (mirror backend `SimulatorResult`) ----
type Kind = 'team' | 'user' | 'vendor';
type ChosenBy =
  | 'rule'
  | 'asset_override'
  | 'asset_type_default'
  | 'location_team'
  | 'parent_location_team'
  | 'space_group_team'
  | 'domain_fallback'
  | 'request_type_default'
  // v2 values (Contract 4). Added when the evaluator simulates v2 alongside legacy.
  | 'policy_row'
  | 'policy_default'
  // Scope-override pre-step (live-doc §6.3). `scope_override_unassigned` is
  // the handler_kind='none' terminal — admin explicitly blocks auto-routing
  // at that scope.
  | 'scope_override'
  | 'scope_override_unassigned'
  | 'unassigned';

type RoutingHook = 'case_owner' | 'child_dispatch';

interface V2DecisionView {
  hook: RoutingHook;
  chosen_by: ChosenBy | null;
  target_kind: Kind | null;
  target_id: string | null;
  target_name: string | null;
  trace: TraceEntry[];
  error: string | null;
  matches_legacy_target: boolean;
}

interface TraceEntry {
  step: ChosenBy;
  matched: boolean;
  reason: string;
  target: { kind: Kind; team_id?: string; user_id?: string; vendor_id?: string } | null;
}

interface PortalAvailabilityTraceView {
  authorized: boolean;
  has_any_scope: boolean;
  effective_location_id: string | null;
  matched_root_id: string | null;
  matched_root_source: 'default' | 'grant' | null;
  grant_id: string | null;
  visible: boolean;
  location_required: boolean;
  granularity: string | null;
  granularity_ok: boolean;
  overall_valid: boolean;
  failure_reason: string | null;
}

interface PortalAvailabilityView {
  person_id: string;
  current_location_id: string | null;
  acting_for_location_id: string | null;
  trace: PortalAvailabilityTraceView;
  authorized_locations_summary: Array<{
    id: string;
    name: string;
    type: string;
    source: 'default' | 'grant';
    grant_id: string | null;
  }>;
}

interface SimulatorResult {
  decision: {
    chosen_by: ChosenBy;
    strategy: string;
    rule_id: string | null;
    rule_name: string | null;
    target_kind: Kind | null;
    target_id: string | null;
    target_name: string | null;
  };
  effects: {
    sla_policy_id: string | null;
    sla_policy_name: string | null;
    workflow_definition_id: string | null;
    workflow_definition_name: string | null;
    fulfillment_strategy: string;
    domain: string | null;
  };
  trace: TraceEntry[];
  v2: V2DecisionView[] | null;
  context_snapshot: {
    tenant_id: string;
    request_type_id: string;
    domain: string | null;
    priority: string;
    location_id: string | null;
    asset_id: string | null;
    excluded_rule_ids: string[];
  };
  portal_availability?: PortalAvailabilityView;
  duration_ms: number;
}

interface RequestTypeDTO { id: string; name: string; domain: string | null }
interface SpaceDTO { id: string; name: string }
interface AssetDTO { id: string; name: string | null; tag: string | null }
interface PersonDTO { id: string; first_name: string; last_name: string; email: string | null }

// ---- Priority options (matches resolver context values used elsewhere) ----
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

export function RoutingSimulator() {
  const { data: requestTypes } = useApi<RequestTypeDTO[]>('/request-types', []);
  const { data: spaces } = useApi<SpaceDTO[]>('/spaces', []);
  const { data: assets } = useApi<AssetDTO[]>('/assets', []);
  const { data: persons } = useApi<PersonDTO[]>('/persons', []);

  const [requestTypeId, setRequestTypeId] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [assetId, setAssetId] = useState<string>('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [disabledRules, setDisabledRules] = useState<Record<string, string>>({});

  // Portal-scope simulation inputs. When simulateAsPersonId is set, the backend
  // runs request_type_requestable_trace as a prefix and returns .portal_availability.
  const [simulateAsPersonId, setSimulateAsPersonId] = useState<string>('');
  const [currentLocationId, setCurrentLocationId] = useState<string>('');
  const [actingForLocationId, setActingForLocationId] = useState<string>('');

  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track the current request so stale responses don't overwrite newer ones.
  const requestSeqRef = useRef(0);

  const runSimulate = useCallback(async () => {
    if (!requestTypeId) {
      setResult(null);
      setError(null);
      return;
    }
    const seq = ++requestSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const body = {
        request_type_id: requestTypeId,
        location_id: locationId || null,
        asset_id: assetId || null,
        priority,
        disabled_rule_ids: Object.keys(disabledRules),
        include_v2: true,
        // Portal-scope extension — backend runs request_type_requestable_trace
        // as a prefix when simulate_as_person_id is set.
        simulate_as_person_id: simulateAsPersonId || null,
        current_location_id: currentLocationId || null,
        acting_for_location_id: actingForLocationId || null,
      };
      const data = await apiFetch<SimulatorResult>('/routing/studio/simulate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      if (seq === requestSeqRef.current) setResult(data);
    } catch (e) {
      if (seq === requestSeqRef.current) {
        setError(e instanceof Error ? e.message : 'Simulation failed');
      }
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [requestTypeId, locationId, assetId, priority, disabledRules, simulateAsPersonId, currentLocationId, actingForLocationId]);

  // Debounced auto-run on input change — protects DB from fast dropdown thrashing.
  useEffect(() => {
    const id = setTimeout(() => { runSimulate(); }, 150);
    return () => clearTimeout(id);
  }, [runSimulate]);

  const disabledRulesList = useMemo(
    () => Object.entries(disabledRules).map(([id, name]) => ({ id, name })),
    [disabledRules],
  );

  const handleDisableRule = (id: string, name: string) => {
    setDisabledRules((prev) => ({ ...prev, [id]: name }));
  };
  const handleRestoreRule = (id: string) => {
    setDisabledRules((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };
  const handleReset = () => {
    setDisabledRules({});
    setLocationId('');
    setAssetId('');
    setPriority('normal');
    setSimulateAsPersonId('');
    setCurrentLocationId('');
    setActingForLocationId('');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <PlayCircle className="size-4 text-muted-foreground" />
          Simulate a ticket
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Pick inputs to see where a ticket would land. Nothing is saved.
        </p>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Inputs */}
        <FieldSet>
          <FieldLegend variant="label">Inputs</FieldLegend>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="sim-request-type">Request type</FieldLabel>
                <Select value={requestTypeId} onValueChange={(v) => setRequestTypeId(v ?? '')}>
                  <SelectTrigger id="sim-request-type">
                    <SelectValue placeholder="Select a request type…" />
                  </SelectTrigger>
                  <SelectContent>
                    {(requestTypes ?? []).map((rt) => (
                      <SelectItem key={rt.id} value={rt.id}>
                        {rt.name}
                        {rt.domain ? <span className="text-muted-foreground"> · {rt.domain}</span> : null}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Drives domain, strategy and defaults.</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="sim-priority">Priority</FieldLabel>
                <Select value={priority} onValueChange={(v) => setPriority((v ?? 'normal') as Priority)}>
                  <SelectTrigger id="sim-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="sim-location">Location</FieldLabel>
                <Select value={locationId || '__none'} onValueChange={(v) => setLocationId(v === '__none' || !v ? '' : v)}>
                  <SelectTrigger id="sim-location">
                    <SelectValue placeholder="No location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No location</SelectItem>
                    {(spaces ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="sim-asset">Asset</FieldLabel>
                <Select value={assetId || '__none'} onValueChange={(v) => setAssetId(v === '__none' || !v ? '' : v)}>
                  <SelectTrigger id="sim-asset">
                    <SelectValue placeholder="No asset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">No asset</SelectItem>
                    {(assets ?? []).map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name ?? a.tag ?? a.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>
        </FieldSet>

        {/* Portal-scope simulation */}
        <FieldSet>
          <FieldLegend variant="label">Simulate as a portal user (optional)</FieldLegend>
          <FieldGroup>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="sim-person">Person</FieldLabel>
                <Select
                  value={simulateAsPersonId || '__none'}
                  onValueChange={(v) => setSimulateAsPersonId(v === '__none' || !v ? '' : v)}
                >
                  <SelectTrigger id="sim-person">
                    <SelectValue placeholder="Not a portal simulation" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Not a portal simulation</SelectItem>
                    {(persons ?? []).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.first_name} {p.last_name}{p.email ? ` · ${p.email}` : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Answers "why can Ali request for Dubai?"</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="sim-current-location">Current location</FieldLabel>
                <Select
                  value={currentLocationId || '__none'}
                  onValueChange={(v) => setCurrentLocationId(v === '__none' || !v ? '' : v)}
                >
                  <SelectTrigger id="sim-current-location">
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">—</SelectItem>
                    {(spaces ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Where the requester is (diagnostic).</FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="sim-acting-for">Acting for</FieldLabel>
                <Select
                  value={actingForLocationId || '__none'}
                  onValueChange={(v) => setActingForLocationId(v === '__none' || !v ? '' : v)}
                >
                  <SelectTrigger id="sim-acting-for">
                    <SelectValue placeholder="Use current location" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">Use current location</SelectItem>
                    {(spaces ?? []).map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>Where the request is for (drives routing).</FieldDescription>
              </Field>
            </div>
          </FieldGroup>
        </FieldSet>

        {/* Portal availability result */}
        {result?.portal_availability && (
          <PortalAvailabilityBlock data={result.portal_availability} />
        )}

        {/* Disabled rules chips */}
        {disabledRulesList.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Disabled rules:</span>
            {disabledRulesList.map((r) => (
              <Badge key={r.id} variant="secondary" className="gap-1">
                {r.name}
                <button
                  type="button"
                  aria-label={`Restore rule ${r.name}`}
                  className="inline-flex items-center"
                  onClick={() => handleRestoreRule(r.id)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Button size="sm" variant="ghost" onClick={handleReset}>Reset</Button>
          </div>
        )}

        {/* Result */}
        <ResultBlock result={result} loading={loading} error={error} hasRequestType={!!requestTypeId} />

        {/* v2 preview — always requested; only rendered when present */}
        {result?.v2 && result.v2.length > 0 && (
          <V2Preview rows={result.v2} legacyTargetName={result.decision.target_name} />
        )}

        {/* Pipeline */}
        {result && (
          <Pipeline result={result} onDisableRule={handleDisableRule} />
        )}

        {/* Observability footer */}
        {result && (
          <div
            className="text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            Simulated in {result.duration_ms}ms. No ticket or audit row was written.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ----- subcomponents -----

function ResultBlock({
  result, loading, error, hasRequestType,
}: {
  result: SimulatorResult | null;
  loading: boolean;
  error: string | null;
  hasRequestType: boolean;
}) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Simulation failed</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!hasRequestType) {
    return (
      <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        Pick a request type to simulate how a ticket would be routed.
      </div>
    );
  }
  if (loading && !result) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (!result) return null;

  // Both 'unassigned' and 'scope_override_unassigned' produce a null target:
  // the first is "no rule matched," the second is the admin explicitly saying
  // "block auto-routing at this scope." Both render as the destructive
  // outcome; the chosen_by badge below distinguishes them.
  const unassigned =
    result.decision.chosen_by === 'unassigned' ||
    result.decision.chosen_by === 'scope_override_unassigned';
  return (
    <Alert variant={unassigned ? 'destructive' : 'default'}>
      {unassigned ? <CircleSlash className="size-4" /> : <CheckCircle2 className="size-4" />}
      <AlertTitle>
        {unassigned ? 'Would land unassigned' : `Assigns to ${result.decision.target_name ?? '—'}`}
      </AlertTitle>
      <AlertDescription className="space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">{result.decision.chosen_by.replace(/_/g, ' ')}</Badge>
          <Badge variant="outline">strategy: {result.decision.strategy}</Badge>
          {result.effects.domain ? <Badge variant="outline">domain: {result.effects.domain}</Badge> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" />
            SLA: {result.effects.sla_policy_name ?? <em>none</em>}
          </span>
          <span>Workflow: {result.effects.workflow_definition_name ?? <em>none</em>}</span>
        </div>
      </AlertDescription>
    </Alert>
  );
}

function Pipeline({
  result, onDisableRule,
}: {
  result: SimulatorResult;
  onDisableRule: (id: string, name: string) => void;
}) {
  const winningIndex = result.trace.findIndex((t) => t.matched && t.target != null);

  return (
    <div className="rounded-md border">
      <div className="border-b px-4 py-2 text-xs font-medium uppercase text-muted-foreground">
        Pipeline
      </div>
      <ul className="divide-y">
        {result.trace.map((entry, idx) => (
          <PipelineStep
            key={`${entry.step}-${idx}`}
            entry={entry}
            isWinner={idx === winningIndex}
            rule={
              entry.step === 'rule' && result.decision.rule_id && result.decision.rule_name
                ? { id: result.decision.rule_id, name: result.decision.rule_name }
                : null
            }
            onDisableRule={onDisableRule}
          />
        ))}
      </ul>
    </div>
  );
}

function PipelineStep({
  entry, isWinner, rule, onDisableRule,
}: {
  entry: TraceEntry;
  isWinner: boolean;
  rule: { id: string; name: string } | null;
  onDisableRule: (id: string, name: string) => void;
}) {
  const stepLabel = formatStep(entry.step);
  const icon = entry.matched
    ? <CheckCircle2 className="size-4 text-emerald-600" />
    : <CircleSlash className="size-4 text-muted-foreground" />;

  return (
    <li className="px-4 py-2">
      <Collapsible>
        <div className="flex items-center gap-3">
          {icon}
          <span className={isWinner ? 'font-medium' : ''}>{stepLabel}</span>
          <span className="text-xs text-muted-foreground">{entry.reason}</span>
          <div className="ml-auto flex items-center gap-2">
            {rule && isWinner && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => onDisableRule(rule.id, rule.name)}
              >
                Disable rule
              </Button>
            )}
            <CollapsibleTrigger
              className="inline-flex size-8 items-center justify-center rounded hover:bg-accent"
              aria-label="Toggle step details"
            >
              <ChevronDown className="size-4" />
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <pre className="mt-2 overflow-auto rounded bg-muted px-3 py-2 text-xs">
{JSON.stringify({ step: entry.step, matched: entry.matched, target: entry.target, reason: entry.reason }, null, 2)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

function PortalAvailabilityBlock({ data }: { data: PortalAvailabilityView }) {
  const { trace, authorized_locations_summary } = data;
  const ok = trace.overall_valid;

  return (
    <Alert variant={ok ? 'default' : 'destructive'}>
      {ok ? <CheckCircle2 className="size-4" /> : <CircleSlash className="size-4" />}
      <AlertTitle>
        {ok
          ? 'Portal submission would succeed'
          : `Portal submission blocked: ${trace.failure_reason ?? 'unknown'}`}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline">authorized: {String(trace.authorized)}</Badge>
          <Badge variant="outline">visible: {String(trace.visible)}</Badge>
          <Badge variant="outline">
            granularity: {trace.granularity ?? 'any'} {trace.granularity_ok ? '✓' : '✗'}
          </Badge>
          {trace.matched_root_source && (
            <Badge variant="outline" className="capitalize">
              matched via {trace.matched_root_source}
              {trace.grant_id ? ` (grant ${trace.grant_id.slice(0, 8)})` : ''}
            </Badge>
          )}
        </div>

        {authorized_locations_summary.length > 0 && (
          <div className="text-xs">
            <div className="font-medium mb-1">Authorized scope:</div>
            <ul className="space-y-0.5">
              {authorized_locations_summary.map((l) => (
                <li key={l.id} className="text-muted-foreground">
                  {l.name} <span className="capitalize">({l.type})</span>
                  {' · '}
                  <span className="capitalize">{l.source}</span>
                  {l.id === trace.matched_root_id && (
                    <Badge variant="outline" className="ml-2 text-[10px]">matched</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {authorized_locations_summary.length === 0 && (
          <div className="text-xs text-muted-foreground">
            No authorized scope. Assign a default work location or add a grant.
          </div>
        )}
      </AlertDescription>
    </Alert>
  );
}

function formatStep(step: ChosenBy): string {
  switch (step) {
    case 'rule': return 'Routing rule';
    case 'asset_override': return 'Asset override';
    case 'asset_type_default': return 'Asset type default';
    case 'location_team': return 'Location team';
    case 'parent_location_team': return 'Parent location team';
    case 'space_group_team': return 'Space group team';
    case 'domain_fallback': return 'Domain fallback';
    case 'request_type_default': return 'Request type default';
    case 'policy_row': return 'Policy row (v2)';
    case 'policy_default': return 'Policy default (v2)';
    case 'scope_override': return 'Scope override';
    case 'scope_override_unassigned': return 'Scope override (unassigned)';
    case 'unassigned': return 'Unassigned';
  }
}

function V2Preview({ rows, legacyTargetName }: { rows: V2DecisionView[]; legacyTargetName: string | null }) {
  return (
    <div className="rounded-md border">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <div className="text-xs font-medium uppercase text-muted-foreground">Routing v2 preview</div>
        <div className="text-xs text-muted-foreground">
          Runs both hooks regardless of the tenant flag. Legacy is what ships.
        </div>
      </div>
      <ul className="divide-y">
        {rows.map((row) => (
          <li key={row.hook} className="px-4 py-3">
            <div className="flex items-center gap-3">
              {row.error ? (
                <AlertTriangle className="size-4 text-destructive" />
              ) : row.matches_legacy_target ? (
                <CheckCircle2 className="size-4 text-emerald-600" />
              ) : (
                <CircleSlash className="size-4 text-amber-600" />
              )}
              <span className="font-medium">{row.hook === 'case_owner' ? 'Case owner' : 'Child dispatch'}</span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {row.chosen_by ? (
                  <Badge variant="outline">{row.chosen_by.replace(/_/g, ' ')}</Badge>
                ) : null}
                {row.matches_legacy_target ? (
                  <Badge variant="outline" className="border-emerald-600 text-emerald-700">matches legacy</Badge>
                ) : row.error ? null : (
                  <Badge variant="outline" className="border-amber-600 text-amber-700">divergent</Badge>
                )}
              </div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {row.error ? (
                <span>Error: {row.error}</span>
              ) : row.target_name ? (
                <span>
                  v2 picks <strong>{row.target_name}</strong>
                  {legacyTargetName && !row.matches_legacy_target ? (
                    <>
                      {' '} (legacy picks <strong>{legacyTargetName}</strong>)
                    </>
                  ) : null}
                </span>
              ) : (
                <span>
                  v2 returns unassigned — no published policy for this request type yet.
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
