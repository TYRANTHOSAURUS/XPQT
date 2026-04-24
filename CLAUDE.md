# Prequest — Unified Workplace Operations Platform

## Project Structure
```
XPQT/
├── apps/
│   ├── api/          NestJS backend (TypeScript)
│   └── web/          Vite + React 19 frontend (TypeScript + Tailwind)
├── packages/
│   └── shared/       Shared types and constants
├── supabase/
│   ├── config.toml   Local Supabase config
│   └── migrations/   Database migrations
├── docs/             Product specification and phase plans
└── .env              Environment variables (copy from .env.example)
```

## Stack
- **Frontend:** React 19, Vite, TypeScript, Tailwind CSS v4
- **Backend:** NestJS, Node.js, TypeScript
- **Database:** Supabase (PostgreSQL + RLS + Auth + Storage + Realtime)
- **Monorepo:** pnpm workspaces

## Commands
- `pnpm dev` — run both frontend and backend
- `pnpm dev:api` — run backend only
- `pnpm dev:web` — run frontend only
- `pnpm db:start` — start local Supabase
- `pnpm db:reset` — reset database and re-run migrations **(local only!)**
- `pnpm db:push` — push migrations to the **remote** Supabase project

## Supabase: remote vs local — READ BEFORE WRITING MIGRATIONS

**This project's dev environment connects to the REMOTE Supabase project**, not the local stack. `.env` points `SUPABASE_URL` at `https://iwbqnyrvycqgnatratrk.supabase.co`. The API, web, and browser all talk to the remote DB in day-to-day dev.

**Consequences you must respect every time you write a migration or seed:**
1. `pnpm db:reset` ONLY touches local Supabase (127.0.0.1:54321). It does **not** affect the remote DB the app actually uses. A migration that applies cleanly locally is still invisible to the running app until it's pushed.
2. To make migrations take effect for the running dev app, you MUST push them to the remote. Two paths:
   - **Preferred:** `pnpm db:push` (wraps `supabase db push`) — requires the project linked via `supabase link --project-ref iwbqnyrvycqgnatratrk` with the DB password. This has failed in practice because the CLI auth lacks project privileges on this workspace, so fall back to the next option.
   - **Fallback (works today):** apply migration files directly with psql against the remote connection string: `PGPASSWORD='<db_password>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql`. Follow with `NOTIFY pgrst, 'reload schema';` so the remote PostgREST picks up new tables/functions.
3. **Always confirm with the user before running `pnpm db:push` or `supabase db push`.** It writes to a shared/production Supabase project — treat it like a deploy.
4. If you see `PGRST205` errors ("Could not find the table X in the schema cache") or 500s from new endpoints immediately after adding a migration: the most likely cause is that the migration exists locally but hasn't been pushed to remote. Check `.env` SUPABASE_URL, then confirm whether the migration needs `pnpm db:push`.
5. `supabase db reset` is destructive for whichever DB it targets — never run it against remote. It's safe locally, dangerous remotely. Local reset is the default behavior; remote reset requires extra flags, which we don't use.
6. Seed migrations (`*_seed_*.sql`) that use fixed UUIDs are safe to re-apply with `on conflict do nothing`, but still need to be pushed to remote to appear in the app.

**Checklist before reporting a migration/seed task as "done":**
- [ ] Migration file is in `supabase/migrations/` with the next numeric prefix
- [ ] `pnpm db:reset` applies it cleanly (validates SQL)
- [ ] User has been asked whether to push to remote, and `pnpm db:push` has been run with their go-ahead
- [ ] A smoke query (via the running API, not just psql against local) confirms the data is visible

## Architecture
- **Tenant isolation:** Supabase RLS (row-level security). Every table has tenant_id.
- **Tenant resolution:** AsyncLocalStorage middleware resolves tenant from subdomain or X-Tenant-Id header.
- **Auth:** Supabase Auth (JWT). Backend validates tokens via AuthGuard.
- **Module boundaries:** NestJS modules with explicit service exports. No module touches another module's tables directly.
- **Org structure (requester side):** `org_nodes` is the per-tenant requester hierarchy (self-referential tree). Persons attach via `person_org_memberships` (one primary today, multi-membership ready). Location grants attached to a node via `org_node_location_grants` cascade to all members and descendants — see the third `org_grant` source in `portal_authorized_root_matches` (migration 00080). Reference: [`docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md`](docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md).
- **Settings-page template:** new admin pages should be built with `SettingsPageShell` / `SettingsPageHeader` / `SettingsSection` / `SettingsFooterActions` from `apps/web/src/components/ui/settings-page.tsx` (centered 640px column, optional back-button navigation). Reference implementations live under `/admin/organisations`.

