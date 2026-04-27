import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toastError, toastSuccess } from '@/lib/toast';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown, ChevronUp, Eye, Link2, Plus, Trash2, Pencil,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field, FieldDescription, FieldGroup, FieldLabel,
} from '@/components/ui/field';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  SettingsPageHeader,
  SettingsPageShell,
  SettingsSection,
  SettingsFooterActions,
} from '@/components/ui/settings-page';
import { configEntityKeys, useConfigEntity } from '@/api/config-entities';
import { apiFetch } from '@/lib/api';
import {
  PREMADE_FIELDS,
  premadeFieldToForm,
  type FieldType,
  type FormField,
  type PremadeFieldDef,
} from '@/components/admin/form-builder/premade-fields';
import { BOUND_FIELD_LABELS } from '@prequest/shared';

const FIELD_TYPES: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Short text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'multi_select', label: 'Multi select' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio' },
  { value: 'file_upload', label: 'File upload' },
  { value: 'person_picker', label: 'Person picker' },
  { value: 'location_picker', label: 'Location picker' },
  { value: 'asset_picker', label: 'Asset picker' },
];

function generateId() {
  return `field_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function newField(): FormField {
  return { id: generateId(), label: '', type: 'text', required: false };
}

interface ConfigEntityDetail {
  id: string;
  display_name: string;
  status?: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}

export function FormSchemaDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, isLoading } = useConfigEntity(id) as {
    data: ConfigEntityDetail | undefined;
    isLoading: boolean;
  };

  if (isLoading) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader backTo="/admin/form-schemas" title="Loading…" />
      </SettingsPageShell>
    );
  }

  if (!data || !id) {
    return (
      <SettingsPageShell width="wide">
        <SettingsPageHeader
          backTo="/admin/form-schemas"
          title="Form schema not found"
          description="It may have been deleted."
        />
      </SettingsPageShell>
    );
  }

  return <FormSchemaDetailBody schema={data} onSaved={() => navigate('/admin/form-schemas')} />;
}

interface BodyProps {
  schema: ConfigEntityDetail;
  onSaved: () => void;
}

function FormSchemaDetailBody({ schema }: BodyProps) {
  const qc = useQueryClient();
  const initialFields = useMemo<FormField[]>(
    () => schema.current_version?.definition?.fields ?? [],
    [schema],
  );

  const [fields, setFields] = useState<FormField[]>(initialFields);
  const [editingFieldIdx, setEditingFieldIdx] = useState<number | null>(
    initialFields.length > 0 ? 0 : null,
  );
  const [previewMode, setPreviewMode] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setFields(initialFields);
    setEditingFieldIdx(initialFields.length > 0 ? 0 : null);
  }, [initialFields]);

  const isDirty = useMemo(() => {
    return JSON.stringify(fields) !== JSON.stringify(initialFields);
  }, [fields, initialFields]);

  const addBlankField = () => {
    setFields((prev) => {
      const next = [...prev, newField()];
      setEditingFieldIdx(next.length - 1);
      return next;
    });
  };

  const addPremadeField = (def: PremadeFieldDef) => {
    setFields((prev) => {
      const next = [...prev, premadeFieldToForm(def, generateId())];
      setEditingFieldIdx(next.length - 1);
      return next;
    });
  };

  const removeField = (idx: number) => {
    setFields((prev) => prev.filter((_, i) => i !== idx));
    setEditingFieldIdx(null);
  };

  const moveField = (idx: number, dir: -1 | 1) => {
    const next = idx + dir;
    if (next < 0 || next >= fields.length) return;
    setFields((prev) => {
      const arr = [...prev];
      [arr[idx], arr[next]] = [arr[next], arr[idx]];
      return arr;
    });
    setEditingFieldIdx(next);
  };

  const updateField = useCallback((idx: number, patch: Partial<FormField>) => {
    setFields((prev) => prev.map((f, i) => (i === idx ? { ...f, ...patch } : f)));
  }, []);

  const reset = () => {
    setFields(initialFields);
    setEditingFieldIdx(initialFields.length > 0 ? 0 : null);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`/config-entities/${schema.id}/draft`, {
        method: 'POST',
        body: JSON.stringify({ definition: { fields } }),
      });
      await apiFetch(`/config-entities/${schema.id}/publish`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: configEntityKeys.all });
      toastSuccess('Form schema published');
    } catch (err) {
      toastError("Couldn't save form schema", { error: err });
    } finally {
      setSaving(false);
    }
  };

  const ef = editingFieldIdx !== null ? fields[editingFieldIdx] : null;
  const needsOptions = ef?.type === 'dropdown' || ef?.type === 'multi_select' || ef?.type === 'radio';
  const fieldCount = fields.length;

  return (
    <SettingsPageShell width="wide">
      <SettingsPageHeader
        backTo="/admin/form-schemas"
        title={schema.display_name}
        description="Each field is rendered on the portal request form. Save & publish to apply changes."
        actions={
          <div className="flex items-center gap-2">
            {isDirty && (
              <Badge variant="outline" className="font-normal text-amber-600 border-amber-500/40">
                Unsaved changes
              </Badge>
            )}
            <Badge variant={schema.status === 'active' ? 'default' : 'secondary'} className="capitalize">
              {schema.status ?? 'draft'}
            </Badge>
          </div>
        }
      />

      <SettingsSection
        title="Fields"
        description={`${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'} in this schema. Reorder with the arrow buttons; click a field to edit it.`}
        density="tight"
        bordered
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="gap-1.5" />}>
                <Plus className="size-3.5" /> Add field
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-72" align="start">
                <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                  Premade
                </DropdownMenuLabel>
                {PREMADE_FIELDS.map((def) => (
                  <DropdownMenuItem
                    key={def.key}
                    onSelect={() => addPremadeField(def)}
                    className="flex-col items-start gap-0.5"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      {def.bound_to && <Link2 className="size-3 text-muted-foreground" />}
                      {def.label}
                    </span>
                    <span className="text-xs text-muted-foreground">{def.description}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">
                  Custom
                </DropdownMenuLabel>
                <DropdownMenuItem onSelect={addBlankField}>
                  <Plus className="mr-2 size-3.5" /> Blank field
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => setPreviewMode((p) => !p)}
            disabled={fieldCount === 0}
          >
            {previewMode ? <Pencil className="size-3.5" /> : <Eye className="size-3.5" />}
            {previewMode ? 'Edit' : 'Preview'}
          </Button>
        </div>

        {fieldCount === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-md border border-dashed bg-muted/30 py-10 text-center">
            <p className="text-sm font-medium">No fields yet</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Add a premade field for common ticket attributes, or build a custom one from scratch.
            </p>
          </div>
        ) : previewMode ? (
          <div className="rounded-md border bg-background p-6">
            <div className="mx-auto max-w-md space-y-6">
              <h3 className="text-sm font-medium">{schema.display_name}</h3>
              {fields.map((f) => (
                <FieldPreview key={f.id} field={f} />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex min-h-[420px] overflow-hidden rounded-md border bg-background">
            <div className="flex w-56 shrink-0 flex-col border-r">
              <div className="flex-1 overflow-y-auto p-2">
                {fields.map((f, idx) => (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditingFieldIdx(idx)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setEditingFieldIdx(idx);
                      }
                    }}
                    className={`group flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                      editingFieldIdx === idx
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted'
                    }`}
                  >
                    <span className="flex flex-1 items-center gap-1.5 truncate">
                      {f.bound_to && <Link2 className="size-3 shrink-0 text-muted-foreground" />}
                      {f.label || <span className="italic text-muted-foreground">Unnamed</span>}
                    </span>
                    <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveField(idx, -1);
                        }}
                        aria-label="Move up"
                      >
                        <ChevronUp className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          moveField(idx, 1);
                        }}
                        aria-label="Move down"
                      >
                        <ChevronDown className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeField(idx);
                        }}
                        aria-label="Delete field"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-5">
              {ef === null ? (
                <p className="text-sm text-muted-foreground">Select a field on the left to edit it.</p>
              ) : (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="fb-label">Label</FieldLabel>
                    <Input
                      id="fb-label"
                      value={ef.label}
                      onChange={(e) => updateField(editingFieldIdx!, { label: e.target.value })}
                      placeholder="Field label…"
                    />
                  </Field>

                  <Field>
                    <div className="flex items-center justify-between">
                      <FieldLabel htmlFor="fb-type">Field type</FieldLabel>
                      {ef.bound_to && (
                        <Badge variant="secondary" className="gap-1 font-normal">
                          <Link2 className="size-3" /> {BOUND_FIELD_LABELS[ef.bound_to]}
                        </Badge>
                      )}
                    </div>
                    <Select
                      value={ef.type}
                      onValueChange={(v) =>
                        updateField(editingFieldIdx!, { type: (v ?? 'text') as FieldType })
                      }
                      disabled={!!ef.bound_to}
                    >
                      <SelectTrigger id="fb-type">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {FIELD_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {ef.bound_to && (
                      <FieldDescription>
                        Field type is locked because this field writes to a ticket column.
                      </FieldDescription>
                    )}
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="fb-placeholder">Placeholder</FieldLabel>
                    <Input
                      id="fb-placeholder"
                      value={ef.placeholder ?? ''}
                      onChange={(e) => updateField(editingFieldIdx!, { placeholder: e.target.value })}
                      placeholder="Optional placeholder…"
                    />
                  </Field>

                  <Field>
                    <FieldLabel htmlFor="fb-help">Help text</FieldLabel>
                    <Input
                      id="fb-help"
                      value={ef.help_text ?? ''}
                      onChange={(e) => updateField(editingFieldIdx!, { help_text: e.target.value })}
                      placeholder="Optional helper text shown below the field…"
                    />
                  </Field>

                  {needsOptions && (
                    <Field>
                      <FieldLabel htmlFor="fb-options">Options (one per line)</FieldLabel>
                      <Textarea
                        id="fb-options"
                        value={(ef.options ?? []).join('\n')}
                        onChange={(e) =>
                          updateField(editingFieldIdx!, {
                            options: e.target.value.split('\n').filter(Boolean),
                          })
                        }
                        placeholder={'Option 1\nOption 2\nOption 3'}
                        className="h-24 resize-none"
                      />
                    </Field>
                  )}

                  <Field orientation="horizontal">
                    <Checkbox
                      id="fb-required"
                      checked={ef.required}
                      onCheckedChange={(c) => updateField(editingFieldIdx!, { required: c === true })}
                    />
                    <FieldLabel htmlFor="fb-required" className="font-normal">
                      Required
                    </FieldLabel>
                  </Field>
                </FieldGroup>
              )}
            </div>

            <div className="w-64 shrink-0 overflow-y-auto border-l bg-muted/20 p-5">
              <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">Preview</p>
              {ef ? (
                <FieldPreview field={ef} />
              ) : (
                <p className="text-xs text-muted-foreground">Select a field to preview.</p>
              )}
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsFooterActions
        primary={{
          label: 'Save & publish',
          onClick: handleSave,
          loading: saving,
          disabled: !isDirty,
        }}
        secondary={{
          label: 'Discard changes',
          onClick: reset,
          disabled: !isDirty || saving,
          variant: 'ghost',
        }}
      />
    </SettingsPageShell>
  );
}

