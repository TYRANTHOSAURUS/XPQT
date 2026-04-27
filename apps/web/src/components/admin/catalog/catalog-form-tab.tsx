import { useCallback, useEffect, useMemo, useState } from 'react';
import { toastError, toastSaved } from '@/lib/toast';
import { Plus, X, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from '@/components/ui/field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useFormSchemas, type FormSchemaListItem as FormSchemaRow } from '@/api/config-entities';
import { useCriteriaSets, type CriteriaSet } from '@/api/criteria-sets';
import { apiFetch } from '@/lib/api';
import type { RequestTypeDetail } from './catalog-service-panel';

interface DefaultDraft {
  form_schema_id: string | null;   // null = no default (standard fields only)
  starts_at: string | null;
  ends_at: string | null;
}
interface ConditionalDraft {
  criteria_set_id: string;
  form_schema_id: string;
  priority: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

/**
 * Writable form-variants editor. Backs onto a single replace-set endpoint:
 *   PUT /request-types/:id/form-variants — sends both the default variant
 *   (criteria_set_id = null) and all conditional variants in one transaction.
 * The request-type dialog's "Linked Form Schema" field writes through the
 * same endpoint; if both surfaces are used concurrently the last save wins,
 * but each save preserves whichever variants aren't being edited because the
 * tab always sends the complete set it currently shows.
 */
export function CatalogFormTab({ detail, onSaved }: {
  detail: RequestTypeDetail;
  onSaved: () => void;
}) {
  const { data: schemas } = useFormSchemas() as { data: FormSchemaRow[] | undefined };
  const { data: criteriaSets } = useCriteriaSets() as { data: CriteriaSet[] | undefined };
  const setsById = useMemo(
    () => new Map((criteriaSets ?? []).map((s) => [s.id, s])),
    [criteriaSets],
  );
  const activeSets = useMemo(
    () => (criteriaSets ?? []).filter((s) => s.active),
    [criteriaSets],
  );

  // ── Seed drafts from detail ─────────────────────────────────────────────
  const initialDefault = useMemo<DefaultDraft>(() => {
    const d = detail.form_variants.find((v) => v.criteria_set_id === null && v.active);
    return {
      form_schema_id: d?.form_schema_id ?? null,
      starts_at: d?.starts_at ?? null,
      ends_at: d?.ends_at ?? null,
    };
  }, [detail.id, detail.form_variants]);

  const initialConditional = useMemo<ConditionalDraft[]>(
    () => detail.form_variants
      .filter((v) => v.criteria_set_id !== null)
      .map((v) => ({
        criteria_set_id: v.criteria_set_id as string,
        form_schema_id: v.form_schema_id,
        priority: v.priority,
        active: v.active,
        starts_at: v.starts_at ?? null,
        ends_at: v.ends_at ?? null,
      }))
      .sort((a, b) => b.priority - a.priority),
    [detail.id, detail.form_variants],
  );

  const [defaultDraft, setDefaultDraft] = useState<DefaultDraft>(initialDefault);
  const [conditional, setConditional] = useState<ConditionalDraft[]>(initialConditional);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDefaultDraft(initialDefault), [initialDefault]);
  useEffect(() => setConditional(initialConditional), [initialConditional]);

  const dirty = useMemo(
    () =>
      JSON.stringify(defaultDraft) !== JSON.stringify(initialDefault)
      || JSON.stringify(conditional) !== JSON.stringify(initialConditional),
    [defaultDraft, initialDefault, conditional, initialConditional],
  );

  // ── Conditional row ops ─────────────────────────────────────────────────
  const addConditional = (criteria_set_id: string) => {
    if (conditional.some((c) => c.criteria_set_id === criteria_set_id)) return;
    const nextPriority = conditional.reduce((max, c) => Math.max(max, c.priority), 0) + 10;
    setConditional((prev) => [
      ...prev,
      {
        criteria_set_id,
        form_schema_id: '',
        priority: nextPriority,
        active: true,
        starts_at: null,
        ends_at: null,
      },
    ]);
  };
  const updateConditional = (idx: number, patch: Partial<ConditionalDraft>) => {
    setConditional((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeConditional = (idx: number) => {
    setConditional((prev) => prev.filter((_, i) => i !== idx));
  };

  // ── Validation before save ──────────────────────────────────────────────
  const validationError = useMemo<string | null>(() => {
    for (const c of conditional) {
      if (!c.form_schema_id) return 'Every conditional variant needs a form schema.';
      if (!c.criteria_set_id) return 'Every conditional variant needs a criteria set.';
    }
    const sets = new Set<string>();
    for (const c of conditional) {
      if (sets.has(c.criteria_set_id)) return 'Each criteria set may appear at most once.';
      sets.add(c.criteria_set_id);
    }
    return null;
  }, [conditional]);

  const save: () => Promise<void> = useCallback(async () => {
    if (validationError) return;
    setSaving(true);
    try {
      const payload: Array<{
        criteria_set_id: string | null;
        form_schema_id: string;
        priority: number;
        active: boolean;
        starts_at: string | null;
        ends_at: string | null;
      }> = [];
      if (defaultDraft.form_schema_id) {
        payload.push({
          criteria_set_id: null,
          form_schema_id: defaultDraft.form_schema_id,
          priority: 0,
          active: true,
          starts_at: defaultDraft.starts_at,
          ends_at: defaultDraft.ends_at,
        });
      }
      for (const c of conditional) {
        payload.push({
          criteria_set_id: c.criteria_set_id,
          form_schema_id: c.form_schema_id,
          priority: c.priority,
          active: c.active,
          starts_at: c.starts_at,
          ends_at: c.ends_at,
        });
      }
      await apiFetch(`/request-types/${detail.id}/form-variants`, {
        method: 'PUT',
        body: JSON.stringify({ variants: payload }),
      });
      toastSaved('Form variants');
      onSaved();
    } catch (err) {
      toastError("Couldn't save form variants", { error: err, retry: () => void save() });
    } finally {
      setSaving(false);
    }
    // `save` referenced from retry — stable enough; deps are the inputs.
  }, [defaultDraft, conditional, detail.id, onSaved, validationError]);

  const schemaOptions = schemas ?? [];

  return (
    <div className="flex flex-col gap-6">
      <FieldSet>
        <FieldLegend>Default form</FieldLegend>
        <FieldDescription>
          Shown on the portal submit page when no conditional variant matches the requester. Leave
          unset to fall back to the built-in standard fields only.
        </FieldDescription>

        <Field className="mt-3">
          <FieldLabel htmlFor="default-schema">Linked form schema</FieldLabel>
          <Select
            value={defaultDraft.form_schema_id ?? '__none'}
            onValueChange={(v) =>
              setDefaultDraft((d) => ({ ...d, form_schema_id: v === '__none' ? null : v }))
            }
          >
            <SelectTrigger id="default-schema">
              <SelectValue placeholder="Select a form schema" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">
                <span className="text-muted-foreground italic">None — standard fields only</span>
              </SelectItem>
              {schemaOptions.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Conditional variants</FieldLegend>
        <FieldDescription>
          A conditional variant wins over the default when the requester matches its criteria set.
          Highest priority wins when multiple variants match; ties fall back to creation order.
        </FieldDescription>

        {(criteriaSets ?? []).length === 0 && (
          <Alert className="mt-2">
            <Info className="size-4" />
            <AlertDescription>
              No criteria sets defined yet. Create one at{' '}
              <a href="/admin/criteria-sets" className="underline">Admin → Criteria Sets</a>
              {' '}before adding conditional variants.
            </AlertDescription>
          </Alert>
        )}

        <div className="overflow-auto rounded-md border mt-3">
          <table className="min-w-full border-collapse text-sm">
            <thead className="bg-muted/40">
              <tr>
                <th className="border-b px-3 py-2 text-left font-medium w-52">Criteria set</th>
                <th className="border-b px-3 py-2 text-left font-medium">Form schema</th>
                <th className="border-b px-3 py-2 text-left font-medium w-24">Priority</th>
                <th className="border-b px-3 py-2 text-left font-medium w-20">Active</th>
                <th className="border-b px-3 py-2 text-left font-medium w-48">Schedule</th>
                <th className="border-b px-3 py-2 w-10" aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {conditional.map((c, idx) => (
                <tr key={`${c.criteria_set_id}-${idx}`}>
                  <td className="border-b px-3 py-1.5 align-top">
                    <Badge variant="secondary" className="text-[11px]">
                      {setsById.get(c.criteria_set_id)?.name ?? c.criteria_set_id.slice(0, 8)}
                    </Badge>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <Select
                      value={c.form_schema_id ? c.form_schema_id : undefined}
                      onValueChange={(v) => { if (v) updateConditional(idx, { form_schema_id: v }); }}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Select a form schema" />
                      </SelectTrigger>
                      <SelectContent>
                        {schemaOptions.map((s) => (
                          <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>
                        ))}
                        {schemaOptions.length === 0 && (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No form schemas published yet.
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <Input
                      type="number"
                      className="h-8 text-xs font-mono w-20"
                      value={c.priority}
                      onChange={(e) =>
                        updateConditional(idx, { priority: parseInt(e.target.value, 10) || 0 })
                      }
                    />
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <Switch
                      checked={c.active}
                      onCheckedChange={(v) => updateConditional(idx, { active: !!v })}
                    />
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <div className="flex flex-col gap-1">
                      <Input
                        type="datetime-local"
                        className="h-7 text-[11px] font-mono"
                        value={c.starts_at ? c.starts_at.slice(0, 16) : ''}
                        onChange={(e) => updateConditional(idx, {
                          starts_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                        })}
                        aria-label="Starts at"
                        title="Starts at (optional — leave blank for always-on)"
                      />
                      <Input
                        type="datetime-local"
                        className="h-7 text-[11px] font-mono"
                        value={c.ends_at ? c.ends_at.slice(0, 16) : ''}
                        onChange={(e) => updateConditional(idx, {
                          ends_at: e.target.value ? new Date(e.target.value).toISOString() : null,
                        })}
                        aria-label="Ends at"
                        title="Ends at (optional — leave blank for always-on)"
                      />
                    </div>
                  </td>
                  <td className="border-b px-3 py-1.5 align-top">
                    <button
                      type="button"
                      className="opacity-60 hover:opacity-100"
                      onClick={() => removeConditional(idx)}
                      aria-label="Remove variant"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {conditional.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-4 text-center text-sm text-muted-foreground">
                    No conditional variants configured.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center gap-2 mt-3">
          <Select
            value=""
            onValueChange={(v) => { if (v) addConditional(v); }}
          >
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="+ add conditional variant" />
            </SelectTrigger>
            <SelectContent>
              {activeSets
                .filter((s) => !conditional.some((c) => c.criteria_set_id === s.id))
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
          <span className="text-[11px] text-muted-foreground">
            Pick a criteria set, then choose its form schema.
          </span>
        </div>
      </FieldSet>

      {validationError && (
        <Alert variant="destructive">
          <Info className="size-4" />
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between border-t pt-3">
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <Plus className="h-3 w-3" /> Add new criteria sets at{' '}
          <a href="/admin/criteria-sets" className="underline">Admin → Criteria Sets</a>.
        </p>
        <Button onClick={save} disabled={!dirty || saving || !!validationError}>
          {saving ? 'Saving…' : 'Save form variants'}
        </Button>
      </div>
    </div>
  );
}
