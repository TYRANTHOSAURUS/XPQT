# Form Schema System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the form-schema → request-type → ticket pipeline end-to-end, introduce a premade-field palette (for non-asset/location fields — those are handled by the existing `fulfillment_strategy` system at the request-type level), seed 5 starter forms, and fix 4 rendering/linking bugs so admins can link forms, submitters can fill them, and agents can see the answers.

**Architecture:** The existing `config_entity_versions.definition` JSON gains one optional `bound_to` key per field that maps the field to a structured ticket column (`asset_id`, `location_id`, `impact`, `urgency`). Submission code client-side splits form values into bound-column fields vs a `form_data` blob. A new `DynamicFormFields` component is shared between portal and desk paths. Starter forms are seeded via one new SQL migration.

**Tech Stack:** React 19 + Vite, Tailwind v4, shadcn/ui, react-hook-form (portal only), Supabase (Postgres + RLS), NestJS. Monorepo uses pnpm workspaces.

**Reference spec:** `docs/superpowers/specs/2026-04-17-form-schema-system-design.md`

**Important codebase facts (verified):**
- Form versions table is `config_versions` (NOT `config_entity_versions`). FK on `config_entities` is `current_published_version_id`. Form-schemas page calls these via `/config-entities/:id/draft` and `/config-entities/:id/publish`.
- Default tenant UUID: `00000000-0000-0000-0000-000000000001` (per 00022_seed_catalog_demo.sql).
- Existing helpers: `PersonCombobox`, `SpaceSelect`, `AssetCombobox`, `LocationCombobox`.
- The ticket backend DTO (`ticket.service.ts` `CreateTicketDto`) already accepts top-level `asset_id`, `location_id`, `impact`, `urgency`, and `form_data`. No backend changes needed.
- No test framework is in active use for these pages. This plan uses manual smoke-testing steps, not invented unit tests.

## Scope correction (2026-04-18)

During T4 execution we discovered that the codebase already has a dedicated **request-type fulfillment system** (commit `1f94ac9 feat(ticket-forms): dynamic asset/location fields driven by request type fulfillment shape`):
- `request_types` has `fulfillment_strategy`, `requires_asset`, `asset_required`, `asset_type_filter`, `requires_location`, `location_required` columns.
- Portal `submit-request.tsx` and desk `create-ticket-dialog.tsx` already render `AssetCombobox` / `LocationCombobox` conditionally per request type. Selecting an asset auto-populates location via `assigned_space_id`.

Rather than duplicate this with form-schema-level `bound_to: asset_id` / `location_id` premades, we scope the premade system to **non-asset/location** fields only. Impact and Urgency remain bound (to their `tickets` columns); Affected Person / Preferred Date / Justification / Attachments go to `form_data`.

**Downstream changes to this plan:**
- **T4 is dropped** (revert committed in `00f7e63`). The existing `AssetCombobox` stays as-is with its richer `(assetId, asset) => void` signature and `assetTypeFilter`/`spaceScope` props.
- **T2 revised** (committed `0c37c87`): `PREMADE_FIELDS` no longer includes `affected_asset` / `affected_location` — only the 6 remaining entries.
- **T5 DynamicFormFields** uses the existing `AssetCombobox` and `LocationCombobox` directly (with their existing APIs) for `asset_picker` / `location_picker` custom fields — only needed if an admin explicitly adds those as *custom* fields. The values land in `form_data` (no `bound_to`).
- **T7 Portal submit-request refactor** adds `<DynamicFormFields>` *below* the existing conditional asset/location section, not replacing it. The existing `assetId` / `locationId` state and pickers stay. `splitFormData` only splits Impact / Urgency.
- **T8 Agent desk CreateTicketDialog** same pattern — add `<DynamicFormFields>` below existing asset/location section.
- **T9 RequestTypeDialog form selector** unchanged — request types still need a form schema linked.
- **T10 Ticket detail custom fields** unchanged.
- **T11 Seed forms simplified** — remove `f_asset` / `f_location` entries. Revised seed list: IT Incident (Impact + Urgency), IT Service Request (Preferred Date + Justification + Attachments), Maintenance Work Order (Preferred Date + Attachments), Access Request (Preferred Date + Justification), Catering Order (Preferred Date + Headcount + Dietary Notes). Drop Workplace Issue (nothing left after removing Location) and Asset Issue (redundant with fulfillment_strategy). **5 starter forms, not 7.**

The shared `BoundField` union still enumerates all 4 targets (`asset_id` / `location_id` / `impact` / `urgency`). We keep asset/location in the list as *technically valid* bindings — a future admin who wants a secondary "Spare Part Asset" custom field can set `bound_to: asset_id` on it. The premade catalog just doesn't expose them by default.

---

### Task 1: Shared binding constant

