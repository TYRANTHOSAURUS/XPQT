import { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, Eye, Link2 } from 'lucide-react';
import { useApi } from '@/hooks/use-api';
import { apiFetch } from '@/lib/api';
import { TableLoading, TableEmpty } from '@/components/table-states';
import type { FieldType, FormField } from '@/components/admin/form-builder/premade-fields';
import { PREMADE_FIELDS, premadeFieldToForm } from '@/components/admin/form-builder/premade-fields';
import { BOUND_FIELD_LABELS } from '@prequest/shared';

interface FormSchema {
  id: string;
  display_name: string;
  status: string;
  current_version?: {
    definition: { fields: FormField[] };
  } | null;
}

const fieldTypes: { value: FieldType; label: string }[] = [
  { value: 'text', label: 'Short Text' },
  { value: 'textarea', label: 'Long Text' },
  { value: 'number', label: 'Number' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & Time' },
  { value: 'dropdown', label: 'Dropdown' },
  { value: 'multi_select', label: 'Multi Select' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'radio', label: 'Radio' },
  { value: 'file_upload', label: 'File Upload' },
  { value: 'person_picker', label: 'Person Picker' },
  { value: 'location_picker', label: 'Location Picker' },
  { value: 'asset_picker', label: 'Asset Picker' },
];

function generateId() {
  return `field_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

function newField(): FormField {
  return { id: generateId(), label: '', type: 'text', required: false };
}

function FieldPreview({ field }: { field: FormField }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="text-sm">
          {field.label || <span className="text-muted-foreground italic">Unnamed field</span>}
        </Label>
        {field.required && <span className="text-destructive text-xs">*</span>}
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
          <span className="text-sm text-muted-foreground">{field.placeholder || 'Check this option'}</span>
        </div>
      )}
      {(field.type === 'dropdown' || field.type === 'multi_select') && (
        <Select disabled>
          <SelectTrigger className="h-8">
            <SelectValue placeholder={field.placeholder || 'Select...'} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((opt) => (
              <SelectItem key={opt} value={opt}>{opt}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {field.type === 'radio' && (
        <RadioGroup disabled className="gap-1.5">
          {(field.options ?? ['Option 1', 'Option 2']).map((opt, i) => (
            <div key={i} className="flex items-center gap-2">
              <RadioGroupItem value={opt} id={`preview_${field.id}_${i}`} />
              <Label htmlFor={`preview_${field.id}_${i}`} className="text-sm text-muted-foreground font-normal">
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
      {(field.type === 'person_picker' || field.type === 'location_picker' || field.type === 'asset_picker') && (
        <Input
          placeholder={field.placeholder || `Pick ${field.type.replace('_picker', '')}...`}
          disabled
          className="h-8"
        />
      )}
    </div>
  );
}

export function FormSchemasPage() {
  const { data, loading, refetch } = useApi<FormSchema[]>('/config-entities?type=form_schema', []);

  const [builderOpen, setBuilderOpen] = useState(false);
  const [editingSchema, setEditingSchema] = useState<FormSchema | null>(null);
  const [schemaName, setSchemaName] = useState('');
  const [fields, setFields] = useState<FormField[]>([]);
  const [editingFieldIdx, setEditingFieldIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewMode, setPreviewMode] = useState(false);

  const openCreate = () => {
    setEditingSchema(null);
    setSchemaName('');
    setFields([newField()]);
    setEditingFieldIdx(0);
    setPreviewMode(false);
    setBuilderOpen(true);
  };

  const openEdit = (schema: FormSchema) => {
    setEditingSchema(schema);
    setSchemaName(schema.display_name);
    setFields(schema.current_version?.definition?.fields ?? [newField()]);
    setEditingFieldIdx(null);
    setPreviewMode(false);
    setBuilderOpen(true);
  };

  const handleSave = async () => {
    if (!schemaName.trim()) return;
    setSaving(true);
    try {
      const slug = schemaName.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const definition = { fields };

      if (editingSchema) {
        await apiFetch(`/config-entities/${editingSchema.id}/draft`, {
          method: 'POST',
          body: JSON.stringify({ definition }),
        });
        await apiFetch(`/config-entities/${editingSchema.id}/publish`, { method: 'POST' });
      } else {
        const entity = await apiFetch<{ id: string }>('/config-entities', {
          method: 'POST',
          body: JSON.stringify({
            config_type: 'form_schema',
            slug,
            display_name: schemaName,
            definition,
          }),
        });
        await apiFetch(`/config-entities/${entity.id}/publish`, { method: 'POST' });
      }

      setBuilderOpen(false);
      refetch();
      toast.success(editingSchema ? 'Form schema updated' : 'Form schema published');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save form schema');
    } finally {
      setSaving(false);
    }
  };

  const addField = () => {
    const f = newField();
    setFields((prev) => [...prev, f]);
    setEditingFieldIdx(fields.length);
  };

  const addPremadeField = (def: typeof PREMADE_FIELDS[number]) => {
    const field = premadeFieldToForm(def, generateId());
    setFields((prev) => [...prev, field]);
    setEditingFieldIdx(fields.length);
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

  const ef = editingFieldIdx !== null ? fields[editingFieldIdx] : null;
  const needsOptions = ef?.type === 'dropdown' || ef?.type === 'multi_select' || ef?.type === 'radio';

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Form Schemas</h1>
          <p className="text-muted-foreground mt-1">Build custom intake forms for request types</p>
        </div>
        <Button className="gap-2" onClick={openCreate}>
          <Plus className="h-4 w-4" /> New Form Schema
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead className="w-[100px]">Fields</TableHead>
            <TableHead className="w-[100px]">Status</TableHead>
            <TableHead className="w-[60px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading && <TableLoading cols={4} />}
          {!loading && (!data || data.length === 0) && <TableEmpty cols={4} message="No form schemas yet." />}
          {(data ?? []).map((schema) => (
            <TableRow key={schema.id}>
              <TableCell className="font-medium">{schema.display_name}</TableCell>
              <TableCell className="text-muted-foreground">
                {schema.current_version?.definition?.fields?.length ?? 0} fields
              </TableCell>
              <TableCell>
                <Badge variant={schema.status === 'active' ? 'default' : 'secondary'} className="capitalize">
                  {schema.status}
                </Badge>
              </TableCell>
              <TableCell>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(schema)}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Builder Dialog */}
      <Dialog open={builderOpen} onOpenChange={setBuilderOpen}>
        <DialogContent className="sm:max-w-[900px] h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 py-4 border-b shrink-0">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-base">
                {editingSchema ? 'Edit' : 'New'} Form Schema
              </DialogTitle>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setPreviewMode((p) => !p)}
                >
                  <Eye className="h-4 w-4" />
                  {previewMode ? 'Edit' : 'Preview'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => setBuilderOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={!schemaName.trim() || saving}>
                  {saving ? 'Saving...' : 'Save & Publish'}
                </Button>
              </div>
            </div>
            <div className="mt-3">
              <Input
                value={schemaName}
                onChange={(e) => setSchemaName(e.target.value)}
                placeholder="Schema name..."
                className="max-w-sm"
              />
            </div>
          </DialogHeader>

          <div className="flex flex-1 min-h-0">
            {/* Left: field list */}
            <div className="w-56 border-r flex flex-col shrink-0">
              <div className="flex-1 overflow-y-auto p-3 space-y-1">
                {fields.map((f, idx) => (
                  <div
                    key={f.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setEditingFieldIdx(idx)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditingFieldIdx(idx); } }}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left group transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      editingFieldIdx === idx ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                    }`}
                  >
                    <span className="flex-1 truncate flex items-center gap-1.5">
                      {f.bound_to && <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />}
                      {f.label || <span className="italic text-muted-foreground">Unnamed</span>}
                    </span>
                    <div className="flex opacity-0 group-hover:opacity-100 gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); moveField(idx, -1); }}
                        aria-label="Move up"
                      >
                        <ChevronUp className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-foreground"
                        onClick={(e) => { e.stopPropagation(); moveField(idx, 1); }}
                        aria-label="Move down"
                      >
                        <ChevronDown className="h-3 w-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        onClick={(e) => { e.stopPropagation(); removeField(idx); }}
                        aria-label="Delete field"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="p-3 border-t">
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="w-full gap-1.5" />}>
                    <Plus className="h-3.5 w-3.5" /> Add Field
                  </DropdownMenuTrigger>
                  <DropdownMenuContent className="w-72" align="start">
                    <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">Premade</DropdownMenuLabel>
                    {PREMADE_FIELDS.map((def) => (
                      <DropdownMenuItem key={def.key} onSelect={() => addPremadeField(def)} className="flex-col items-start gap-0.5">
                        <span className="flex items-center gap-1.5 font-medium">
                          {def.bound_to && <Link2 className="h-3 w-3 text-muted-foreground" />}
                          {def.label}
                        </span>
                        <span className="text-xs text-muted-foreground">{def.description}</span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs uppercase tracking-wide text-muted-foreground">Custom</DropdownMenuLabel>
                    <DropdownMenuItem onSelect={addField}>
                      <Plus className="h-3.5 w-3.5 mr-2" /> Blank field
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Center: field editor or preview */}
            {previewMode ? (
              <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-md space-y-6">
                  <h3 className="font-medium">{schemaName || 'Form Preview'}</h3>
                  {fields.map((f) => (
                    <FieldPreview key={f.id} field={f} />
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-1 min-h-0">
                {/* Field config */}
                <div className="flex-1 overflow-y-auto p-5 space-y-4">
                  {ef === null ? (
                    <p className="text-sm text-muted-foreground">Select a field to edit it.</p>
                  ) : (
                    <FieldGroup>
                      <Field>
                        <FieldLabel htmlFor="fb-label">Label</FieldLabel>
                        <Input
                          id="fb-label"
                          value={ef.label}
                          onChange={(e) => updateField(editingFieldIdx!, { label: e.target.value })}
                          placeholder="Field label..."
                        />
                      </Field>

                      <Field>
                        <div className="flex items-center justify-between">
                          <FieldLabel htmlFor="fb-type">Field Type</FieldLabel>
                          {ef.bound_to && (
                            <Badge variant="secondary" className="gap-1 font-normal">
                              <Link2 className="h-3 w-3" /> {BOUND_FIELD_LABELS[ef.bound_to]}
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
                          <SelectTrigger id="fb-type"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {fieldTypes.map((t) => (
                              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
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
                          placeholder="Optional placeholder..."
                        />
                      </Field>

                      <Field>
                        <FieldLabel htmlFor="fb-help">Help Text</FieldLabel>
                        <Input
                          id="fb-help"
                          value={ef.help_text ?? ''}
                          onChange={(e) => updateField(editingFieldIdx!, { help_text: e.target.value })}
                          placeholder="Optional helper text shown below field..."
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
                        <FieldLabel htmlFor="fb-required" className="font-normal">Required</FieldLabel>
                      </Field>
                    </FieldGroup>
                  )}
                </div>

                {/* Right: live preview of selected field */}
                <div className="w-64 border-l p-5 bg-muted/20 overflow-y-auto shrink-0">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-4">Preview</p>
                  {ef ? (
                    <FieldPreview field={ef} />
                  ) : (
                    <p className="text-xs text-muted-foreground">Select a field to preview</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
