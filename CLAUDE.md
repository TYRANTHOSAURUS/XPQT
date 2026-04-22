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

## Spec Documents
All in `docs/`:
- `docs/spec.md` — main product specification (~3000 lines, comprehensive)
- `docs/build-strategy.md` — build strategy (phase UI, not architecture)
- `docs/phase-1.md` through `docs/phase-4.md` — phase plans with detailed scope per phase
