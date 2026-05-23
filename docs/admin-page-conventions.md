# Admin / settings page conventions

Every admin or settings-style page is built with `SettingsPageShell` + `SettingsPageHeader` + `SettingsSection` + `SettingsFooterActions` from `apps/web/src/components/ui/settings-page.tsx`. Widths are a fixed enum — do not invent new ones.

**Canonical exemplars** — read these before writing a new page:
- List: `/admin/webhooks`, `/admin/criteria-sets`
- Detail (auto-save): `/admin/webhooks/:id`, `/admin/criteria-sets/:id`
- Detail (xwide two-column): `/admin/users/roles/:id`
- Detail (effective-permissions panel): `/admin/users/:id`

---

## Width enum — pick the smallest that works

| Width | Max | When to use |
|---|---|---|
| `narrow` | 480px | Single short form with one decision. Rename a team, confirm a destructive op. |
| `default` | 640px | The Linear-style column. Most settings pages — person detail, team settings, tenant branding. |
| `wide` | 960px | Rule builders, dense tables, side-by-side content that feels cramped in 640. |
| `xwide` | 1152px | Two-column editors (picker + live preview), multi-column admin tables, effective-permissions debuggers. The default maximum for typical admin pages. |
| `ultra` | 1600px | Complex overview dashboards, operational consoles, analytics screens where admins genuinely need the horizontal canvas. Still centered with padding. Rare — most pages that feel cramped at `xwide` should split into detail + child page instead. |
| `full` | — | Edge-to-edge. **Only** for true full-screen tools: workflow editor (React Flow), routing studio canvas, giant data grids with 20+ columns or virtualised rows. If you're reaching for `full` on a settings page, you almost certainly want `ultra`. |

Extremes are intentional. Don't smuggle a dashboard into `xwide` by padding it with whitespace, and don't turn a normal settings page into `full` because "more room looks better".

---

## Exceptions — pages that skip the shell

A very small class of pages claims the viewport with zero shell chrome:

- **React Flow canvases** mounting their own toolbar, palette, inspector (`/admin/workflow-editor`, `/admin/workflow-instance`). They use `h-[calc(100vh-…)]` to fill; shell padding fights the canvas.
- **Live runtime viewers** with self-managed split-pane chrome.

Every other admin page — including dashboards, data grids, complex consoles — **should** use `SettingsPageShell width="full"`. The padding difference is small (`px-4 py-6`) and the consistent header gives uniform back-navigation across the product. `full` is an opt-in full-bleed shell, not an escape hatch.

When skipping the shell, render a minimal custom top-bar with the feature title and (where relevant) a "Back to …" link.

---

## Compose pages from grouped blocks

Each feature on a page is one `<SettingsSection title="…" [description] [density] [bordered]>`. Within a section, pick the block shape for the *specific* thing being configured:
- Form → `FieldGroup` + `Field`
- Table → `Table`
- Dense picker → two-column preview pattern

Don't force a generic card template when the data deserves bespoke UX.

**Go deeper or go modal — don't bloat a section:**
- Substantial config (preview, multi-step, dependent data) → child page (e.g. `/admin/users/roles/:id`). Reach back via the `backTo` prop on `SettingsPageHeader`.
- Small focused input (rename, confirm, invite, add-by-id) → `Dialog`. Keep the user on the parent page.

---

## Index + detail shape (mandatory for all admin config)

Every new admin page MUST follow this shape unless there's a concrete reason it can't — document the reason inline if so.

### Index page (`/admin/<feature>`)

- `SettingsPageShell` (pick width per enum above).
- `SettingsPageHeader` — title · one-sentence description of what the feature is for · `actions={<primary "New X" button>}`.
- Loading state: `<div className="text-sm text-muted-foreground">Loading…</div>`.
- Populated state: `Table` with name linking to `/admin/<feature>/:id` (hover underline), 2–4 meaningful columns (status, last updated, rule summary, etc.). **No action column.** Actions live on the detail page.
- Empty state: centred `flex-col items-center gap-3 py-16`, icon + title + one paragraph + primary CTA.
- Creation: lightweight `Dialog` (name + description → `POST` → navigate to `/admin/<feature>/:id`) by default, OR dedicated `/admin/<feature>/new` page.

### Detail page (`/admin/<feature>/:id`)

