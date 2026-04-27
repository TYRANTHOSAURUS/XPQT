import { useState } from 'react';
import { toastError, toastSuccess } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Info } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useRoutingMode, routingKeys } from '@/api/routing';

type RoutingV2Mode = 'off' | 'dualrun' | 'shadow' | 'v2_only';

const MODE_DESCRIPTIONS: Record<RoutingV2Mode, string> = {
  off: 'Only the legacy resolver runs. No v2 evaluations, no dual-run logs.',
  dualrun: 'Both engines run. Legacy is served to users. Every decision writes a diff row to the audit log.',
  shadow: 'Same as dualrun — use this while ops is actively watching the diffs before cutover.',
  v2_only: 'v2 is served to users. Legacy is not consulted. Flip back to shadow if divergences appear.',
};

const MODE_ORDER: RoutingV2Mode[] = ['off', 'dualrun', 'shadow', 'v2_only'];

interface ModeResponse { mode: RoutingV2Mode; cache_ttl_ms: number }

/**
 * Tenant-level `routing_v2_mode` toggle.
 *
 * Writes tenants.feature_flags.routing_v2_mode. The evaluator caches the
 * mode for 30s per tenant — the description shows that so admins don't
 * panic-refresh when a ticket still uses legacy immediately after
 * flipping. 'v2_only' is the cutover and carries a confirmation prompt
 * because v2 engines fail-soft to unassigned when a policy is missing,
 * and v2_only turns that into user-visible behavior.
 */
export function RoutingModeToggle() {
  const qc = useQueryClient();
  const { data: modeData, isPending: loading } = useRoutingMode() as {
    data: ModeResponse | undefined;
    isPending: boolean;
  };
  const mode = modeData?.mode ?? null;
  const [saving, setSaving] = useState(false);

  async function handleChange(next: RoutingV2Mode) {
    if (!mode || mode === next) return;
    if (next === 'v2_only') {
      const ok = confirm(
        'Flip to v2_only? Tickets will be routed by v2 engines only. Request types with no policy attached will route to "unassigned" instead of legacy. Continue?',
      );
      if (!ok) return;
    }
    setSaving(true);
    try {
      const res = await apiFetch<{ mode: RoutingV2Mode }>('/routing/studio/mode', {
        method: 'PATCH',
        body: JSON.stringify({ mode: next }),
      });
      toastSuccess(`Routing mode set to ${res.mode}`, {
        description: 'Takes effect within 30 seconds.',
      });
      await qc.invalidateQueries({ queryKey: routingKeys.all });
    } catch (err) {
      toastError("Couldn't change routing mode", { error: err, retry: () => handleChange(next) });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
        Loading routing mode…
      </div>
    );
  }
  if (mode === null) return null;

  const currentIdx = MODE_ORDER.indexOf(mode);
  const nextSuggested = currentIdx >= 0 && currentIdx < MODE_ORDER.length - 1 ? MODE_ORDER[currentIdx + 1] : null;

  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium uppercase text-muted-foreground">Routing mode</span>
          <Badge
            variant="outline"
            className={
              mode === 'v2_only'
                ? 'border-emerald-600 text-emerald-700'
                : mode === 'off'
                  ? ''
                  : 'border-amber-600 text-amber-700'
            }
          >
            {mode}
          </Badge>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={mode}
            onValueChange={(v) => handleChange((v ?? 'off') as RoutingV2Mode)}
          >
            <SelectTrigger className="w-36" disabled={saving}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MODE_ORDER.map((m) => (
                <SelectItem key={m} value={m}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {nextSuggested && (
            <Button
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={() => handleChange(nextSuggested)}
            >
              Advance to {nextSuggested} →
            </Button>
          )}
        </div>
      </div>
      <p className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3 shrink-0" />
        <span>{MODE_DESCRIPTIONS[mode]} Evaluator cache refreshes within 30s of a change.</span>
      </p>
    </div>
  );
}