## Assignments, Routing & Fulfillment

**Full reference:** [`docs/assignments-routing-fulfillment.md`](docs/assignments-routing-fulfillment.md). Read it before changing any routing, dispatch, SLA, or case/work-order behavior.

Quick mental model — four orthogonal axes, keep them separate:
1. **Routing** (scope + request type) — `ResolverService` + `routing_rules`.
2. **Ownership** — parent case's `assigned_team_id` (the service desk).
3. **Execution** — child work orders' assignees (user or vendor). Created via `DispatchService` / `POST /tickets/:id/dispatch`.
4. **Visibility** — query-layer filters (not yet implemented; planned separately).

Resolver order (first match wins): routing rules → asset branch → location branch (with space-group + domain-parent fallback) → request-type default → unassigned. Every decision is persisted to `routing_decisions` with a full trace. Vendors are first-class assignees alongside teams and users.

### MANDATORY: keep the reference doc in sync

**If a change touches any of the files or tables below, update `docs/assignments-routing-fulfillment.md` in the SAME commit/PR.** The doc is the operational contract for this subsystem — silent drift is how routing bugs hide.

Trigger files:
- `apps/api/src/modules/routing/**`
- `apps/api/src/modules/ticket/dispatch.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts` (`runPostCreateAutomation`, create/list DTOs, `getChildTasks`, reassignment)
- `apps/api/src/modules/ticket/ticket.controller.ts` (routing-adjacent endpoints)
- `apps/api/src/modules/sla/**`
- `apps/api/src/modules/approval/**` (anything affecting `pending_approval` semantics)
- `apps/api/src/modules/workflow/workflow-engine.service.ts` (especially `create_child_tasks`)

Trigger migrations — any add/alter of: `tickets`, `request_types`, `routing_rules`, `routing_decisions`, `location_teams`, `space_groups`, `space_group_members`, `domain_parents`, `sla_policies`, `sla_timers`, `teams`, `vendors`, `assets`, `asset_types`.

When the doc and code disagree, fix the doc first, then align the code to the corrected doc.

## Ticket Visibility

**Full reference:** [`docs/visibility.md`](docs/visibility.md). Read it before changing any read/write path on tickets.

Three-tier model: **Participants** (requester · assignee · watcher · vendor) · **Operators** (team member · role domain + location scope) · **Overrides** (`tickets:read_all` / `tickets:write_all` permissions on `roles.permissions`). Enforced at the API layer via `TicketVisibilityService` (`loadContext` + `getVisibleIds` + `assertVisible`). The canonical SQL predicate is `public.ticket_visibility_ids(user_id, tenant_id)`.

### MANDATORY: keep the reference doc in sync

Same rule as the assignments/routing doc — **touch visibility code or its dependent tables, update `docs/visibility.md` in the same PR.** Trigger files:

- `apps/api/src/modules/ticket/ticket-visibility.service.ts`
- `apps/api/src/modules/ticket/ticket.service.ts` (read/write method signatures or gates)
- `apps/api/src/modules/ticket/ticket.controller.ts` (req.user.id routing)
- Any migration altering `ticket_visibility_ids`, `expand_space_closure`, `user_has_permission`, or the tickets columns they reference (`requester_person_id`, `assigned_user_id`, `assigned_team_id`, `assigned_vendor_id`, `watchers`, `location_id`).
- Any migration changing `users`, `user_role_assignments`, `team_members`, `roles.permissions`, or `spaces.parent_id`.