- `SettingsPageShell` with `backTo="/admin/<feature>"`.
- `SettingsPageHeader` — title is the entity name (not the feature name), description is "what this specific entity does", `actions` holds a compact status badge (`active` / `draft` / etc.) — not more buttons.
- Loading state: shell + header + "Loading…" title. No spinner overlay.
- Not-found state: shell + header with `"Not found"` + one-line explanation.
- Body is a stack of `SettingsGroup` blocks, each a thematic bucket. Typical order:
  1. **Identity** — name, description, active toggle.
  2. **Primary config** — the thing this feature exists for (rules, expression, mapping).
  3. **Operations** — testing, recent events, observability.
  4. **Auth / limits** — keys, rate limits, allowlists.
  5. **Danger zone** — delete, archive, reset. Always last.

---

## Within a group — use `SettingsRow`, not form fields

Each configurable thing is one `SettingsRow label="…" description="…"` with the control on the right. Rows are divided by a single hairline inside one bordered `SettingsGroup` card. This is Linear's "list of decisions" pattern — **do not replace it with a `FieldGroup`**. Field primitives are for grouped forms submitted together; `SettingsRow` is for independent, individually-saved decisions.

**Three control placements:**
1. **Inline control** — short primitives only: `Input` (width-capped), `Switch`, small `Select`. Saves on change.
2. **Clickable row → sub-dialog** — anything complex: picker over a large list, rules builder, key-value map, multi-row editor. `onClick` on the row opens the dialog; `SettingsRowValue` on the right shows a summary ("`3 rules`", "`8 fields`", selected name). The dialog owns draft state + a single Save button.
3. **Clickable row → child page** — only when the nested thing needs multiple groups, its own test/preview, or its own audit feed. Navigate via `<Link>`-wrapping the row. Use sparingly; most things fit in a dialog.

---

## Save modes — pick one per page

### 1. Auto-save (default)

Each row/control is an independent decision; saving one doesn't imply saving the rest. Use for: Identity, Auth & limits, Operations. Examples: `/admin/webhooks/:id`, `/admin/criteria-sets/:id`.

- Text inputs: wrap with `useDebouncedSave(value, (v) => save({ field: v }, { silent: true }))`. No toast on silent save.
- Switches / selects that trigger immediately: `save({ field: next })` — toast on success is OK but optional.
- Dialog-driven saves: call `save({ field: next })` inside `onSave`, then close the dialog. Toast is acceptable since the user clicked Save.

### 2. Batch save (page-level Save button)

The edit is an atomic, consequential decision admins expect to commit once. The audit log treats it as one event, not N toggles. Use for: role permissions, workflow definitions, form schemas. Example: `/admin/user-roles/:id`.

- `SettingsFooterActions` at the bottom: primary Save + secondary Cancel.
- **Always** show unsaved-changes state (sticky bar or enabled/disabled Save) and a **diff preview** (what's being added/removed since last save) before commit. Without that, batch-save becomes "fire and forget".
- Cancel confirms before discarding.
- Route to detail page after create.

### 3. Per-section save (hybrid)

Some pages mix both — auto-save primitives in most sections + one section that's a batch decision (JSON policy editor, permissions matrix, CRON expression). Put the Save button **inside that section's container**, not at the page bottom. Keeps the rest auto-saving; makes the batched block's atomicity obvious.

---

## Validation, audit, and the danger zone

**Validation errors:** server-side problems (e.g. 422 with `validation.problems`) surface as a single warning card directly below the header — not as per-field errors — because `SettingsRow` has no error slot. For batch-save pages, the warning can also mention what will fail on submit.

**Audit log coupling:** batch-save pages emit **one** audit event per save with a before/after diff. Auto-save pages emit one event per field change. Don't mix.

**Danger group — always last:**
- Title: `"Danger zone"`.
- Destructive actions route through `ConfirmDialog` with `destructive` styling and a description that names the consequence ("The external system will receive 401 on any future request").
- Key rotations / similar one-shots also go here (not in Identity).

---

## Primitives — don't reinvent

- `SettingsPageShell`, `SettingsPageHeader` — `apps/web/src/components/ui/settings-page.tsx`
- `SettingsGroup`, `SettingsRow`, `SettingsRowValue` — `apps/web/src/components/ui/settings-row.tsx`
- `ConfirmDialog` — `apps/web/src/components/confirm-dialog.tsx`
- `useDebouncedSave` — `apps/web/src/hooks/use-debounced-save.ts`
- `Dialog` + `FieldGroup`/`Field` — for sub-dialogs (see Form composition rules in `CLAUDE.md`)

Before writing a new settings page, copy the skeleton of `/admin/webhooks/:id` and adapt. If you're tempted to deviate (replace `SettingsRow` with a 2-column form, add a page-level Save button, etc.), re-read this doc first — the deviation is almost never justified.
