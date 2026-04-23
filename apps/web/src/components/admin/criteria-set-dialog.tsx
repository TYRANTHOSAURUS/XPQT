import { useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, Check, Play } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api';

interface CriteriaSet {
  id: string;
  name: string;
  description: string | null;
  expression: unknown;
  active: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: string | null;
  onSaved: () => void;
}

const EXAMPLE = JSON.stringify(
  {
    all_of: [
      { attr: 'department', op: 'eq', value: 'Engineering' },
      { attr: 'type', op: 'in', value: ['employee', 'contractor'] },
    ],
  },
  null,
  2,
);

interface PreviewResult {
  count: number;
  sample: Array<{ id: string; first_name: string; last_name: string }>;
}

/**
 * Criteria-set authoring. The grammar is a bounded-depth JSON tree
 * (live-doc §3.4a). We ship a raw JSON textarea as v1 — admins who need
 * a visual builder can wait for a later slice; everyone else can crib from
 * the example. The Preview button runs the expression against every active
 * person in the tenant and returns count + a small sample so admins can
 * sanity-check before saving.
 */
export function CriteriaSetDialog({ open, onOpenChange, editingId, onSaved }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [active, setActive] = useState(true);
  const [expressionText, setExpressionText] = useState(EXAMPLE);
  const [parseError, setParseError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setParseError(null);
    if (!editingId) {
      setName('');
      setDescription('');
      setActive(true);
      setExpressionText(EXAMPLE);
      return;
    }
    let cancelled = false;
    apiFetch<CriteriaSet>(`/criteria-sets/${editingId}`).then((cs) => {
      if (cancelled) return;
      setName(cs.name);
      setDescription(cs.description ?? '');
      setActive(cs.active);
      setExpressionText(JSON.stringify(cs.expression, null, 2));
    }).catch((err) => {
      if (cancelled) return;
      toast.error(err instanceof Error ? err.message : 'Failed to load');
      onOpenChange(false);
    });
    return () => { cancelled = true; };
  }, [open, editingId, onOpenChange]);

  const parseExpression = (): unknown | null => {
    try {
      const expr = JSON.parse(expressionText);
      setParseError(null);
      return expr;
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Invalid JSON');
      return null;
    }
  };

  const handlePreview = async () => {
    const expression = parseExpression();
    if (expression === null) return;
    setPreviewing(true);
    try {
      const result = await apiFetch<PreviewResult>(`/criteria-sets/preview`, {
        method: 'POST',
        body: JSON.stringify({ expression }),
      });
      setPreview(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setPreviewing(false);
    }
  };

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error('Name is required');
      return;
    }
    const expression = parseExpression();
    if (expression === null) return;
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || null,
        expression,
        active,
      };
      if (editingId) {
        await apiFetch(`/criteria-sets/${editingId}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        toast.success('Criteria set updated');
      } else {
        await apiFetch('/criteria-sets', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        toast.success('Criteria set created');
      }
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{editingId ? 'Edit' : 'Create'} Criteria Set</DialogTitle>
          <DialogDescription>
            A reusable predicate over person attributes (type, department, division, cost_center,
            manager_person_id). Compose with <code className="font-mono">all_of</code>,
            {' '}<code className="font-mono">any_of</code>, <code className="font-mono">not</code>.
          </DialogDescription>
        </DialogHeader>

        <FieldGroup>
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <Field>
              <FieldLabel htmlFor="cs-name">Name</FieldLabel>
              <Input
                id="cs-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Engineering employees"
              />
              <FieldDescription>Unique per tenant. Shown in audience / on-behalf pickers.</FieldDescription>
            </Field>
            <Field orientation="horizontal" className="self-end pb-1">
              <Checkbox id="cs-active" checked={active} onCheckedChange={(v) => setActive(!!v)} />
              <FieldLabel htmlFor="cs-active" className="font-normal">Active</FieldLabel>
            </Field>
          </div>

          <Field>
            <FieldLabel htmlFor="cs-desc">Description</FieldLabel>
            <Input
              id="cs-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Short summary for admins"
            />
          </Field>

          <FieldSet>
            <FieldLegend>Expression (JSON)</FieldLegend>
            <FieldDescription>
              Bounded depth 3. Leaves: <code className="font-mono">{`{ attr, op, value }`}</code>
              {' '}with <code className="font-mono">op</code> ∈ eq / neq / in / not_in. Composites:
              {' '}<code className="font-mono">{`{ all_of: [...] }`}</code>,
              {' '}<code className="font-mono">{`{ any_of: [...] }`}</code>,
              {' '}<code className="font-mono">{`{ not: <node> }`}</code>.
            </FieldDescription>
            <Textarea
              value={expressionText}
              onChange={(e) => { setExpressionText(e.target.value); setParseError(null); setPreview(null); }}
              className="font-mono text-xs min-h-[180px]"
              spellCheck={false}
            />
            {parseError && (
              <Alert variant="destructive" className="mt-2">
                <AlertCircle className="size-4" />
                <AlertDescription>{parseError}</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={handlePreview}
                disabled={previewing}
              >
                <Play className="h-3 w-3 mr-1" />
                {previewing ? 'Running…' : 'Preview matches'}
              </Button>
              {preview && (
                <div className="text-xs text-muted-foreground flex items-center gap-2">
                  <Check className="h-3 w-3 text-emerald-500" />
                  <span>
                    <span className="font-medium">{preview.count}</span> matching person{preview.count === 1 ? '' : 's'}
                    {preview.sample.length > 0 && (
                      <>
                        {' · '}
                        {preview.sample.map((p) => `${p.first_name} ${p.last_name}`.trim()).join(', ')}
                        {preview.count > preview.sample.length && '…'}
                      </>
                    )}
                  </span>
                </div>
              )}
            </div>
          </FieldSet>
        </FieldGroup>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : (editingId ? 'Save' : 'Create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
