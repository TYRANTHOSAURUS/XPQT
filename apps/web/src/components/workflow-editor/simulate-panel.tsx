import { useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { HistoryTimeline, type InstanceEvent } from './history-timeline';
import { useGraphStore } from './graph-store';
import type { SimulateResult } from '@/hooks/use-workflow';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onRun: (ticket: Record<string, unknown>) => Promise<SimulateResult>;
}

export function SimulatePanel({ open, onOpenChange, onRun }: Props) {
  const nodes = useGraphStore((s) => s.nodes);

  const fields = useMemo(() => {
    const set = new Set<string>();
    for (const n of nodes) if (n.type === 'condition') {
      const f = (n.config as { field?: string }).field;
      if (f) set.add(f);
    }
    return Array.from(set);
  }, [nodes]);

  const [ticket, setTicket] = useState<Record<string, string>>({});
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      setResult(await onRun(ticket));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation failed');
    } finally {
      setRunning(false);
    }
  };

  const resultEvents: InstanceEvent[] = (result?.events ?? []).map((e, i) => ({
    id: String(i),
    event_type: e.event_type,
    node_id: e.node_id ?? null,
    node_type: e.node_type ?? null,
    decision: e.decision ?? null,
    payload: e.payload ?? {},
    created_at: new Date().toISOString(),
  }));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[480px] sm:max-w-[480px] overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Simulate workflow</SheetTitle>
        </SheetHeader>
        <div className="grid gap-3 py-4">
          {fields.length === 0 ? (
            <p className="text-sm text-muted-foreground">This workflow has no condition nodes; simulation will follow the default path.</p>
          ) : (
            fields.map((f) => (
              <div key={f} className="grid gap-1.5">
                <Label className="text-xs">{f}</Label>
                <Input
                  value={ticket[f] ?? ''}
                  onChange={(e) => setTicket({ ...ticket, [f]: e.target.value })}
                  placeholder={`ticket.${f}`}
                />
              </div>
            ))
          )}
          <Button onClick={handleRun} disabled={running}>{running ? 'Running…' : 'Run simulation'}</Button>
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        {result && (
          <div className="mt-4 border-t pt-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-sm font-semibold">Result</span>
              {result.terminated
                ? <span className="text-xs text-emerald-600">Reached end</span>
                : result.stoppedAt
                  ? <span className="text-xs text-amber-600">Stopped at {result.stoppedAt.node_type}</span>
                  : <span className="text-xs text-muted-foreground">Incomplete</span>
              }
            </div>
            <p className="text-xs text-muted-foreground mb-2">Path: {result.path.length} node(s)</p>
            <HistoryTimeline events={resultEvents} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