## Frontend Rules
- **Server state = React Query.** New data-fetching code must use TanStack Query following [`docs/react-query-guidelines.md`](docs/react-query-guidelines.md) — one key factory per module under `apps/web/src/api/<module>/`, `queryOptions` helpers, hierarchical keys (`all` → `lists`/`list` → `details`/`detail` → sub-resources), optimistic updates via `onMutate` + rollback. The legacy `useApi` hook (`apps/web/src/hooks/use-api.ts`) is being migrated out — do not add new callers. When touching a file that still uses `useApi`, consider migrating it (see §9–§10 of the guidelines).
- **Always use shadcn/ui components first.** Before creating any UI element, check if shadcn has a component for it. Use `context7` to look up the latest shadcn docs. Only use raw HTML elements if no shadcn component exists for the use case.
- **Install shadcn components before using them:** `npx shadcn@latest add <component-name>`
- **Design reference:** Linear app — clean, spacious, minimal borders, subtle color usage, properties sidebar on the right.
- Installed components are in `apps/web/src/components/ui/`. Check there before installing duplicates.
- **Make components reusable/generic by default.** Before writing an inline block of JSX or a page-local helper component, ask: will this pattern be used in more than one place? If yes (or plausibly yes), extract it into `apps/web/src/components/` as a prop-driven, domain-parameterized component — not a one-off. If you spot duplicated JSX across two or more files, stop and consolidate into a shared component instead of copying it a third time. Exceptions only for truly page-specific, non-reusable markup.

### Form composition (mandatory)

Every form — dialog, sheet, drawer, page-level, inspector panel — must be built from the shadcn Field primitives in `apps/web/src/components/ui/field.tsx`. Never hand-roll form layout with `<div className="grid gap-1.5">` + `<Label>` + `<Input>`. That pattern looks almost right in isolation but breaks consistency across the app (mismatched gaps, SelectTrigger `w-fit` collapsing to content width, ad-hoc helper text sizes, sections separated by raw `border-t`).

**The rules:**
- Wrap the whole form body in `<FieldGroup>`. Nothing else sets the vertical rhythm between fields — not `grid gap-3`, not `space-y-4`.
- Each label + control pair is a `<Field>` with `<FieldLabel htmlFor="…">`. The `id`/`htmlFor` pair is required, not optional.
- Helper text under a control is `<FieldDescription>`, never a bespoke `<p className="text-xs text-muted-foreground">`.
- Inline validation errors use `<FieldError>` — do not replace with toasts for field-level problems.
- Group related fields with `<FieldSet>` + `<FieldLegend>` (+ optional `<FieldDescription>` under the legend). Separate sections with `<FieldSeparator>`. Do not use `border-t pt-4` + a bare `<h3>` as a fake section header.
- Checkbox and radio rows use `<Field orientation="horizontal">` with the control as the first child and `<FieldLabel className="font-normal" htmlFor="…">` as the second. Do not wrap a `<Checkbox>` inside a raw `<label>`.
- Never pass `className="w-full"` to a `SelectTrigger` to force its width. The Field vertical variant already stretches children via `*:w-full`; if a Select is too narrow, the fix is to wrap it in `<Field>`, not to patch the trigger.
- Reference the canonical shape in the shadcn Field docs (query via `context7` for "shadcn field") and the existing migrated examples in `apps/web/src/components/desk/create-ticket-dialog.tsx` and `apps/web/src/components/admin/request-type-dialog.tsx`.

Before writing any new form or touching an existing one, confirm it follows the above. If you find a form that doesn't, migrate it rather than copying its pattern.

### Settings page layout (mandatory)

Every admin / settings-style page is built with `SettingsPageShell` + `SettingsPageHeader` + `SettingsSection` + `SettingsFooterActions` from `apps/web/src/components/ui/settings-page.tsx`. Widths are a fixed enum — do not invent new ones.

**Pick the smallest width that works:**

| Width | Max | When to use |
|---|---|---|
| `narrow` | 480px | Single short form with one decision. Rename a team, confirm a destructive op. |
| `default` | 640px | The Linear-style column. Most settings pages — person detail, team settings, tenant branding. |
| `wide` | 960px | Rule builders, dense tables, side-by-side content that feels cramped in 640. |
| `xwide` | 1152px | Two-column editors (picker + live preview), multi-column admin tables, effective-permissions debuggers. **This is the absolute maximum for any settings page.** |

Anything larger isn't a settings page — reach for a dedicated layout, not a new width.

