import { useId } from 'react';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { useRoles } from '@/api/roles';
import type { ServiceRuleTemplate } from '@/api/service-rules';

export type TemplateParamValues = Record<string, unknown>;

interface ServiceRuleTemplateParamsFormProps {
  template: ServiceRuleTemplate;
  values: TemplateParamValues;
  onChange: (next: TemplateParamValues) => void;
}

/**
 * Per-template parameter editor for service-rule templates. Renders
 * the right Field shape per param-spec type. Mirrors the room-booking-
 * rules params form but adapted to the service-rule type vocabulary
 * (number / string / boolean / days_of_week / catalog_item / role).
 *
 * Required validation lives in the dialog (canSave gate); we only
 * render the inputs here.
 */
export function ServiceRuleTemplateParamsForm({
  template,
  values,
  onChange,
}: ServiceRuleTemplateParamsFormProps) {
  if ((template.param_specs ?? []).length === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
        This template has no parameters. The compiled predicate is fixed.
      </div>
    );
  }

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  return (
    <FieldGroup>
      {template.param_specs.map((spec) => (
        <ParamField
          key={spec.key}
          spec={spec}
          value={values[spec.key]}
          onChange={(v) => set(spec.key, v)}
        />
      ))}
    </FieldGroup>
  );
}

interface ParamFieldProps {
  spec: ServiceRuleTemplate['param_specs'][number];
  value: unknown;
  onChange: (next: unknown) => void;
}

function ParamField({ spec, value, onChange }: ParamFieldProps) {
  const id = useId();
  const labelText = spec.label;

  switch (spec.type) {
    case 'number':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            type="number"
            value={value === undefined || value === null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
          />
        </Field>
      );

    case 'string':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );

    case 'boolean':
      return (
        <Field orientation="horizontal">
          <Switch
            id={id}
            checked={value === true}
            onCheckedChange={onChange}
            aria-label={labelText}
          />
          <FieldLabel htmlFor={id} className="font-normal">
            {labelText}
          </FieldLabel>
        </Field>
      );

    case 'days_of_week':
      return (
        <Field>
          <FieldLabel>{labelText}</FieldLabel>
          <DaysOfWeekPicker
            value={Array.isArray(value) ? (value as number[]) : []}
            onChange={onChange}
          />
          <FieldDescription>Select the days the rule should fire on.</FieldDescription>
        </Field>
      );

    case 'role':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <RolePickerMulti
            id={id}
            value={Array.isArray(value) ? (value as string[]) : []}
            onChange={onChange}
          />
        </Field>
      );

    case 'catalog_item':
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value || null)}
            placeholder="Catalog item id (UUID) — picker lands in Sprint 2"
            aria-describedby={`${id}-help`}
          />
          <FieldDescription id={`${id}-help`}>
            Free-text UUID for v1. The Sprint 2 EntityPicker will replace this with a search-by-name combobox.
          </FieldDescription>
        </Field>
      );

    default:
      return (
        <Field>
          <FieldLabel htmlFor={id}>{labelText}</FieldLabel>
          <Input
            id={id}
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
          <FieldDescription>
            Unsupported param type "{spec.type}". Falling back to a plain text input.
          </FieldDescription>
        </Field>
      );
  }
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function DaysOfWeekPicker({
  value,
  onChange,
}: {
  value: number[];
  onChange: (next: number[]) => void;
}) {
  const toggle = (n: number) => {
    if (value.includes(n)) onChange(value.filter((x) => x !== n));
    else onChange([...value, n].sort());
  };
  return (
    <div className="flex flex-wrap gap-1">
      {DAY_LABELS.map((label, i) => {
        const checked = value.includes(i);
        return (
          <button
            key={i}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={checked}
            className={
              'rounded-md border px-2.5 py-1 text-xs transition-colors '
              + (checked
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background hover:bg-muted')
            }
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}

function RolePickerMulti({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const { data: roles } = useRoles();
  const list = roles ?? [];
  const toggle = (roleId: string) => {
    if (value.includes(roleId)) onChange(value.filter((x) => x !== roleId));
    else onChange([...value, roleId]);
  };
  if (list.length === 0) {
    return (
      <div id={id} className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        No roles defined for this tenant yet.
      </div>
    );
  }
  return (
    <div id={id} className="flex flex-col gap-1.5">
      {list.map((r) => (
        <Field key={r.id} orientation="horizontal">
          <Checkbox
            id={`${id}-${r.id}`}
            checked={value.includes(r.id)}
            onCheckedChange={() => toggle(r.id)}
          />
          <FieldLabel htmlFor={`${id}-${r.id}`} className="font-normal">
            {r.name}
          </FieldLabel>
        </Field>
      ))}
    </div>
  );
}
