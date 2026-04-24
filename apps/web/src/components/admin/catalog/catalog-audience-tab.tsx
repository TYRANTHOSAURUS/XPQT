import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { FieldDescription, FieldLegend, FieldSet } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Plus, X, Info } from 'lucide-react';
import { useCriteriaSets } from '@/api/criteria-sets';
import { apiFetch } from '@/lib/api';
import type { RequestTypeDetail } from './catalog-service-panel';

type AudienceMode = 'visible_allow' | 'visible_deny' | 'request_allow' | 'request_deny';
type OnBehalfRole = 'actor' | 'target';

interface AudienceBinding { criteria_set_id: string; mode: AudienceMode; active: boolean }
interface OnBehalfBinding { role: OnBehalfRole; criteria_set_id: string }

/**
 * Writable audience + on-behalf editor. Backs onto two replace-set endpoints:
 *   PUT /request-types/:id/audience
 *   PUT /request-types/:id/on-behalf-rules
 * Both guard cross-tenant FKs + invariants server-side. The tab keeps local
 * drafts so the admin can add / remove several bindings, then a single Save
 * per section commits.
 *
 * On-behalf section only renders when request_types.on_behalf_policy is
 * 'configured_list'. Other policies (self_only / any_person / direct_reports)
 * are semantic — the resolver handles them without per-set bindings.
 */