**Compose the page from grouped blocks.** Each feature on a settings page is a `<SettingsSection title="…" [description] [density] [bordered]>`. Within a section, the block shape is chosen for the *specific* element being configured — a form uses `FieldGroup` + `Field`, a table uses `Table`, a dense picker uses the two-column preview pattern. Don't force a generic card template when the data deserves bespoke UX.

**Go deeper or go modal — don't bloat a section.**
- If a block needs substantial configuration (its own preview, multi-step flow, dependent data), navigate to a dedicated child page (e.g. `/admin/users/roles/:id`) rather than expanding the parent section. Reach back to the parent via the `backTo` prop on `SettingsPageHeader`.
- If a block only needs a small focused input (rename, confirm, invite, add-by-id), use a `Dialog` — keep the user on the parent page.

Reference implementations: `/admin/organisations/*`, `/admin/users/roles/:id` (xwide two-column), `/admin/users/:id` (xwide with effective-permissions panel). Before adding a new setting, scan these for a block pattern you can lift or extend.

### Index + detail shape (mandatory for all admin config)

**Canonical exemplars:** `/admin/webhooks` (list) + `/admin/webhooks/:id` (detail), `/admin/criteria-sets` + `/admin/criteria-sets/:id`. Read both before adding a new settings feature. Every new admin page MUST follow this shape unless there's a concrete reason it can't — and in that case, document the reason inline.

**Index page (`/admin/<feature>`):**
- `SettingsPageShell` (pick width from `narrow|default|wide|xwide` per §Settings page layout).
- `SettingsPageHeader` — title, one-sentence description of what the feature is for, `actions={<primary "New X" button>}`.
- Loading state: `<div className="text-sm text-muted-foreground">Loading…</div>`.
- Populated state: `Table` with name linking to `/admin/<feature>/:id` (hover underline), 2–4 meaningful columns (status, last updated, rule summary, etc.). **No action column.** Actions live on the detail page.
- Empty state: centred `flex-col items-center gap-3 py-16`, icon + title + one paragraph + primary CTA.
- Creation: either a lightweight `Dialog` (name + description → `POST` → navigate to `/admin/<feature>/:id`) OR a dedicated `/admin/<feature>/new` page. Dialog is the default.

**Detail page (`/admin/<feature>/:id`):**
- `SettingsPageShell` with `backTo="/admin/<feature>"`.
- `SettingsPageHeader` — title is the entity name (not the feature name), description is "what this specific entity does", `actions` holds a compact status badge (`active` / `draft` / etc.) — not more buttons.
- Loading state: the shell + header + "Loading…" title. No spinner overlay.
- Not-found state: the shell + header with `"Not found"` + a one-line explanation.
- Body is a stack of `SettingsGroup` blocks, each a thematic bucket of related decisions. Typical groups in order:
  1. **Identity** — name, description, active toggle.
  2. **Primary config** — the thing this feature exists for (rules, expression, mapping).
  3. **Operations** — testing, recent events, observability (if applicable).
  4. **Auth / limits** — keys, rate limits, allowlists (if applicable).
  5. **Danger zone** — delete, archive, reset. Always last.
- Save model is chosen per page — see **Save modes** below. Auto-save is the default; batch-save is the right call for consequential atomic edits.

**Within a group — use `SettingsRow`, not form fields:**
Each configurable thing on a detail page is one `SettingsRow label="…" description="…"` with the control on the right. Rows are divided by a single hairline inside one bordered `SettingsGroup` card. This is Linear's "list of decisions" pattern — **do not replace it with a `FieldGroup`**. Field primitives are for grouped forms submitted together; `SettingsRow` is for independent, individually-saved decisions.

**Three control placements, pick the right one:**
1. **Inline control** — short primitives only: `Input` (width-capped), `Switch`, small `Select`. Saves on change.
2. **Clickable row → sub-dialog** — anything complex: picker over a large list, rules builder, key-value map, multi-row editor. `onClick` on the row opens the dialog; `SettingsRowValue` on the right shows a summary ("`3 rules`", "`8 fields`", the selected name). The dialog owns draft state + a single Save button.
3. **Clickable row → child page** — only when the nested thing itself needs multiple groups, its own test/preview, or its own audit feed. Navigate via `<Link>`-wrapping the row. Use sparingly; most things fit in a dialog.

**Save modes — pick the right one per page:**