**Files:**
- Create: `packages/shared/src/types/form-bindings.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Create the shared constant file**

Create `packages/shared/src/types/form-bindings.ts`:

```ts
export const BOUND_FIELDS = ['asset_id', 'location_id', 'impact', 'urgency'] as const;
export type BoundField = typeof BOUND_FIELDS[number];

export const BOUND_FIELD_LABELS: Record<BoundField, string> = {
  asset_id: 'Ticket Asset',
  location_id: 'Ticket Location',
  impact: 'Ticket Impact',
  urgency: 'Ticket Urgency',
};
```

- [ ] **Step 2: Export from the shared package index**

Edit `packages/shared/src/index.ts` — add at the end:

```ts
export * from './types/form-bindings';
```

- [ ] **Step 3: Verify the type resolves in consumers**

Run: `pnpm -F @prequest/shared build` (or the equivalent build command — if the shared package auto-rebuilds on import, skip).
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/form-bindings.ts packages/shared/src/index.ts
git commit -m "feat(shared): add form bindings constant for premade fields"
```

---

### Task 2: Premade fields catalog (frontend)

**Files:**
- Create: `apps/web/src/components/admin/form-builder/premade-fields.ts`

- [ ] **Step 1: Create the catalog**

Create `apps/web/src/components/admin/form-builder/premade-fields.ts`:

```ts
import type { BoundField } from '@prequest/shared';

export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'datetime'
  | 'dropdown'
  | 'multi_select'
  | 'checkbox'
  | 'radio'
  | 'file_upload'
  | 'person_picker'
  | 'location_picker'
  | 'asset_picker';

export interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
  bound_to?: BoundField;
}

export interface PremadeFieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  bound_to?: BoundField;
  description: string;
}

export const PREMADE_FIELDS: PremadeFieldDef[] = [
  { key: 'affected_asset',    label: 'Affected Asset',        type: 'asset_picker',    required: false, bound_to: 'asset_id',    description: 'Links the ticket to an asset' },
  { key: 'affected_location', label: 'Affected Location',     type: 'location_picker', required: true,  bound_to: 'location_id', description: 'Links the ticket to a location' },
  { key: 'affected_person',   label: 'Affected Person',       type: 'person_picker',   required: false,                          description: 'A person other than the requester' },
  { key: 'preferred_date',    label: 'Preferred Date / Time', type: 'datetime',        required: true,                           description: 'When the requester wants this done' },
  { key: 'impact',            label: 'Impact',                type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'impact',  description: 'Business impact — populates the ticket column' },
  { key: 'urgency',           label: 'Urgency',               type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'urgency', description: 'How urgent — populates the ticket column' },
  { key: 'attachments',       label: 'Attachments',           type: 'file_upload',     required: false,                          description: 'File attachments (placeholder)' },
  { key: 'justification',     label: 'Justification / Notes', type: 'textarea',        required: true,                           description: 'Free-text reasoning' },
];

export function premadeFieldToForm(def: PremadeFieldDef, id: string): FormField {
  return {
    id,
    label: def.label,
    type: def.type,
    required: def.required,
    options: def.options,
    bound_to: def.bound_to,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/admin/form-builder/premade-fields.ts
git commit -m "feat(web): add premade form field catalog"
```

---

### Task 3: Form builder — premade menu + binding badge

**Files:**
- Modify: `apps/web/src/pages/admin/form-schemas.tsx`

- [ ] **Step 1: Replace local `FormField`/`FieldType` types with imports**

In `apps/web/src/pages/admin/form-schemas.tsx`, remove the local `FieldType` union and `FormField` interface (lines ~24-47) and replace with:

```ts
import type { FieldType, FormField } from '@/components/admin/form-builder/premade-fields';
import { PREMADE_FIELDS, premadeFieldToForm } from '@/components/admin/form-builder/premade-fields';
import { BOUND_FIELD_LABELS } from '@prequest/shared';
```

Keep `fieldTypes` the same. Keep `FormSchema` interface.

- [ ] **Step 2: Replace the "Add Field" button with a dropdown menu**

Find the "Add Field" `<Button>` at the bottom of the left panel (~line 374). Replace with:

```tsx
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
```

- [ ] **Step 3: Add imports for the new UI + icons**

At the top of the file, add/extend imports:

```tsx
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { Plus, Pencil, Trash2, ChevronUp, ChevronDown, Eye, Link2 } from 'lucide-react';
```

(Add `Link2`; keep the rest.)

- [ ] **Step 4: Add the `addPremadeField` callback**

Below the existing `addField` function (~line 214), add:

```tsx
const addPremadeField = (def: typeof PREMADE_FIELDS[number]) => {
  const field = premadeFieldToForm(def, generateId());
  setFields((prev) => [...prev, field]);
  setEditingFieldIdx(fields.length);
};
```

- [ ] **Step 5: Show bound-to badge in field editor, disable type dropdown for bound fields**

