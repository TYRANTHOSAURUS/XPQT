# Form Schema System — End-to-End Design

**Date:** 2026-04-17
**Status:** Draft
**Scope:** Premade field palette, seeded starter forms, and end-to-end fixes for the form-schema → request-type → ticket submission pipeline.

---

## Problem

Prequest has a working form builder admins can use to create intake forms, and the schema model already includes a `request_types.form_schema_id` column to link forms to request types. But the pipeline is half-wired:

1. **Admin can't pick a form for a request type.** `RequestTypeDialog` omits the `form_schema_id` selector entirely, so even after building a form in the form-schemas page, there's no UI to attach it to a request type.
2. **Portal half-renders forms.** `submit-request.tsx` only handles `text | number | date | datetime | textarea | dropdown | multi_select | checkbox`. `radio`, `file_upload`, `person_picker`, `location_picker`, `asset_picker` render nothing — the user cannot fill those fields.
3. **Agent desk ignores forms.** `CreateTicketDialog` doesn't fetch or render the form schema at all, so tickets created on behalf of callers skip the custom fields silently.
4. **Ticket detail hides `form_data`.** Agents never see the submitted answers after creation.
5. **No starter content.** Every tenant starts with a blank canvas. Common fields like "Affected Asset" and "Affected Location" have to be rebuilt from scratch on every form.
6. **Answers don't become structured ticket data.** Even when someone fills "Affected Asset" on a form, the value lands in an opaque `form_data` blob — it doesn't populate `tickets.asset_id`, so routing rules and the ticket sidebar can't see it.

## Goals

- Admin can attach a form to a request type from the request-type dialog.
- Portal and desk render every defined field type correctly and consistently.
- Agents see submitted answers in the ticket detail view.
- Admins building forms have 8 premade "smart" blocks that (a) save typing and (b) bind to structured ticket columns where appropriate.
- Ship 7 seeded starter forms so every new tenant has usable forms on day one.

## Non-goals

- Conditional field logic (show field X when field Y = value).
- Per-field regex / format validation beyond required.
- Multi-step forms.
- Real file upload backing (the `file_upload` field renders a disabled placeholder; storage is a separate project).
- Migrating existing schemas. No existing production form schemas to migrate — all schemas are admin-authored, so introducing the optional `bound_to` key is backward-compatible.

---

## Design

### 1. Data model

No SQL migration. `config_entity_versions.definition` is already `jsonb`. One new optional key is added to each form field:

```ts
interface FormField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  help_text?: string;
  options?: string[];
  bound_to?: BoundField; // NEW
}

type BoundField = 'asset_id' | 'location_id' | 'impact' | 'urgency';
```

Semantics: `bound_to` absent → custom field, value goes to `form_data` blob. Present → submission code routes the value to the matching `tickets` column and excludes it from `form_data`.

**Valid binding targets** (kept deliberately small for this pass):
- `asset_id` — for asset pickers
- `location_id` — for location pickers
- `impact` — for impact dropdowns
- `urgency` — for urgency dropdowns

Explicitly *not* bindable, even though the field type exists:
- `person_picker` for "Affected Person" — that person is **not** the requester (which is already captured separately) and there's no dedicated ticket column for a secondary affected person, so it stays blob.
- `datetime` for "Preferred Date" — no ticket column; stays blob.
- `file_upload`, `textarea`, etc. — all blob.

**Shared constant** `packages/shared/src/form-bindings.ts`:

```ts
export const BOUND_FIELDS = ['asset_id', 'location_id', 'impact', 'urgency'] as const;
export type BoundField = typeof BOUND_FIELDS[number];
```

Imported by both web (builder + submission helpers) and api (for any future server-side validation).

### 2. Premade field palette

**New static catalog** `apps/web/src/components/admin/form-builder/premade-fields.ts`:

```ts
export interface PremadeFieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  options?: string[];
  bound_to?: BoundField;
  description: string; // shown in the menu
}

export const PREMADE_FIELDS: PremadeFieldDef[] = [
  { key: 'affected_asset',    label: 'Affected Asset',       type: 'asset_picker',    required: false, bound_to: 'asset_id',    description: 'Links the ticket to an asset' },
  { key: 'affected_location', label: 'Affected Location',    type: 'location_picker', required: true,  bound_to: 'location_id', description: 'Links the ticket to a location' },
  { key: 'affected_person',   label: 'Affected Person',      type: 'person_picker',   required: false,                          description: 'A person other than the requester' },
  { key: 'preferred_date',    label: 'Preferred Date / Time', type: 'datetime',       required: true,                           description: 'When the requester wants this done' },
  { key: 'impact',            label: 'Impact',               type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'impact',  description: 'Business impact — populates the ticket column' },
  { key: 'urgency',           label: 'Urgency',              type: 'dropdown',        required: true,  options: ['Low','Medium','High'], bound_to: 'urgency', description: 'How urgent — populates the ticket column' },
  { key: 'attachments',       label: 'Attachments',          type: 'file_upload',     required: false,                          description: 'File attachments (placeholder)' },
  { key: 'justification',     label: 'Justification / Notes', type: 'textarea',       required: true,                           description: 'Free-text reasoning' },
];
```