function FieldPreview({ field }: { field: FormField }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="text-sm">
          {field.label || <span className="italic text-muted-foreground">Unnamed field</span>}
        </Label>
        {field.required && <span className="text-xs text-destructive">*</span>}
      </div>
      {field.help_text && <p className="text-xs text-muted-foreground">{field.help_text}</p>}
      {field.type === 'text' && (
        <Input placeholder={field.placeholder || ''} disabled className="h-8" />
      )}
      {field.type === 'textarea' && (
        <Textarea placeholder={field.placeholder || ''} disabled className="h-16 resize-none" />
      )}
      {field.type === 'number' && (
        <Input type="number" placeholder={field.placeholder || ''} disabled className="h-8" />
      )}
      {field.type === 'date' && <Input type="date" disabled className="h-8" />}
      {field.type === 'datetime' && <Input type="datetime-local" disabled className="h-8" />}
      {field.type === 'checkbox' && (
        <div className="flex items-center gap-2">
          <Checkbox disabled />
          <span className="text-sm text-muted-foreground">
            {field.placeholder || 'Check this option'}
          </span>
        </div>
      )}
      {(field.type === 'dropdown' || field.type === 'multi_select') && (
        <Select disabled>
          <SelectTrigger className="h-8">
            <SelectValue placeholder={field.placeholder || 'Select…'} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {field.type === 'radio' && (
        <RadioGroup disabled className="gap-1.5">
          {(field.options ?? ['Option 1', 'Option 2']).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <RadioGroupItem value={opt} id={`preview_${field.id}_${i}`} />
              <Label
                htmlFor={`preview_${field.id}_${i}`}
                className="text-sm font-normal text-muted-foreground"
              >
                {opt}
              </Label>
            </div>
          ))}
        </RadioGroup>
      )}
      {field.type === 'file_upload' && (
        <div className="flex items-center gap-2 rounded-md border border-dashed border-input p-3">
          <span className="text-sm text-muted-foreground">Drop files here or click to upload</span>
        </div>
      )}
      {(field.type === 'person_picker' ||
        field.type === 'location_picker' ||
        field.type === 'asset_picker') && (
        <Input
          placeholder={field.placeholder || `Pick ${field.type.replace('_picker', '')}…`}
          disabled
          className="h-8"
        />
      )}
    </div>
  );
}
