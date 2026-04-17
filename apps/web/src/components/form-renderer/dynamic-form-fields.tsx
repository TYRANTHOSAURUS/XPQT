import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { PersonCombobox } from '@/components/person-combobox';
import { LocationCombobox } from '@/components/location-combobox';
import { AssetCombobox } from '@/components/asset-combobox';
import type { FormField } from '@/components/admin/form-builder/premade-fields';

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
        return (
          <div key={field.id} className="grid gap-1.5">
            <Label htmlFor={id}>
              {field.label}
              {field.required && <span className="text-destructive ml-1">*</span>}
            </Label>
            {field.help_text && <p className="text-xs text-muted-foreground">{field.help_text}</p>}

            {(field.type === 'text' || field.type === 'number' || field.type === 'date' || field.type === 'datetime') && (
              <Input
                id={id}
                type={field.type === 'datetime' ? 'datetime-local' : field.type}
                placeholder={field.placeholder}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
            )}

            {field.type === 'textarea' && (
              <Textarea
                id={id}
                placeholder={field.placeholder}
                className="min-h-[80px]"
                value={(value as string) ?? ''}
                onChange={(e) => onChange(field.id, e.target.value)}
              />
            )}

            {field.type === 'dropdown' && (
              <Select value={(value as string) ?? ''} onValueChange={(v) => onChange(field.id, v ?? '')}>
                <SelectTrigger id={id}><SelectValue placeholder={field.placeholder ?? 'Select...'} /></SelectTrigger>
                <SelectContent>
                  {(field.options ?? []).map((opt) => (
                    <SelectItem key={opt} value={opt}>{opt}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {field.type === 'multi_select' && (
              <div className="grid gap-1.5 rounded-md border p-2">
                {(field.options ?? []).map((opt) => {
                  const arr = Array.isArray(value) ? (value as string[]) : [];
                  const checked = arr.includes(opt);
                  return (
                    <div key={opt} className="flex items-center gap-2">
                      <Checkbox
                        id={`${id}-${opt}`}
                        checked={checked}
                        onCheckedChange={(c) => {
                          const next = c === true ? [...arr, opt] : arr.filter((x) => x !== opt);
                          onChange(field.id, next);
                        }}
                      />
                      <Label htmlFor={`${id}-${opt}`} className="text-sm font-normal cursor-pointer">{opt}</Label>
                    </div>
                  );
                })}
              </div>
            )}

            {field.type === 'checkbox' && (
              <div className="flex items-center gap-2">
                <Checkbox
                  id={id}
                  checked={value === true || value === 'true'}
                  onCheckedChange={(c) => onChange(field.id, c === true)}
                />
                <Label htmlFor={id} className="text-sm font-normal cursor-pointer">
                  {field.placeholder}
                </Label>
              </div>
            )}

            {field.type === 'radio' && (
              <RadioGroup
                value={(value as string) ?? ''}
                onValueChange={(v) => onChange(field.id, v ?? '')}
                className="gap-1.5"
              >
                {(field.options ?? []).map((opt) => (
                  <div key={opt} className="flex items-center gap-2">
                    <RadioGroupItem value={opt} id={`${id}-${opt}`} />
                    <Label htmlFor={`${id}-${opt}`} className="text-sm font-normal cursor-pointer">{opt}</Label>
                  </div>
                ))}
              </RadioGroup>
            )}

            {field.type === 'file_upload' && (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-input p-3">
                <span className="text-sm text-muted-foreground">File attachments — coming soon</span>
              </div>
            )}

            {field.type === 'person_picker' && (
              <PersonCombobox
                value={(value as string) ?? ''}
                onChange={(v) => onChange(field.id, v)}
                placeholder={field.placeholder ?? 'Select person...'}
              />
            )}

            {field.type === 'location_picker' && (
              <LocationCombobox
                value={(value as string) ?? null}
                onChange={(spaceId) => onChange(field.id, spaceId ?? '')}
                placeholder={field.placeholder}
              />
            )}

            {field.type === 'asset_picker' && (
              <AssetCombobox
                value={(value as string) ?? null}
                onChange={(assetId) => onChange(field.id, assetId ?? '')}
                placeholder={field.placeholder}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
