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
  | 'unassigned';

interface TraceEntry {
  step: ChosenBy;
  matched: boolean;
  reason: string;
  target: { kind: Kind; team_id?: string; user_id?: string; vendor_id?: string } | null;
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
  context_snapshot: {
    tenant_id: string;
    request_type_id: string;
    domain: string | null;
    priority: string;
    location_id: string | null;
    asset_id: string | null;
    excluded_rule_ids: string[];
  };
  duration_ms: number;
}

interface RequestTypeDTO { id: string; name: string; domain: string | null }
interface SpaceDTO { id: string; name: string }
interface AssetDTO { id: string; name: string | null; tag: string | null }

// ---- Priority options (matches resolver context values used elsewhere) ----
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
type Priority = (typeof PRIORITIES)[number];

export function RoutingSimulator() {
  const { data: requestTypes } = useApi<RequestTypeDTO[]>('/request-types', []);
  const { data: spaces } = useApi<SpaceDTO[]>('/spaces', []);
  const { data: assets } = useApi<AssetDTO[]>('/assets', []);

  const [requestTypeId, setRequestTypeId] = useState<string>('');
  const [locationId, setLocationId] = useState<string>('');
  const [assetId, setAssetId] = useState<string>('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [disabledRules, setDisabledRules] = useState<Record<string, string>>({});

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
  }, [requestTypeId, locationId, assetId, priority, disabledRules]);

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

  const unassigned = result.decision.chosen_by === 'unassigned';
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
    case 'unassigned': return 'Unassigned';
  }
}