### 3. Form builder changes

In `apps/web/src/pages/admin/form-schemas.tsx`:

- **Replace the current "Add Field" button** in the left panel with a `DropdownMenu` with two grouped sections:
  - **Premade** — 8 menu items rendered from `PREMADE_FIELDS`. Clicking inserts `{ id: generateId(), ...(def minus key/description) }` at the end of `fields`.
  - **Custom** — one item "Blank field" → inserts the current `newField()`.
- **Field editor (center pane)**:
  - Premade fields: disable the Field Type dropdown, and show a small `Badge` next to it: `Linked to: Ticket Asset` (or whichever binding). Label / required / options / placeholder / help_text stay editable.
  - Custom fields: no change.
- **Sidebar list**: premade fields get a small `Link2` icon (lucide) before the label, custom fields have no icon.

Mixing premade and custom fields in a single form is the normal case — the distinction is purely whether a field has a `bound_to`.

### 4. Shared dynamic form renderer

**New component** `apps/web/src/components/form-renderer/dynamic-form-fields.tsx`:

```ts
interface DynamicFormFieldsProps {
  fields: FormField[];
  values: Record<string, unknown>;
  onChange: (id: string, value: unknown) => void;
  disabled?: boolean;
}
```

Handles *every* field type: `text | textarea | number | date | datetime | dropdown | multi_select | checkbox | radio | file_upload | person_picker | location_picker | asset_picker`.

- `person_picker` uses the existing `PersonCombobox`.
- `location_picker` uses the existing `SpaceSelect`.
- `asset_picker` uses a new `AssetCombobox` (mirror of `catalog-item-combobox` pattern, fetches from `/assets`).
- `file_upload` renders a disabled "Attach files (coming soon)" block — no-op on submit.
- `radio` uses `RadioGroup` from shadcn.
- `multi_select` uses a multi-checkbox list (array-valued). Values stored as `string[]`.

### 5. Submission helper

**New file** `apps/web/src/lib/form-submission.ts`:

```ts
export function splitFormData(
  fields: FormField[],
  values: Record<string, unknown>,
): { bound: Partial<Record<BoundField, unknown>>; form_data: Record<string, unknown> } {
  const bound: Partial<Record<BoundField, unknown>> = {};
  const form_data: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.id];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
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
    const v = values[f.id];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    if (empty) return f;
  }
  return null;
}
```

Submission flow:
1. Call `validateRequired(fields, values)` — if returns a field, toast an error and stop.
2. Call `splitFormData(fields, values)` → `{ bound, form_data }`.
3. Build the ticket POST body: `{ ...baseDto, ...bound, form_data: Object.keys(form_data).length > 0 ? form_data : undefined }`.
4. POST `/tickets`.

### 6. Portal and desk integration

**`apps/web/src/pages/portal/submit-request.tsx`:**
- Replace the inline field loop and `formData` state with `DynamicFormFields` + a single `values` record.
- Replace the inline required-field check + body construction with `validateRequired()` + `splitFormData()`.
- Remove the local `FormField` interface — import from shared types.

**`apps/web/src/components/desk/create-ticket-dialog.tsx`:**
- Fetch the selected request type's form schema (same pattern as portal).
- Render `DynamicFormFields` inside the dialog between the standard fields and the footer.
- Use `validateRequired()` + `splitFormData()` before POST.
- Post body includes `...bound` and `form_data`.

### 7. Admin request-type dialog

In `apps/web/src/components/admin/request-type-dialog.tsx`:

- Add `useApi<FormSchemaListItem[]>('/config-entities?type=form_schema', [])`.
- Add `formSchemaId` state; populate from `rt.form_schema_id` on edit; reset on create.
- New `<Select>` between Category and SLA Policy, labeled *"Linked Form Schema"*, empty value = "None (only standard fields)".
- `handleSave` body includes `form_schema_id: formSchemaId || undefined`.
- Backend DTO already accepts `form_schema_id` — no server change.

In `apps/web/src/pages/admin/request-types.tsx`:
- Extend `RequestType` type with `form_schema_id` and a preloaded `form_schema?: { name: string }` (populated from the already-fetched `/config-entities?type=form_schema` list).
- Add a "Form" column between Category and SLA.

### 8. Ticket detail: custom fields section

In `apps/web/src/components/desk/ticket-detail.tsx`:

- When a ticket loads, if `ticket.ticket_type_id` is set, look up the request type (already loaded via the existing `/request-types/:id` call or extend the ticket fetch), then fetch its `form_schema_id`'s config-entity to get the latest `definition.fields`.
- Render a new "Custom Fields" section below Description, above Comments. Hidden if `form_data` is empty / missing.
- For each key in `form_data`:
  - Find field by ID in schema. Render `<Label>: <formatted value>`.
  - If field missing from schema (deleted / renamed): fall back to `<raw-id>: <value>` with a muted "(archived field)" tag.