Find the Field Type `<Select>` in the center pane (~line 408). Replace with:

```tsx
<div className="space-y-2">
  <div className="flex items-center justify-between">
    <Label>Field Type</Label>
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
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>
      {fieldTypes.map((t) => (
        <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
      ))}
    </SelectContent>
  </Select>
  {ef.bound_to && (
    <p className="text-xs text-muted-foreground">
      Field type is locked because this field writes to a ticket column.
    </p>
  )}
</div>
```

- [ ] **Step 6: Show Link2 icon next to bound fields in the sidebar list**

Find the sidebar list (~line 339) and replace the `<span className="flex-1 truncate">...` with:

```tsx
<span className="flex-1 truncate flex items-center gap-1.5">
  {f.bound_to && <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />}
  {f.label || <span className="italic text-muted-foreground">Unnamed</span>}
</span>
```

- [ ] **Step 7: Smoke test — start dev server, open form builder**

```bash
pnpm dev:web
```

In browser: Admin → Form Schemas → New Form Schema.
- Click "Add Field" → menu opens with Premade + Custom groups.
- Click "Affected Asset" → field inserted, badge says "Ticket Asset", type dropdown disabled, label editable.
- Click "Add Field" → "Blank field" → blank field added, no badge, type dropdown enabled.
- Save schema → reload page → reopen the schema → bound_to persists (check by editing, badge still there).

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/pages/admin/form-schemas.tsx
git commit -m "feat(web): add premade field menu and binding badge to form builder"
```

---

### Task 4: AssetCombobox component — SKIPPED

The codebase already ships a richer `AssetCombobox` at `apps/web/src/components/asset-combobox.tsx` (committed `9cd6f8c`) with `value: string | null`, `onChange: (assetId, asset) => void`, `assetTypeFilter`, `spaceScope`, and tag display. Task 4's original plan would have overwritten this with an inferior version — we reverted that overwrite (`00f7e63`) and skip this task entirely. T5 uses the existing component.

---

### ~~Task 4 (original — SKIPPED)~~

**Files:**
- Create: `apps/web/src/components/asset-combobox.tsx`

- [ ] ~~**Step 1: Create the combobox**~~

~~Mirror the `PersonCombobox` pattern. Create `apps/web/src/components/asset-combobox.tsx`:~~

```tsx
import { useEffect, useState } from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList,
} from '@/components/ui/command';
import { apiFetch } from '@/lib/api';

export interface Asset {
  id: string;
  name: string;
  serial_number?: string | null;
  asset_type?: { name: string } | null;
}

