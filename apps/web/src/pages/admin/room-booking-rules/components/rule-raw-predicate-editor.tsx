import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import type { RulePredicate } from '@/api/room-booking-rules';

interface RuleRawPredicateEditorProps {
  value: RulePredicate;
  onChange: (next: RulePredicate, valid: boolean) => void;
}

/**
 * JSON-text editor for a rule predicate. Validates on every keystroke against
 * the predicate shape's structural rules (top-level node must be `and|or|not`
 * or a leaf with `fn`/`op`). Anything deeper is the engine's job — this just
 * keeps the admin from saving obvious garbage.
 *
 * Reach for this when no template covers the case. Most admin work goes
 * through the template form.
 */
export function RuleRawPredicateEditor({ value, onChange }: RuleRawPredicateEditorProps) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  const handleChange = (next: string) => {
    setText(next);
    try {
      const parsed = JSON.parse(next);
      const validation = validatePredicate(parsed);
      if (!validation.ok) {
        setError(validation.message);
        onChange(value, false);
        return;
      }
      setError(null);
      onChange(parsed as RulePredicate, true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid JSON';
      setError(message);
      onChange(value, false);
    }
  };

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="raw-predicate-editor">Predicate JSON</FieldLabel>
        <Textarea
          id="raw-predicate-editor"
          value={text}
          onChange={(e) => handleChange(e.target.value)}
          rows={14}
          className="font-mono text-xs"
          spellCheck={false}
        />
        <FieldDescription>
          Top-level node is one of <code className="chip">{'{and:[…]}'}</code>,{' '}
          <code className="chip">{'{or:[…]}'}</code>, <code className="chip">{'{not:…}'}</code>,{' '}
          <code className="chip">{'{fn,args}'}</code>, or <code className="chip">{'{op,left,right}'}</code>.
          Available functions: <code className="chip">in_business_hours</code>,{' '}
          <code className="chip">array_intersects</code>, <code className="chip">in_org_descendants</code>,{' '}
          <code className="chip">lead_minutes_lt</code>, <code className="chip">lead_minutes_gt</code>,{' '}
          <code className="chip">duration_minutes_gt</code>,{' '}
          <code className="chip">attendees_over_capacity_factor</code>,{' '}
          <code className="chip">attendees_below_min</code>, <code className="chip">has_permission</code>.
        </FieldDescription>
        <FieldError>
          {error && (
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle className="size-3.5" /> {error}
            </span>
          )}
        </FieldError>
      </Field>
    </FieldGroup>
  );
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

function validatePredicate(node: unknown): { ok: true } | { ok: false; message: string } {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, message: 'Predicate must be a JSON object.' };
  }
  const obj = node as Record<string, unknown>;
  if ('and' in obj) {
    if (!Array.isArray(obj.and)) return { ok: false, message: '`and` must be an array.' };
    for (const child of obj.and) {
      const r = validatePredicate(child);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if ('or' in obj) {
    if (!Array.isArray(obj.or)) return { ok: false, message: '`or` must be an array.' };
    for (const child of obj.or) {
      const r = validatePredicate(child);
      if (!r.ok) return r;
    }
    return { ok: true };
  }
  if ('not' in obj) return validatePredicate(obj.not);
  if ('fn' in obj) {
    if (typeof obj.fn !== 'string') return { ok: false, message: '`fn` must be a string.' };
    if (!Array.isArray(obj.args)) return { ok: false, message: '`args` must be an array.' };
    return { ok: true };
  }
  if ('op' in obj) {
    if (typeof obj.op !== 'string') return { ok: false, message: '`op` must be a string.' };
    return { ok: true };
  }
  return { ok: false, message: 'Predicate node must have one of: and, or, not, fn, op.' };
}
