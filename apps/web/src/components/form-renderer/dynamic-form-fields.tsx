import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PersonCombobox } from '@/components/person-combobox';
import { LocationCombobox } from '@/components/location-combobox';
import { AssetCombobox } from '@/components/asset-combobox';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

interface DynamicFormFieldsProps {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
}

export function DynamicFormFields({ fields, values, onChange }: DynamicFormFieldsProps) {
  if (fields.length === 0) return null;

  return (
    <>
      {fields.map((field) => {
        const id = `dyn-${field.id}`;
        const value = values[field.id];

        if (field.type === 'multi_select') {
          const arr = asStringArr(value);
          return (
            <FieldSet key={field.id}>
              <FieldLegend variant="label">
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </FieldLegend>
              {field.help_text && <FieldDescription>{field.help_text}</FieldDescription>}
              <FieldGroup data-slot="checkbox-group" className="rounded-md border p-2">
                {(field.options ?? []).map((opt) => {
                  const checked = arr.includes(opt);
                  return (
                    <Field key={opt} orientation="horizontal">
                      <Checkbox
                        id={`${id}-${opt}`}
                        checked={checked}
                        onCheckedChange={(c) => {
                          const next = c === true ? [...arr, opt] : arr.filter((x) => x !== opt);
                          onChange(field.id, next);
                        }}
                      />
                      <FieldLabel htmlFor={`${id}-${opt}`} className="font-normal">{opt}</FieldLabel>
                    </Field>
                  );
                })}
              </FieldGroup>
            </FieldSet>
          );
        }

        if (field.type === 'checkbox') {
          return (
            <Field key={field.id} orientation="horizontal">
              <Checkbox
                id={id}
                checked={value === true || value === 'true'}
                onCheckedChange={(c) => onChange(field.id, c === true)}
              />
              <FieldLabel htmlFor={id} className="font-normal">
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </FieldLabel>
              {field.help_text && <FieldDescription>{field.help_text}</FieldDescription>}
            </Field>
          );
        }

        if (field.type === 'radio') {
          return (
            <FieldSet key={field.id}>
              <FieldLegend variant="label">
                {field.label}
                {field.required && <span className="text-destructive ml-1">*</span>}
              </FieldLegend>
              {field.help_text && <FieldDescription>{field.help_text}</FieldDescription>}
              <RadioGroup
                value={asString(value)}
                onValueChange={(v) => onChange(field.id, v ?? '')}
                className="gap-1.5"
              >
                {(field.options ?? []).map((opt) => (
                  <Field key={opt} orientation="horizontal">
                    <RadioGroupItem value={opt} id={`${id}-${opt}`} />
                    <FieldLabel htmlFor={`${id}-${opt}`} className="font-normal">{opt}</FieldLabel>
                  </Field>
                ))}
              </RadioGroup>
            </FieldSet>
          );
        }

        return (
          <Field key={field.id}>
            <FieldLabel htmlFor={id}>
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </FieldLabel>

            {(field.type === 'text' || field.type === 'number' || field.type === 'date' || field.type === 'datetime') && (
              <Input
                id={id}
                type={field.type === 'datetime' ? 'datetime-local' : field.type}
                placeholder={field.placeholder}
                value={asString(value)}
                onChange={(e) => {
                  if (field.type === 'number') {
                    const raw = e.target.value;
                    onChange(field.id, raw === '' ? '' : Number(raw));
                  } else {
                    onChange(field.id, e.target.value);
                  }
                }}
              />
            )}

            {field.type === 'textarea' && (
              <Textarea
                id={id}
                placeholder={field.placeholder}
                className="min-h-[80px]"
                value={asString(value)}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
            )}

            {field.type === 'dropdown' && (
              <Select value={asString(value)} onValueChange={(v) => onChange(field.id, v ?? '')}>
                <SelectTrigger id={id}><SelectValue placeholder={field.placeholder ?? 'Select...'} /></SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {field.type === 'file_upload' && (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-input p-3">
                <span className="text-sm text-muted-foreground">File attachments — coming soon</span>
              </div>
            )}

            {field.type === 'person_picker' && (
              <PersonCombobox
                value={asString(value)}
                onChange={(v) => onChange(field.id, v)}
                placeholder={field.placeholder ?? 'Select person...'}
              />
            )}

            {field.type === 'location_picker' && (
              <LocationCombobox
                value={typeof value === 'string' && value ? value : null}
                onChange={(spaceId) => onChange(field.id, spaceId ?? '')}
                placeholder={field.placeholder}
              />
            )}

            {field.type === 'asset_picker' && (
              <AssetCombobox
                value={typeof value === 'string' && value ? value : null}
                onChange={(assetId) => onChange(field.id, assetId ?? '')}
                placeholder={field.placeholder}
              />
            )}

            {field.help_text && <FieldDescription>{field.help_text}</FieldDescription>}
          </Field>
        );
      })}
    </>
  );
}