export function CatalogAudienceTab({ detail, onSaved }: {
  detail: RequestTypeDetail & { on_behalf_policy?: string };
  onSaved: () => void;
}) {
  const { data: criteriaSets } = useCriteriaSets();
  const setsById = useMemo(
    () => new Map((criteriaSets ?? []).map((s) => [s.id, s])),
    [criteriaSets],
  );
  const activeSets = useMemo(
    () => (criteriaSets ?? []).filter((s) => s.active),
    [criteriaSets],
  );

  // ── Audience rules (four modes) ───────────────────────────────────────
  const initialAudience = useMemo<AudienceBinding[]>(
    () => detail.criteria.map((c) => ({
      criteria_set_id: c.criteria_set_id,
      mode: c.mode as AudienceMode,
      active: c.active,
    })),
    [detail.id, detail.criteria],
  );
  const [audience, setAudience] = useState<AudienceBinding[]>(initialAudience);
  const [audienceSaving, setAudienceSaving] = useState(false);
  useEffect(() => setAudience(initialAudience), [initialAudience]);

  const audienceDirty = useMemo(
    () => JSON.stringify(audience) !== JSON.stringify(initialAudience),
    [audience, initialAudience],
  );

  const addAudience = (mode: AudienceMode, criteria_set_id: string) => {
    if (audience.some((b) => b.mode === mode && b.criteria_set_id === criteria_set_id)) return;
    setAudience((prev) => [...prev, { mode, criteria_set_id, active: true }]);
  };
  const removeAudience = (mode: AudienceMode, criteria_set_id: string) => {
    setAudience((prev) => prev.filter((b) => !(b.mode === mode && b.criteria_set_id === criteria_set_id)));
  };

  const saveAudience = useCallback(async () => {
    setAudienceSaving(true);
    try {
      await apiFetch(`/request-types/${detail.id}/audience`, {
        method: 'PUT',
        body: JSON.stringify({ rules: audience }),
      });
      toast.success('Audience rules saved');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setAudienceSaving(false);
    }
  }, [audience, detail.id, onSaved]);

  // ── On-behalf rules ────────────────────────────────────────────────────
  const initialOnBehalf = useMemo<OnBehalfBinding[]>(
    () => detail.on_behalf_rules.map((r) => ({
      role: r.role as OnBehalfRole,
      criteria_set_id: r.criteria_set_id,
    })),
    [detail.id, detail.on_behalf_rules],
  );
  const [onBehalf, setOnBehalf] = useState<OnBehalfBinding[]>(initialOnBehalf);
  const [onBehalfSaving, setOnBehalfSaving] = useState(false);
  useEffect(() => setOnBehalf(initialOnBehalf), [initialOnBehalf]);

  const onBehalfDirty = useMemo(
    () => JSON.stringify(onBehalf) !== JSON.stringify(initialOnBehalf),
    [onBehalf, initialOnBehalf],
  );

  const addOnBehalf = (role: OnBehalfRole, criteria_set_id: string) => {
    if (onBehalf.some((b) => b.role === role && b.criteria_set_id === criteria_set_id)) return;
    setOnBehalf((prev) => [...prev, { role, criteria_set_id }]);
  };
  const removeOnBehalf = (role: OnBehalfRole, criteria_set_id: string) => {
    setOnBehalf((prev) => prev.filter((b) => !(b.role === role && b.criteria_set_id === criteria_set_id)));
  };

  const saveOnBehalf = useCallback(async () => {
    setOnBehalfSaving(true);
    try {
      await apiFetch(`/request-types/${detail.id}/on-behalf-rules`, {
        method: 'PUT',
        body: JSON.stringify({ rules: onBehalf }),
      });
      toast.success('On-behalf rules saved');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setOnBehalfSaving(false);
    }
  }, [onBehalf, detail.id, onSaved]);

  const AUDIENCE_ROWS: Array<{ mode: AudienceMode; label: string; hint: string }> = [
    { mode: 'visible_allow', label: 'Visible to',
      hint: 'When present, actor must match at least one allow set for the service to be visible.' },
    { mode: 'visible_deny', label: 'Hidden from',
      hint: 'Any match hides the service for that actor. Short-circuits visibility checks.' },
    { mode: 'request_allow', label: 'Can submit',
      hint: 'When present, actor must match at least one allow set to submit. Requestability ⊆ visibility.' },
    { mode: 'request_deny', label: 'Cannot submit',
      hint: 'Any match blocks submission for that actor, even if visible.' },
  ];

  const onBehalfConfigured = (detail.on_behalf_policy ?? 'self_only') === 'configured_list';

  return (
    <div className="flex flex-col gap-6">
      <FieldSet>
        <FieldLegend>Audience rules</FieldLegend>
        <FieldDescription>
          Audience rules combine: deny short-circuits, allow defaults to "everyone" when unset.
          Requestability is always a subset of visibility.
        </FieldDescription>

        {(criteriaSets ?? []).length === 0 && (
          <Alert className="mt-2">
            <Info className="size-4" />
            <AlertDescription>
              No criteria sets defined yet. Create one at{' '}
              <a href="/admin/criteria-sets" className="underline">Admin → Criteria Sets</a>
              {' '}before binding it here.
            </AlertDescription>
          </Alert>
        )}

        <div className="overflow-auto rounded-md border mt-3">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="border-b px-3 py-2 text-left font-medium w-48">Rule</th>
                <th className="border-b px-3 py-2 text-left font-medium">Criteria sets</th>
                <th className="border-b px-3 py-2 text-left font-medium w-56">Add</th>
              </tr>
            </thead>
            <tbody>
              {AUDIENCE_ROWS.map(({ mode, label, hint }) => {
                const bound = audience.filter((b) => b.mode === mode && b.active);
                return (
                  <tr key={mode}>
                    <th scope="row" className="border-b px-3 py-1.5 text-left font-normal align-top">
                      <span className="flex items-center gap-2">
                        {label}
                        <Badge variant="outline" className="text-[10px]">{mode.split('_')[0]}</Badge>
                      </span>
                      <p className="text-[11px] text-muted-foreground mt-1 max-w-[12rem] whitespace-normal">{hint}</p>
                    </th>
                    <td className="border-b px-3 py-1.5 align-top">
                      {bound.length === 0 ? (
                        <span className="text-xs text-muted-foreground italic">default: everyone</span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {bound.map((b) => (
                            <Badge key={b.criteria_set_id} variant="secondary" className="gap-1">
                              {setsById.get(b.criteria_set_id)?.name ?? b.criteria_set_id.slice(0, 8)}
                              <button
                                type="button"
                                className="opacity-60 hover:opacity-100"
                                onClick={() => removeAudience(mode, b.criteria_set_id)}
                                aria-label="Remove"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="border-b px-3 py-1.5 align-top">
                      <Select
                        value=""
                        onValueChange={(v) => { if (v) addAudience(mode, v); }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="+ criteria set" /></SelectTrigger>
                        <SelectContent>
                          {activeSets
                            .filter((s) => !bound.some((b) => b.criteria_set_id === s.id))
                            .map((s) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          {activeSets.length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                              No active criteria sets.
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end mt-3">
          <Button onClick={saveAudience} disabled={!audienceDirty || audienceSaving}>
            {audienceSaving ? 'Saving…' : 'Save audience rules'}
          </Button>
        </div>
      </FieldSet>

      <FieldSet>
        <FieldLegend>On-behalf rules</FieldLegend>
        <FieldDescription>
          Only applied when the request type's on-behalf policy is{' '}
          <code className="font-mono">configured_list</code>. Actor rules gate who may submit on
          behalf; target rules gate who they may submit for. Change the policy itself on the
          Fulfillment tab.
        </FieldDescription>

        {!onBehalfConfigured && (
          <Alert className="mt-2">
            <Info className="size-4" />
            <AlertDescription>
              Current on-behalf policy is{' '}
              <code className="font-mono">{detail.on_behalf_policy ?? 'self_only'}</code>.
              {' '}Bindings below only take effect once the policy is switched to{' '}
              <code className="font-mono">configured_list</code>.
            </AlertDescription>
          </Alert>
        )}

        <div className="overflow-auto rounded-md border mt-3">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="border-b px-3 py-2 text-left font-medium w-48">Role</th>
                <th className="border-b px-3 py-2 text-left font-medium">Criteria sets</th>
                <th className="border-b px-3 py-2 text-left font-medium w-56">Add</th>
              </tr>
            </thead>
            <tbody>
              {(['actor', 'target'] as OnBehalfRole[]).map((role) => {
                const bound = onBehalf.filter((b) => b.role === role);
                return (
                  <tr key={role}>
                    <th scope="row" className="border-b px-3 py-1.5 text-left font-normal align-top">
                      <span className="flex items-center gap-2 capitalize">
                        {role}
                        <Badge variant="outline" className="text-[10px]">{role}</Badge>
                      </span>
                      <p className="text-[11px] text-muted-foreground mt-1 max-w-[12rem] whitespace-normal">
                        {role === 'actor'
                          ? 'Who may submit on behalf (evaluated against the authenticated person).'
                          : 'Who they may submit for (evaluated against requested_for).'}
                      </p>
                    </th>
                    <td className="border-b px-3 py-1.5 align-top">
                      {bound.length === 0 ? (
                        <span className="text-xs text-muted-foreground italic">
                          {role === 'actor'
                            ? 'no actor bindings → anyone may submit on behalf'
                            : 'no target bindings → any active tenant person'}
                        </span>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {bound.map((b) => (
                            <Badge key={b.criteria_set_id} variant="secondary" className="gap-1">
                              {setsById.get(b.criteria_set_id)?.name ?? b.criteria_set_id.slice(0, 8)}
                              <button
                                type="button"
                                className="opacity-60 hover:opacity-100"
                                onClick={() => removeOnBehalf(role, b.criteria_set_id)}
                                aria-label="Remove"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="border-b px-3 py-1.5 align-top">
                      <Select
                        value=""
                        onValueChange={(v) => { if (v) addOnBehalf(role, v); }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="+ criteria set" /></SelectTrigger>
                        <SelectContent>
                          {activeSets
                            .filter((s) => !bound.some((b) => b.criteria_set_id === s.id))
                            .map((s) => (
                              <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                            ))}
                          {activeSets.length === 0 && (
                            <div className="px-2 py-1.5 text-xs text-muted-foreground">
                              No active criteria sets.
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end mt-3">
          <Button onClick={saveOnBehalf} disabled={!onBehalfDirty || onBehalfSaving}>
            {onBehalfSaving ? 'Saving…' : 'Save on-behalf rules'}
          </Button>
        </div>
      </FieldSet>

      <p className="text-xs text-muted-foreground flex items-center gap-1">
        <Plus className="h-3 w-3" /> Add new criteria sets at{' '}
        <a href="/admin/criteria-sets" className="underline">Admin → Criteria Sets</a>.
      </p>
    </div>
  );
}