interface AssetComboboxProps {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

export function AssetCombobox({ value, onChange, placeholder = 'Select asset...', className, id }: AssetComboboxProps) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selected, setSelected] = useState<Asset | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<Asset[]>('/assets')
      .then((data) => { if (!cancelled) setAssets(data); })
      .catch(() => { if (!cancelled) setAssets([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!value) { setSelected(null); return; }
    const a = assets.find((x) => x.id === value);
    if (a) setSelected(a);
  }, [value, assets]);

  const label = selected ? selected.name : '';

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={<Button id={id} variant="outline" role="combobox" aria-expanded={open} className="flex-1 justify-between font-normal" />}
        >
          <span className={cn('truncate', !label && 'text-muted-foreground font-normal')}>
            {label || placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Search assets..." />
            <CommandList>
              <CommandEmpty>No assets found.</CommandEmpty>
              <CommandGroup>
                {assets.map((a) => (
                  <CommandItem
                    key={a.id}
                    value={`${a.name} ${a.serial_number ?? ''}`}
                    onSelect={() => { onChange(a.id); setSelected(a); setOpen(false); }}
                  >
                    <Check className={cn('mr-2 h-4 w-4', value === a.id ? 'opacity-100' : 'opacity-0')} />
                    <span className="truncate">{a.name}</span>
                    {a.serial_number && <span className="ml-2 text-xs text-muted-foreground">{a.serial_number}</span>}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {value && (
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" onClick={() => { onChange(''); setSelected(null); }} aria-label="Clear selection">
          <X className="h-4 w-4" />
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/asset-combobox.tsx
git commit -m "feat(web): add AssetCombobox for asset picker form fields"
```

---

### Task 5: DynamicFormFields component

**Files:**
- Create: `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`

- [ ] **Step 1: Create the renderer**

Create `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`:

```tsx
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/components/form-renderer/dynamic-form-fields.tsx
git commit -m "feat(web): add shared dynamic form fields renderer"
```

---

### Task 6: Submission helpers

**Files:**
- Create: `apps/web/src/lib/form-submission.ts`

- [ ] **Step 1: Create the helper module**

Create `apps/web/src/lib/form-submission.ts`:

```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/lib/form-submission.ts
git commit -m "feat(web): add form submission split + required validation helpers"
```

---

### Task 7: Portal submit-request refactor

**Files:**
- Modify: `apps/web/src/pages/portal/submit-request.tsx`

**Scope correction (2026-04-18):** The existing asset/location flow driven by `selectedRT.requires_asset` / `requires_location` stays **exactly as is**. T7 only swaps out the local `FormField` type + the inline dynamic rendering block for the shared component + helpers. `impact` / `urgency` come in via `...bound` spread; nothing else touches `asset_id` / `location_id`.

- [ ] **Step 1: Add imports, remove local `FormField` interface**

Remove the local `FormField` interface (currently near the top of the file). Add these imports below the existing ones:

```ts
import { DynamicFormFields } from '@/components/form-renderer/dynamic-form-fields';
import { splitFormData, validateRequired } from '@/lib/form-submission';
import type { FormField } from '@/components/admin/form-builder/premade-fields';
```

- [ ] **Step 2: Switch the values record to `Record<string, unknown>`**

Find `const [formData, setFormData] = useState<Record<string, string>>({});`. Replace with:

```ts
const [values, setValues] = useState<Record<string, unknown>>({});
```

In the schema-loading `useEffect`, replace `setFormData({})` with `setValues({})`.

- [ ] **Step 3: Rewrite `onSubmit` — keep existing asset/location logic, add helpers for form fields**

Replace the current `onSubmit` body with:

```ts
const onSubmit = async (formValues: SubmitFormValues) => {
  const missing = validateRequired(formFields, values);
  if (missing) {
    toast.error(`"${missing.label}" is required`);
    return;
  }
  if (selectedRT?.asset_required && !assetId) {
    toast.error('Please select the affected asset');
    return;
  }
  if (selectedRT?.location_required && !locationId) {
    toast.error('Please select a location');
    return;
  }

  const { bound, form_data } = splitFormData(formFields, values);

  try {
    await apiFetch('/tickets', {
      method: 'POST',
      body: JSON.stringify({
        title: formValues.title,
        description: formValues.description,
        priority: formValues.priority,
        ticket_type_id: formValues.requestTypeId || undefined,
        requester_person_id: person?.id,
        source_channel: 'portal',
        asset_id: assetId ?? undefined,
        location_id: locationId ?? undefined,
        ...bound,
        form_data: Object.keys(form_data).length > 0 ? form_data : undefined,
      }),
    });
    toast.success('Request submitted');
    setSubmitted(true);
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to submit request');
  }
};
```

Note: `bound` only contains `impact` / `urgency` because the premade catalog no longer emits `asset_id` / `location_id`. If an admin manually sets `bound_to: 'asset_id'` on a custom field, it will override the existing `asset_id: assetId`. That's an acceptable edge case — if it becomes a problem, reorder the spread (`...bound` before `asset_id`/`location_id`) so the explicit fields win.

- [ ] **Step 4: Replace the inline field-render block with `<DynamicFormFields>`**

Find the `{formFields.map((field) => (...))}` block (the inline dynamic rendering after Priority). Replace with:

```tsx
<DynamicFormFields
  fields={formFields}
  values={values}
  onChange={(id, v) => setValues((prev) => ({ ...prev, [id]: v }))}
/>
```

- [ ] **Step 5: Typecheck and clean up unused imports**

```bash
cd apps/web && pnpm tsc --noEmit
```

Remove any imports flagged as unused by TypeScript.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/pages/portal/submit-request.tsx
git commit -m "feat(portal): use shared dynamic form fields and split submission"
```

---

### Task 8: Agent desk CreateTicketDialog — dynamic fields

**Files:**
- Modify: `apps/web/src/components/desk/create-ticket-dialog.tsx`

- [ ] **Step 1: Load the linked form schema on request-type change**

At the top of `apps/web/src/components/desk/create-ticket-dialog.tsx`, add imports:

```ts
import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { DynamicFormFields } from '@/components/form-renderer/dynamic-form-fields';
import { splitFormData, validateRequired } from '@/lib/form-submission';
import type { FormField } from '@/components/admin/form-builder/premade-fields';
```

**Scope correction (2026-04-18):** `RequestType` already has `fulfillment_strategy` + `requires_asset` + `asset_required` + `asset_type_filter` + `requires_location` + `location_required` in the current file. Leave those as is. Only ADD `form_schema_id?: string | null` to the interface. The existing `assetId`/`locationId` state and `AssetCombobox`/`LocationCombobox` render blocks stay untouched. Add `...bound` spread to the POST — `bound` will contain `impact`/`urgency` if set, nothing else.

Extend the `RequestType` interface — append one field:

```ts
interface RequestType {
  id: string;
  name: string;
  domain: string;
  fulfillment_strategy: 'asset' | 'location' | 'fixed' | 'auto';
  requires_asset: boolean;
  asset_required: boolean;
  asset_type_filter: string[];
  requires_location: boolean;
  location_required: boolean;
  form_schema_id?: string | null; // NEW
}

interface FormSchemaEntity {
  id: string;
  current_version?: { definition: { fields: FormField[] } } | null;
}
```

Add state + effect below the existing `useState` block:

```ts
const [formFields, setFormFields] = useState<FormField[]>([]);
const [formValues, setFormValues] = useState<Record<string, unknown>>({});

useEffect(() => {
  if (!requestTypeId || !requestTypes) { setFormFields([]); setFormValues({}); return; }
  const rt = requestTypes.find((r) => r.id === requestTypeId);
  if (!rt?.form_schema_id) { setFormFields([]); setFormValues({}); return; }
  let cancelled = false;
  apiFetch<FormSchemaEntity>(`/config-entities/${rt.form_schema_id}`)
    .then((entity) => {
      if (cancelled) return;
      setFormFields(entity.current_version?.definition?.fields ?? []);
      setFormValues({});
    })
    .catch(() => { if (!cancelled) setFormFields([]); });
  return () => { cancelled = true; };
}, [requestTypeId, requestTypes]);
```

- [ ] **Step 2: Rewrite `handleSubmit` to include form data and bound fields**

Replace the existing `handleSubmit` function with:

```ts
const handleSubmit = async () => {
  if (!title.trim() || !requesterId) return;
  if (selectedRT?.asset_required && !assetId) return;
  if (selectedRT?.location_required && !locationId) return;
  const missing = validateRequired(formFields, formValues);
  if (missing) {
    toast.error(`"${missing.label}" is required`);
    return;
  }
  const { bound, form_data } = splitFormData(formFields, formValues);
  setSubmitting(true);
  try {
    const res = await fetch('/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        description,
        priority,
        ticket_type_id: requestTypeId || undefined,
        requester_person_id: requesterId,
        source_channel: sourceChannel,
        asset_id: assetId ?? undefined,
        location_id: locationId ?? undefined,
        ...bound,
        form_data: Object.keys(form_data).length > 0 ? form_data : undefined,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed: ${res.status}`);
    }
    setTitle(''); setDescription(''); setPriority('medium');
    setRequestTypeId(''); setSelectedRequester(null); setRequesterId('');
    setSourceChannel('phone'); setAssetId(null); setLocationId(null);
    setFormFields([]); setFormValues({});
    setOpen(false);
    onCreated?.();
    toast.success('Ticket created');
  } catch (err) {
    toast.error(err instanceof Error ? err.message : 'Failed to create ticket');
  } finally {
    setSubmitting(false);
  }
};
```

- [ ] **Step 3: Render `<DynamicFormFields>` inside the dialog body**

Find the Priority select block (around line ~162). Immediately **after** the closing `</div>` of the Priority block (and before the `</div>` that closes `grid gap-3`), insert:

```tsx
<DynamicFormFields
  fields={formFields}
  values={formValues}
  onChange={(id, v) => setFormValues((prev) => ({ ...prev, [id]: v }))}
/>
```

- [ ] **Step 4: Smoke test — agent creates a ticket with a form**

```bash
pnpm dev
```

Log in as an agent. Open the desk sidebar → click "New Ticket". Pick a request type with a form — verify fields render inline. Fill them, submit, verify the created ticket has the same shape as portal-submitted ones (bound columns populated, `form_data` populated for unbound).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/desk/create-ticket-dialog.tsx
git commit -m "feat(desk): render dynamic form fields in agent create-ticket dialog"
```

---

### Task 9: Admin RequestTypeDialog — form schema selector + table column

**Files:**
- Modify: `apps/web/src/components/admin/request-type-dialog.tsx`
- Modify: `apps/web/src/pages/admin/request-types.tsx`

- [ ] **Step 1: Extend the dialog's `RequestType` interface and load form schemas**

In `apps/web/src/components/admin/request-type-dialog.tsx`:

Extend the `RequestType` interface:

```ts
interface RequestType {
  id: string;
  name: string;
  domain: string | null;
  active: boolean;
  sla_policy?: { id: string; name: string } | null;
  catalog_category_id?: string | null;
  routing_rule_id?: string | null;
  form_schema_id?: string | null;
}

interface FormSchemaListItem { id: string; display_name: string }
```

Add a `useApi` call next to the existing ones:

```ts
const { data: formSchemas } = useApi<FormSchemaListItem[]>('/config-entities?type=form_schema', []);
```

Add `formSchemaId` state:

```ts
const [formSchemaId, setFormSchemaId] = useState('');
```

- [ ] **Step 2: Populate `formSchemaId` on load and reset on create**

In the existing `useEffect` that loads the edit record:
- In the `if (!editingId)` branch add: `setFormSchemaId('');`
- In the fetched-record branch add: `setFormSchemaId(rt.form_schema_id ?? '');`

- [ ] **Step 3: Include `form_schema_id` in the save payload**

In `handleSave`, extend `body`:

```ts
const body = {
  name,
  domain,
  sla_policy_id: slaPolicyId || undefined,
  catalog_category_id: categoryId || undefined,
  routing_rule_id: routingRuleId || undefined,
  form_schema_id: formSchemaId || undefined,
};
```

- [ ] **Step 4: Render the form schema `<Select>`**

In the dialog body, insert a new select block between Category and SLA Policy:

```tsx
<div className="grid gap-1.5">
  <Label>Linked Form Schema</Label>
  <Select value={formSchemaId} onValueChange={(v) => setFormSchemaId(v ?? '')}>
    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
    <SelectContent>
      <SelectItem value="">None (only standard fields)</SelectItem>
      {(formSchemas ?? []).map((s) => (
        <SelectItem key={s.id} value={s.id}>{s.display_name}</SelectItem>
      ))}
    </SelectContent>
  </Select>
</div>
```

- [ ] **Step 5: Add a "Form" column to the request-types table**

In `apps/web/src/pages/admin/request-types.tsx`:

Extend the `RequestType` interface with `form_schema_id?: string | null`.

Add a form-schema lookup similar to category/routing:

```ts
const { data: formSchemas } = useApi<{ id: string; display_name: string }[]>('/config-entities?type=form_schema', []);

const getFormSchemaName = (id: string | null | undefined) => {
  if (!id || !formSchemas) return '—';
  return formSchemas.find((s) => s.id === id)?.display_name ?? '—';
};
```

In the `<TableHeader>`, add after the Category column and before SLA:

```tsx
<TableHead className="w-[150px]">Form</TableHead>
```

In the `<TableRow>`, add the matching cell:

```tsx
<TableCell className="text-muted-foreground text-sm">{getFormSchemaName(rt.form_schema_id)}</TableCell>
```

Increase the TableLoading and TableEmpty `cols` values from 7 to 8.

- [ ] **Step 6: Smoke test — admin links a form**

```bash
pnpm dev:web
```

Admin → Request Types → edit an existing request type → new "Linked Form Schema" select is present → pick a form → Save.
Reload the page → the "Form" column shows the schema name.
Reopen the edit dialog → the select shows the saved form.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/admin/request-type-dialog.tsx apps/web/src/pages/admin/request-types.tsx
git commit -m "feat(admin): add form schema selector to request types"
```

---

### Task 10: Ticket detail — custom fields section

**Files:**
- Modify: `apps/web/src/components/desk/ticket-detail.tsx`

- [ ] **Step 1: Extend `TicketData` with `form_data` and `ticket_type_id`**

In `apps/web/src/components/desk/ticket-detail.tsx`, extend the `TicketData` interface:

```ts
interface TicketData {
  // ... existing fields ...
  ticket_type_id?: string | null;
  form_data?: Record<string, unknown> | null;
  // ... rest ...
}
```

(Insert these lines near the other optional fields; ordering doesn't matter.)

- [ ] **Step 2: Fetch the form schema when a ticket_type is linked**

Below the existing ticket-fetch state hooks, add:

```ts
import type { FormField } from '@/components/admin/form-builder/premade-fields';

const [schemaFields, setSchemaFields] = useState<FormField[]>([]);

useEffect(() => {
  if (!ticket?.ticket_type_id) { setSchemaFields([]); return; }
  let cancelled = false;
  apiFetch<{ form_schema_id?: string | null }>(`/request-types/${ticket.ticket_type_id}`)
    .then((rt) => {
      if (cancelled || !rt.form_schema_id) { setSchemaFields([]); return; }
      return apiFetch<{ current_version?: { definition: { fields: FormField[] } } | null }>(
        `/config-entities/${rt.form_schema_id}`,
      );
    })
    .then((entity) => {
      if (cancelled || !entity) return;
      setSchemaFields(entity.current_version?.definition?.fields ?? []);
    })
    .catch(() => { if (!cancelled) setSchemaFields([]); });
  return () => { cancelled = true; };
}, [ticket?.ticket_type_id]);
```

Add `useState` import if missing.

- [ ] **Step 3: Render the Custom Fields section**

Find the location in the layout where Description ends and Comments begin. Insert a new section between them:

```tsx
{ticket.form_data && Object.keys(ticket.form_data).length > 0 && (
  <div className="space-y-3">
    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Custom Fields</h3>
    <div className="grid gap-3 rounded-md border p-4 bg-muted/20">
      {Object.entries(ticket.form_data).map(([key, value]) => {
        const field = schemaFields.find((f) => f.id === key);
        const label = field?.label ?? key;
        const archived = !field;
        return (
          <div key={key} className="grid grid-cols-[180px_1fr] gap-2 text-sm">
            <span className="text-muted-foreground">
              {label}
              {archived && <span className="ml-2 text-xs italic">(archived)</span>}
            </span>
            <span>{formatFormValue(field, value)}</span>
          </div>
        );
      })}
    </div>
  </div>
)}
```

- [ ] **Step 4: Add the `formatFormValue` helper inside the file**

Add at the top of the file (below imports, above the component):

```ts
function formatFormValue(field: FormField | undefined, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (field?.type === 'checkbox') return value === true || value === 'true' ? 'Yes' : 'No';
  if (field?.type === 'date') {
    try { return new Date(String(value)).toLocaleDateString(); } catch { return String(value); }
  }
  if (field?.type === 'datetime') {
    try { return new Date(String(value)).toLocaleString(); } catch { return String(value); }
  }
  return String(value);
}
```

Note: person/location/asset picker values are **UUIDs**. Rendering raw UUIDs for these is a known limitation here — those fields would normally be bound (if they were "Affected Person/Location/Asset" premade) and land in ticket columns instead of `form_data`. A non-bound person_picker (e.g. "Affected Person") will render a UUID; a follow-up task can resolve these via `/persons/:id` etc. For this pass, leave as raw string.

- [ ] **Step 5: Smoke test**

```bash
pnpm dev:web
```

Open a ticket that was created via Task 7 or Task 8 smoke test (i.e. with unbound form data).
- Custom Fields section renders labels from the schema, not raw IDs.
- Values are formatted (dates readable, checkbox shows Yes/No).
- Bound fields (Affected Asset → `tickets.asset_id`) do **not** appear in the Custom Fields section — they appear in the existing right-sidebar block.
- If `form_data` is empty, the section is hidden.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/desk/ticket-detail.tsx
git commit -m "feat(desk): show submitted form data in ticket detail"
```

---

### Task 11: Seed 5 starter form schemas + link existing request types

**Files:**
- Create: `supabase/migrations/00027_seed_form_schemas.sql`

- [ ] **Step 1: Create the migration**

Create `supabase/migrations/00027_seed_form_schemas.sql`:

```sql
-- Seed 7 starter form schemas and link them to existing demo request types.

do $$
declare
  t uuid := '00000000-0000-0000-0000-000000000001';

  -- config_entities.id
  e_it_incident        uuid := '40000000-0000-0000-0000-000000000001';
  e_it_service_request uuid := '40000000-0000-0000-0000-000000000002';
  e_maintenance_wo     uuid := '40000000-0000-0000-0000-000000000003';
  e_access_request     uuid := '40000000-0000-0000-0000-000000000005';
  e_catering_order     uuid := '40000000-0000-0000-0000-000000000006';

  -- config_versions.id (one per entity)
  v_it_incident        uuid := '41000000-0000-0000-0000-000000000001';
  v_it_service_request uuid := '41000000-0000-0000-0000-000000000002';
  v_maintenance_wo     uuid := '41000000-0000-0000-0000-000000000003';
  v_access_request     uuid := '41000000-0000-0000-0000-000000000005';
  v_catering_order     uuid := '41000000-0000-0000-0000-000000000006';
begin
  -- Insert config_entities (active form_schemas)
  insert into public.config_entities (id, tenant_id, config_type, slug, display_name, status)
  values
    (e_it_incident,        t, 'form_schema', 'it_incident',         'IT Incident',            'active'),
    (e_it_service_request, t, 'form_schema', 'it_service_request',  'IT Service Request',     'active'),
    (e_maintenance_wo,     t, 'form_schema', 'maintenance_wo',      'Maintenance Work Order', 'active'),
    (e_access_request,     t, 'form_schema', 'access_request',      'Access Request',         'active'),
    (e_catering_order,     t, 'form_schema', 'catering_order',      'Catering Order',         'active')
  on conflict (id) do nothing;

  -- Insert config_versions with the definition JSON
  -- Note: asset/location are handled at the request-type level via fulfillment_strategy,
  -- NOT duplicated here. These forms carry only non-asset/location fields.
  insert into public.config_versions (id, config_entity_id, tenant_id, version_number, status, definition, published_at)
  values
    (v_it_incident, e_it_incident, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_impact','label','Impact','type','dropdown','required',true,'options',jsonb_build_array('Low','Medium','High'),'bound_to','impact'),
        jsonb_build_object('id','f_urgency','label','Urgency','type','dropdown','required',true,'options',jsonb_build_array('Low','Medium','High'),'bound_to','urgency')
      )),
      now()),
    (v_it_service_request, e_it_service_request, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',false),
        jsonb_build_object('id','f_justification','label','Justification / Notes','type','textarea','required',true),
        jsonb_build_object('id','f_attachments','label','Attachments','type','file_upload','required',false)
      )),
      now()),
    (v_maintenance_wo, e_maintenance_wo, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',false),
        jsonb_build_object('id','f_attachments','label','Attachments','type','file_upload','required',false)
      )),
      now()),
    (v_access_request, e_access_request, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',true),
        jsonb_build_object('id','f_justification','label','Justification / Notes','type','textarea','required',true)
      )),
      now()),
    (v_catering_order, e_catering_order, t, 1, 'published',
      jsonb_build_object('fields', jsonb_build_array(
        jsonb_build_object('id','f_date','label','Preferred Date / Time','type','datetime','required',true),
        jsonb_build_object('id','f_headcount','label','Headcount','type','number','required',true),
        jsonb_build_object('id','f_dietary','label','Dietary Notes','type','textarea','required',false)
      )),
      now())
  on conflict (id) do nothing;

  -- Point config_entities at their version
  update public.config_entities set current_published_version_id = v_it_incident        where id = e_it_incident        and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_it_service_request where id = e_it_service_request and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_maintenance_wo     where id = e_maintenance_wo     and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_access_request     where id = e_access_request     and current_published_version_id is null;
  update public.config_entities set current_published_version_id = v_catering_order     where id = e_catering_order     and current_published_version_id is null;

  -- Link existing demo request types to starter forms where names align
  update public.request_types set form_schema_id = e_it_incident
    where tenant_id = t and form_schema_id is null and domain = 'it' and lower(name) like '%incident%';
  update public.request_types set form_schema_id = e_it_service_request
    where tenant_id = t and form_schema_id is null and domain = 'it' and (
      lower(name) like '%software%' or lower(name) like '%license%' or lower(name) like '%vpn%' or lower(name) like '%password%' or lower(name) like '%access%card%' or lower(name) like '%laptop%' or lower(name) like '%monitor%' or lower(name) like '%peripheral%'
    );
  update public.request_types set form_schema_id = e_maintenance_wo
    where tenant_id = t and form_schema_id is null and domain = 'fm' and (lower(name) like '%aircon%' or lower(name) like '%plumbing%' or lower(name) like '%lighting%' or lower(name) like '%maint%');
end $$;
```

- [ ] **Step 2: Apply locally to validate SQL**

```bash
pnpm db:reset
```

Expected: migration runs without error. Existing demo tenant + catalog still seed cleanly.

- [ ] **Step 3: Smoke test via API (remote check after push, local check before)**

Start the API pointing at the local Supabase if you reset locally (override `.env` or inspect directly), OR if the running app is pointing at remote (default), do a quick psql confirmation:

```bash
# Local only — confirm rows exist
supabase db query "select slug, display_name, status from config_entities where config_type = 'form_schema' order by slug;"
```

Expected: 5 rows with all 5 starter slugs. Alternatively run via admin Form Schemas page (after remote push in the next step).

- [ ] **Step 4: Coordinate remote push with the user**

Pause and ask the user: *"The migration is validated locally. May I run `pnpm db:push` to apply it to the remote Supabase project?"* Do NOT run it without a go-ahead (per CLAUDE.md).

If approved:

```bash
pnpm db:push
```

Or fallback (per CLAUDE.md) if `db:push` fails:

```bash
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/00027_seed_form_schemas.sql
PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -c "notify pgrst, 'reload schema';"
```

- [ ] **Step 5: Smoke test — starter forms appear in the UI**

```bash
pnpm dev
```

- Admin → Form Schemas: all 5 starter forms appear, each marked "active".
- Open any one → the fields match the spec (IT Incident has 2 bound fields, Catering has Date/Headcount/Dietary, etc.).
- Admin → Request Types → open a seeded IT Incident-style request type → the "Linked Form Schema" select is already set to "IT Incident" (because the migration linked it).
- Portal → Submit Request → pick that request type → form renders correctly.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/00027_seed_form_schemas.sql
git commit -m "feat(db): seed 5 starter form schemas and link demo request types"
```

---

## End-to-end verification checklist

After all tasks complete, walk this path in the dev app:

- [ ] Admin → Form Schemas → create a custom form mixing premade (Affected Location) and custom (text) fields. Save.
- [ ] Admin → Request Types → create "Test Request" → link the new form schema. Save.
- [ ] Portal → Submit Request → pick "Test Request" → fill Location + custom text → submit.
- [ ] Desk → find the new ticket. Confirm:
  - Right sidebar shows the chosen location.
  - Custom Fields section shows the custom text.
  - `tickets.location_id` is populated in DB; `tickets.form_data` contains only the custom text key.
- [ ] Desk → "New Ticket" → pick "Test Request" → same fields render → create → same shape.
- [ ] Portal → Submit Request → pick IT Incident → fill Asset + Impact + Urgency → submit. Inspect DB: `asset_id`, `impact`, `urgency` populated; `form_data` is empty/null.