- Formatting (by field type):
  - `date`, `datetime` → existing date util
  - `checkbox` → "Yes" / "No"
  - `multi_select` → comma-joined
  - `person_picker` → person name (resolve via existing person fetch)
  - `location_picker` → space name
  - `asset_picker` → asset name
  - default → raw string
- Bound-field values (`asset_id`, `location_id`, `impact`, `urgency`) are **not** in `form_data` — they already render in the right sidebar via ticket columns, so no dedup is needed.

### 9. Seed migration

**`supabase/migrations/00027_seed_form_schemas.sql`** — idempotent.

For each of the 7 starter forms:

1. `INSERT INTO config_entities (id, tenant_id, config_type, slug, display_name, status) VALUES (<fixed-uuid>, <default-tenant>, 'form_schema', <slug>, <name>, 'active') ON CONFLICT (id) DO NOTHING;`
2. `INSERT INTO config_entity_versions (id, entity_id, version, definition, published_at) VALUES (<fixed-uuid>, <entity-uuid>, 1, <jsonb>, now()) ON CONFLICT (id) DO NOTHING;`
3. `UPDATE config_entities SET current_version_id = <version-uuid> WHERE id = <entity-uuid>;`

Field IDs are stable slugs (`f_asset`, `f_location`, `f_date`, `f_impact`, `f_urgency`, `f_justification`, `f_attachments`, `f_headcount`, `f_dietary`) so ticket `form_data` keys stay interpretable across future schema edits.

**The 7 seeded forms:**

| Slug | Display name | Domain | Fields (id / label / required / bound_to) |
|---|---|---|---|
| `it_incident` | IT Incident | it | `f_asset`/Affected Asset/optional/`asset_id`; `f_impact`/Impact/req/`impact`; `f_urgency`/Urgency/req/`urgency` |
| `it_service_request` | IT Service Request | it | `f_location`/Affected Location/opt/`location_id`; `f_date`/Preferred Date/opt; `f_justification`/Justification/req; `f_attachments`/Attachments/opt |
| `maintenance_wo` | Maintenance Work Order | fm | `f_location`/Affected Location/req/`location_id`; `f_asset`/Affected Asset/opt/`asset_id`; `f_date`/Preferred Date/opt; `f_attachments`/Attachments/opt |
| `workplace_issue` | Workplace Issue | workplace | `f_location`/Affected Location/req/`location_id`; `f_attachments`/Attachments/opt |
| `access_request` | Access Request | security | `f_location`/Affected Location/req/`location_id`; `f_date`/Preferred Date/req; `f_justification`/Justification/req |
| `catering_order` | Catering Order | catering | `f_location`/Affected Location/req/`location_id`; `f_date`/Preferred Date/req; `f_headcount`/Headcount/req (number); `f_dietary`/Dietary Notes/opt (textarea) |
| `asset_issue` | Asset Issue | general | `f_asset`/Affected Asset/req/`asset_id` |

**Linking to existing request types:** The migration also runs `UPDATE public.request_types SET form_schema_id = <uuid> WHERE tenant_id = <default-tenant> AND domain = <d> AND name = <n>` for any already-seeded request types matching each form's intended pairing. Missing matches are silently skipped (no error on no-op update).

**Rollout:**
1. `pnpm db:reset` locally — validates SQL.
2. Smoke test via API.
3. Ask the user before `pnpm db:push` (per CLAUDE.md).

---

## Testing

- **Builder:** add premade fields, edit their labels, confirm they persist with `bound_to`. Add custom fields, confirm they persist without `bound_to`. Mix both.
- **Link UI:** create a request type and attach one of the seeded forms via the new selector. Confirm it shows in the request-types table "Form" column.
- **Portal submit:** pick IT Incident → fill all required fields → submit. Confirm: ticket has `asset_id` populated from Affected Asset; `impact`/`urgency` populated; `form_data` is empty (since all IT Incident fields are bound).
- **Portal submit (mixed):** Catering Order → fill Location + Date + Headcount + Dietary → submit. Confirm: `location_id` populated; `form_data` has `f_date`, `f_headcount`, `f_dietary`.
- **Agent desk:** open CreateTicketDialog, pick a request type with a form, confirm fields render, submit, confirm data lands identically to portal.
- **Ticket detail:** open a submitted Catering ticket, confirm Custom Fields section shows Date / Headcount / Dietary with human labels. Confirm Location is shown in the sidebar (not duplicated in Custom Fields).
- **Required validation:** try to submit with required field empty — error toast names the field.
- **Seed idempotency:** run `pnpm db:reset` twice — second run no-ops cleanly.

## Risks

- **Schema drift:** if an admin removes a premade field from a form, past tickets' `form_data` still has the key — we render "archived field" as a fallback, which is acceptable.
- **Bound field conflict:** an admin could add two "Affected Asset" premade fields. The second one overwrites the first in `splitFormData`. Mitigation: skip in this pass; acceptable as an edge case with no data loss (value just overwrites).
- **File upload placeholder:** admins will see a non-functional "Attach files" control. Label it clearly as "coming soon" to set expectations.
- **Remote push coordination:** migration touches a shared Supabase project. Must ask user before `db:push`.

## Open questions

None.
