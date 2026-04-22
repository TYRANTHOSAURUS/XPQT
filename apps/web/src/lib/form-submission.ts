import type { BoundField } from '@prequest/shared';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

export interface SplitResult {
  bound: Partial<Record<BoundField, unknown>>;
  form_data: Record<string, unknown>;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

export function splitFormData(fields: FormField[], values: Record<string, unknown>): SplitResult {
  const bound: Partial<Record<BoundField, unknown>> = {};
  const form_data: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.id];
    if (isEmpty(v)) continue;
    if (f.bound_to) bound[f.bound_to] = v;
    else form_data[f.id] = v;
  }
  return { bound, form_data };
}

export function validateRequired(
  fields: FormField[],
  values: Record<string, unknown>,
): FormField | null {
  for (const f of fields) {
    if (!f.required) continue;
    if (isEmpty(values[f.id])) return f;
  }
  return null;
}