**1. Auto-save (default for most pages).** Each row/control is an independent decision; saving one doesn't imply saving the rest. Use for: Identity (name, description, active), Auth & limits (rate limit, allowlist), Operations. Examples: `/admin/webhooks/:id`, `/admin/criteria-sets/:id`.
- Text inputs: wrap with `useDebouncedSave(value, (v) => save({ field: v }, { silent: true }))`. No toast on silent save.
- Switches / selects that trigger immediately: `save({ field: next })` — toast on success is OK but optional.
- Dialog-driven saves: call `save({ field: next })` inside `onSave`, then close the dialog. Toast is acceptable here since the user clicked Save.

**2. Batch save (page-level Save button).** The edit is an atomic, consequential decision that admins expect to commit once. The audit log should treat it as one event, not N toggles. Use for: role permissions, workflow definitions, form schemas — anything where "I'm adjusting many fields at once, then committing" is the real workflow. Examples: `/admin/user-roles/:id`.
- `SettingsFooterActions` at the bottom with primary Save + secondary Cancel.
- **Always** show unsaved-changes state (sticky bar or enabled/disabled Save) and a **diff preview** (what's being added/removed since last save) before the user commits. Without that, batch-save becomes "fire and forget" — no worse than auto-save but with extra clicks.
- Cancel confirms before discarding unsaved changes.
- Route to detail page after create.

**3. Per-section save (hybrid — when a page mixes both).** Some pages have auto-save primitives in most sections but one section that's a batch decision (e.g. a JSON policy editor, a permissions matrix, a CRON expression). Put the Save button **inside that section's container**, not at the page bottom. Keeps the rest of the page auto-saving; makes the batched block's atomicity obvious.

**Validation errors:** server-side problems (e.g. 422 with a `validation.problems` payload) surface as a single warning card directly below the header — not as per-field errors — because SettingsRow has no error slot. For batch-save pages, the warning can also mention what will fail on submit.

**Audit log coupling:** batch-save pages should emit **one** audit event per save with a before/after diff in the payload. Auto-save pages emit one event per field change. Don't mix — it muddies the audit timeline.

**Danger group — always:**
- Final group on every detail page. Title: `"Danger zone"`.
- Destructive actions route through `ConfirmDialog` with `destructive` styling and a specific description that names the consequence ("The external system will receive 401 on any future request").
- Key rotations / similar one-shots also go here (not in Identity).

**Primitives to use — don't reinvent:**
- `SettingsPageShell`, `SettingsPageHeader` — `apps/web/src/components/ui/settings-page.tsx`.
- `SettingsGroup`, `SettingsRow`, `SettingsRowValue` — `apps/web/src/components/ui/settings-row.tsx`.
- `ConfirmDialog` — `apps/web/src/components/confirm-dialog.tsx`.
- `useDebouncedSave` — `apps/web/src/hooks/use-debounced-save.ts`.
- `Dialog` + `FieldGroup`/`Field` — for sub-dialogs (still mandatory per §Form composition).

**Before writing a new settings page, copy the skeleton of `/admin/webhooks/:id` and adapt.** If you're tempted to deviate (e.g. replace `SettingsRow` with a 2-column form, or add a page-level Save button), re-read this section first — the deviation is almost never justified.

## Spec Documents
All in `docs/`:
- `docs/spec.md` — main product specification (~3000 lines, comprehensive)
- `docs/build-strategy.md` — build strategy (phase UI, not architecture)
- `docs/phase-1.md` through `docs/phase-4.md` — phase plans with detailed scope per phase

## Design polish rules (mandatory — baked into apps/web/src/index.css)

These are established app-wide defaults. Don't override them per component unless the design genuinely calls for it. If you find yourself hand-rolling one, stop — use the token / helper instead.

### Typography

- **Fonts.** Geist Sans + Geist Mono are loaded globally. Never add another typeface without discussing it — Geist everywhere is a deliberate cohesive choice matching Linear / Vercel / shadcn.
- **Antialiasing.** `body` is `antialiased` with `-webkit-font-smoothing: antialiased` + `-moz-osx-font-smoothing: grayscale`. Grayscale AA, not subpixel. Don't override.
- **Heading wrap.** `h1/h2/h3/h4` use `text-wrap: balance` (no orphans). Paragraphs use `text-wrap: pretty`. Auto.
- **Tabular numerals.** `table`, `time`, `.tabular-nums`, and `[data-tabular-nums]` elements get tabular-nums app-wide. Any counter / metric / digit that changes over time should be inside one of those — or add the class when you render a number that might change.

### Numbers + time — always via `@/lib/format`

Never call `toLocaleString` / `Intl.NumberFormat` / `Intl.RelativeTimeFormat` directly in page code. The helpers in `apps/web/src/lib/format.ts` exist so every user-visible number / timestamp reads cohesively:

- **`formatCount(n)`** — plain for < 1000, compact (`1.5K`, `23M`) above. Use on every counter/badge.
- **`formatRelativeTime(input)`** — `"2 minutes ago"` / `"in 3 days"`. Use as the visible label on timestamps in lists, audit feeds, activity streams.
- **`formatFullTimestamp(input)`** — "Apr 24, 2026, 3:14 PM". Use as `title` tooltip on a `<time>` that displays relative time, so power users can hover for the exact value.

### Motion

- **Easing tokens on `:root`.** `--ease-snap` (fast feedback), `--ease-smooth` (layout), `--ease-spring` (modals/celebratory), `--ease-swift-out` (dismiss). Use via `transition-timing-function: var(--ease-smooth)` — never hand-roll a `cubic-bezier(...)` in TSX files.
- **Duration guidelines.** Hover/press: 80–150ms with snap. Layout/dropdown: 200–300ms with smooth. Modal/sheet: 300–500ms with spring. Dismiss: 150–220ms with swift-out.
- **Reduced-motion.** Globally handled — `@media (prefers-reduced-motion: reduce)` clamps every animation/transition to 0.001ms. Don't wrap individual components — the global rule already covers them.
- **Active press on buttons.** The shared `Button` uses `translate-y-px` on active — do NOT replace with `scale`, which blurs text mid-press. For non-button clickable rows (e.g. a `SettingsRow`), don't add any press feedback; the row background hover is the affordance.
- **View transitions.** A global 240ms crossfade is set for same-document view transitions in browsers that support them. To actually trigger it on a route change, pass `unstable_viewTransition` to the React Router `<Link>` — one prop, per link as appropriate.

### Elevation + borders

- **Shadows are last resort.** Prefer `border border/50` + optional `ring-1 ring-black/5` over `shadow-*`. Heavy drop shadows read "dated website", not "app". Exceptions: popover/dropdown/sheet overlays (already shipped), and drag-overlays for dnd (use `shadow-lg`).
- **Focus rings.** Use `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` — the Button baseline. Matches across controls; never show focus on mouse click (don't use plain `:focus`).

### Copy chips

- **Permission keys / JSONPath / any token a user might copy:** wrap in `<code className="chip">…</code>` or add `data-chip` on a larger element so triple-click selects it atomically. The global `code.chip, [data-chip] { user-select: all }` handles the rest.
- **Code elements default to `user-select: text`** (not the browser default `none` that some themes set) — don't override unless you need different behaviour.

### Widths

- **Settings pages use the fixed `SettingsPageWidth` enum (`narrow` / `default` / `wide` / `xwide`).** Never invent an arbitrary `max-w-[1180px]`. See §Settings page layout for which to pick.
- **Portal content is centred in `max-w-6xl` (1152px)** — the portal layout handles it. Page-level components inside the portal should not set their own max-w.

### Platform

- **`<meta name="color-scheme" content="light dark" />`** is set in `index.html`. Don't remove it — it makes browser chrome (scrollbars, pre-paint inputs) match the theme.
- **Focus management on dialogs.** The shadcn `Dialog` primitives handle trap + restore correctly. Don't hand-roll focus logic on top of them.

### When you're tempted to deviate

- Adding a font? → stop, use Geist.
- Picking a cubic-bezier? → stop, use `--ease-*`.
- Calling `.toLocaleString()` in page code? → stop, use `@/lib/format`.
- Setting `max-w-[NNNpx]` on a settings page? → stop, use the enum.
- Adding `shadow-lg` to a card? → stop, think about whether a border works.
- Setting `transition duration-300 ease-in-out` on a text element? → `transition-all duration-200 ease-[var(--ease-smooth)]` or drop the transition.
