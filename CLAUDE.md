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
- `pnpm smoke:work-orders` / `pnpm smoke:tickets` / `pnpm smoke:edit-booking-scope` / `pnpm smoke:edit-booking` / `pnpm smoke:cancel-booking` / `pnpm smoke:create-multi-room` / `pnpm smoke:attach-services` / `pnpm smoke:cancel-order-line` / `pnpm smoke:recurrence-clone` / `pnpm smoke:floor-plans` / `pnpm smoke:visual-approval` / `pnpm smoke:cross-tenant` — live-API smoke probes (see Smoke gates below)

## Smoke gates (mandatory before claiming ship)

Live-API integration probes that mint a real Admin JWT and exercise the running dev server. They exist because mocked-Supabase jest tests pass even when the real DB write fails (2026-05-01 P0) and no-op fast paths silently break on NUMERIC round-trip (Slice 3.1). Code review + jest specs are **necessary but not sufficient** — they don't talk to a real database.

**Full reference:** [`docs/smoke-gates.md`](docs/smoke-gates.md) — probe matrices, fixture details, validation gates.

Run the gate before claiming complete:
- `WorkOrderService` / `TicketService.update` / desk-detail sidebar → `pnpm smoke:work-orders`
- `TicketService.bulkUpdate` (audit-02 P0-1 `PATCH /tickets/bulk/update` 200/207/422) / `TicketService.reassign` (P1-1 case + `rerun_resolver`) / `SlaService.checkBreaches`→`fireThreshold`→`applyReassignment` (P0-2 SLA-escalation reassign) / `RoutingEvaluationHandler` (P1-2 `routing_status` clear) / `TicketService.getChildTasks` (P1-5 cross-visibility) / `ReclassifyService.execute` / satisfaction round-trip (P1-3, `update_entity_combined` v7) → `pnpm smoke:tickets`
- `ReservationService.editScope` / `edit_booking_scope` RPC → `pnpm smoke:edit-booking-scope`
- `ReservationService.editOne` / `editSlot` / `edit_booking` RPC (00364) → `pnpm smoke:edit-booking`
- `ReservationService.cancelOne` / `POST /reservations/:id/cancel` / `cancel_booking_with_cascade` RPC (00408) / `RecurrenceService.cancelForward` / `BookingCancelledCascadeHandler` / `BundleCascadeAdapter.handleBundleCancelled` → `pnpm smoke:cancel-booking`
- `MultiRoomBookingService.createGroup` / `POST /reservations/multi-room` / `create_booking_with_attach_plan` RPC (00309/00315) multi-slot consumer / multi-room room-rule approval fan-out → `pnpm smoke:create-multi-room`
- `BundleService.attachServicesToBooking` / `POST /reservations/:id/services` / `attach_services_to_existing_booking` RPC (00412/00413) / `attach_operations` idempotency / `BundleService.buildAttachPlan`+`hydrateLines` / `buildAttachServicesIdempotencyKey` / `mapAttachRpcError` → `pnpm smoke:attach-services`
- `BundleCascadeService.cancelLine` / `cancelBundle` / `DELETE /reservations/:id/services/:lineId` / `DELETE /reservations/:id/bundle` / `cancel_order_lines_with_cascade` RPC (00414) / `bundle-services-cancelled-cascade.handler.ts` / `BundleCascadeAdapter.handleBundleCancelled` / `buildCancelOrderLinesIdempotencyKey` / `mapCancelOrderLinesRpcError` → `pnpm smoke:cancel-order-line`
- `RecurrenceService.materialize` / `cloneBundleOrdersToOccurrence` / `OrderService.cloneOrderForOccurrence` / `BookingFlowService.startSeries` / `recurrence_series` creation / `deleteOrphanOccurrence` + `delete_booking_with_guard` (recurrence compensation primitive) / `booked-by-user-id.util.ts` (`bookedByUserIdForRpc`) / synthetic `SYSTEM_ACTOR` or Outlook system actor / any re-introduction of an in-process compensation boundary → `pnpm smoke:recurrence-clone`
- `FloorPlanService` / `publish_floor_plan_draft` RPC / floor-plan editor → `pnpm smoke:floor-plans`
- `BookingFlowService` consumer cutover / `ApprovalConfigCompilerService` / `grant_booking_approval` v2 / `ensure_room_booking_rule_workflow_definition` / `cancel_workflow_instance_with_approvals` (Phase 1.5 visual approval workflow) → `pnpm smoke:visual-approval`
- `AuthGuard` / `AdminGuard` / `PermissionGuard` / global tenant binding / any admin/config controller using `TenantContext.current()` / any schema-wide `REVOKE`/`GRANT EXECUTE` or RLS-helper function change (`current_tenant_id` etc.) → `pnpm smoke:cross-tenant` (also covers browser-path RLS-helper EXECUTE regression — the blanket-`REVOKE EXECUTE` class behind the 00417 outage; service_role-path gates miss it)

Exit 0 = green; exit 1 = at least one regression.

## Supabase: remote vs local — READ BEFORE WRITING MIGRATIONS

**Dev connects to the REMOTE Supabase project**, not the local stack. `.env` points `SUPABASE_URL` at `https://iwbqnyrvycqgnatratrk.supabase.co`. The API, web, and browser all talk to remote in day-to-day dev.

- `pnpm db:reset` ONLY touches local Supabase. A migration that applies locally is invisible to the running app until pushed.
- To make a migration take effect: `pnpm db:push` (preferred) — but the CLI has failed auth here, so the working fallback is `PGPASSWORD='<db_pass>' psql "postgresql://postgres@db.iwbqnyrvycqgnatratrk.supabase.co:5432/postgres" -v ON_ERROR_STOP=1 -f supabase/migrations/<file>.sql`, then `NOTIFY pgrst, 'reload schema';`. DB password is in `.env` as `SUPABASE_DB_PASS` (also mirrored in `.claude/CLAUDE.md`).
- **Always confirm before pushing.** It writes to a shared/production project — treat it like a deploy.
- `PGRST205` or 500s from new endpoints after a migration = unpushed migration. Check `SUPABASE_URL` first.
- `supabase db reset` is destructive — never run against remote.

**Done checklist:** migration in `supabase/migrations/` with next prefix · `pnpm db:reset` validates SQL · user authorized push · smoke query via running API confirms data visible.

## Architecture
- **Tenant isolation:** Supabase RLS. Every table has `tenant_id`.
- **Tenant resolution:** AsyncLocalStorage middleware resolves tenant from subdomain or `X-Tenant-Id` header.
- **Auth:** Supabase Auth (JWT). Backend validates via `AuthGuard`.
- **Module boundaries:** NestJS modules with explicit service exports. No module touches another module's tables directly.
- **Multi-step writes are PL/pgSQL RPCs, not TS pipelines.** If a feature writes to ≥2 tables and any partial-write state is corrupting (cross-table invariants, FK chains, audit-trail integrity, outbox emit + domain mutation), the writes go inside one PL/pgSQL function called from TS — NOT a sequence of supabase-js calls. The `BookingTransactionBoundary` + in-process compensation pattern is legacy (Phase 6 hardening backlog). Reference: [`docs/superpowers/specs/2026-05-04-domain-outbox-design.md`](docs/superpowers/specs/2026-05-04-domain-outbox-design.md) §1 + §3.1. Canonical RPCs: `create_booking_with_attach_plan` (00309), `grant_booking_approval` (00310), `approve_booking_setup_trigger` (00311), `create_setup_work_order_from_event` (00312). TS preflight + plan assembly is fine; the writes are atomic in Postgres. Best-effort post-commit emissions go through `OutboxService.emit()`.
- **Org structure (requester side):** `org_nodes` is the per-tenant requester hierarchy. Persons attach via `person_org_memberships`. Location grants via `org_node_location_grants` cascade to members + descendants. See `portal_authorized_root_matches` (00080) and [`docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md`](docs/superpowers/specs/2026-04-22-organisations-and-admin-template-design.md).

## Assignments, Routing & Fulfillment

**Full reference:** [`docs/assignments-routing-fulfillment.md`](docs/assignments-routing-fulfillment.md). Read before changing routing, dispatch, SLA, or case/work-order behavior.

Four orthogonal axes — keep them separate:
1. **Routing** (scope + request type) — `ResolverService` + `routing_rules`.
2. **Ownership** — parent case's `assigned_team_id` (the service desk).
3. **Execution** — child work orders' assignees (user or vendor). Created via `DispatchService` / `POST /tickets/:id/dispatch`.
4. **Visibility** — query-layer filters (separate doc below).

Resolver order (first match wins): routing rules → asset branch → location branch (with space-group + domain-parent fallback) → request-type default → unassigned. Every decision is persisted to `routing_decisions`. Vendors are first-class assignees alongside teams and users.

### MANDATORY: keep the reference doc in sync

**Touching any of these = update `docs/assignments-routing-fulfillment.md` in the same PR.** Silent drift is how routing bugs hide.

Trigger files: `apps/api/src/modules/routing/**` · `ticket/dispatch.service.ts` · `ticket/ticket.service.ts` (post-create automation, create/list DTOs, `getChildTasks`, reassignment) · `ticket/ticket.controller.ts` (routing endpoints) · `sla/**` · `approval/**` (anything touching `pending_approval`) · `workflow/workflow-engine.service.ts` (especially `create_child_tasks`).

Trigger migrations — any add/alter of: `tickets`, `request_types`, `routing_rules`, `routing_decisions`, `location_teams`, `space_groups`, `space_group_members`, `domain_parents`, `sla_policies`, `sla_timers`, `teams`, `vendors`, `assets`, `asset_types`.

Fix the doc first, then align code to the corrected doc.

## Ticket Visibility

**Full reference:** [`docs/visibility.md`](docs/visibility.md). Read before changing any read/write path on tickets.

Three-tier model: **Participants** (requester · assignee · watcher · vendor) · **Operators** (team member · role domain + location scope) · **Overrides** (`tickets:read_all` / `tickets:write_all` on `roles.permissions`). Enforced via `TicketVisibilityService` (`loadContext` + `getVisibleIds` + `assertVisible`). Canonical SQL predicate: `public.ticket_visibility_ids(user_id, tenant_id)`.

**Same sync-the-doc rule.** Trigger files: `ticket/ticket-visibility.service.ts` · `ticket/ticket.service.ts` (read/write signatures or gates) · `ticket/ticket.controller.ts` (req.user.id routing) · any migration altering `ticket_visibility_ids`, `expand_space_closure`, `user_has_permission`, the tickets columns they reference (`requester_person_id`, `assigned_user_id`, `assigned_team_id`, `assigned_vendor_id`, `watchers`, `location_id`) · any migration changing `users`, `user_role_assignments`, `team_members`, `roles.permissions`, `spaces.parent_id`.

## Frontend Rules

- **Server state = React Query.** Follow [`docs/react-query-guidelines.md`](docs/react-query-guidelines.md) — one key factory per module under `apps/web/src/api/<module>/`, `queryOptions` helpers, hierarchical keys (`all` → `lists`/`list` → `details`/`detail` → sub-resources), optimistic updates via `onMutate` + rollback. The legacy `useApi` hook is being migrated out — no new callers. When touching a `useApi` file, consider migrating.
- **shadcn/ui first.** Check shadcn before any UI element. Use `context7` for latest shadcn docs. Raw HTML only when no shadcn component fits. Install with `npx shadcn@latest add <name>`. Installed components live in `apps/web/src/components/ui/`.
- **Design reference:** Linear — clean, spacious, minimal borders, subtle color, properties sidebar on the right.
- **Make components reusable by default.** Inline JSX or page-local helper? Ask: will this pattern be used in more than one place? If yes (or plausibly yes), extract into `apps/web/src/components/` as prop-driven. Spot duplicated JSX across 2+ files → consolidate before copying a third time.

### Form composition (mandatory)

Every form — dialog, sheet, drawer, page-level, inspector panel — is built from the shadcn Field primitives in `apps/web/src/components/ui/field.tsx`. Never hand-roll with `<div className="grid gap-1.5">` + `<Label>` + `<Input>`.

- Wrap the form body in `<FieldGroup>`. Nothing else sets vertical rhythm.
- Each label + control = `<Field>` with `<FieldLabel htmlFor="…">`. The `id`/`htmlFor` pair is required.
- Helper text: `<FieldDescription>`. Inline errors: `<FieldError>` (not toasts).
- Group related fields: `<FieldSet>` + `<FieldLegend>`. Separate sections: `<FieldSeparator>` (not `border-t pt-4` + bare `<h3>`).
- Checkbox/radio rows: `<Field orientation="horizontal">` with the control first and `<FieldLabel className="font-normal" htmlFor="…">` second.
- Never `className="w-full"` on a `SelectTrigger`. The vertical Field already stretches via `*:w-full`.

Canonical examples: `apps/web/src/components/desk/create-ticket-dialog.tsx`, `apps/web/src/components/admin/request-type-dialog.tsx`. Query `context7` for "shadcn field" for the source shape. If you find a non-conforming form, migrate it — don't copy its pattern.

### Toasts (mandatory)

Every toast goes through `apps/web/src/lib/toast.ts` — never import from `'sonner'` directly in feature code. The wrapper enforces voice (`Couldn't <verb> <thing>` for errors, `<Thing> <past-verb>` for success), retry on errors, View on creates, Undo on reversible removes.

- `toastCreated(entity, { onView })` — new entity; wire `onView` to detail route.
- `toastSaved(entity, { silent })` — auto-save flows pass `silent: true`.
- `toastUpdated(entity)` — committed state change.
- `toastRemoved(entity, { verb, onUndo })` — pick closest verb (`removed | deleted | detached | revoked | archived | deactivated | unpublished | cancelled`); wire `onUndo` unless genuinely irreversible.
- `toastError(title, { error, retry })` — title/description split is automatic; pass `retry` for re-runnable mutations.
- `toastSuccess(title, …)` — generic success not tied to an entity.

**Form validation is NOT a toast** — disable the submit button or use `<FieldError>`. Full rules: [`docs/toast-conventions.md`](docs/toast-conventions.md).

### Error handling (mandatory)

Every feature follows [`docs/superpowers/specs/2026-05-02-error-handling-system-design.md`](docs/superpowers/specs/2026-05-02-error-handling-system-design.md). The spec is the contract. Touch the spec in the same PR when a feature reveals a gap.

**Non-negotiables:**

- **Server: throw `AppError`, never `new Error('...')`.** Use factories in `apps/api/src/common/errors/app-error.ts`. New scenarios add a code to `packages/shared/src/error-codes.ts` + an English message in `messages.en.ts`. Migrated modules (ticket / sla / booking-bundles / reservations / approval) are gated by `pnpm errors:check-app-errors`. Server validation goes through `throwZodError`.
- **Server: no user-facing prose in error messages.** Vendor errors (Resend, Supabase, Stripe, Postgres) map to neutral codes. Unregistered codes render as `unknown.server_error`.
- **Client: use the error helpers, not hand-rolled `onError`.** Spread `withErrorHandling({ actionTitle: "Couldn't <verb> <thing>" })` into `useMutation`, OR call `handleMutationError(error, { actionTitle, retry, setFormError })` inside your own `onError` (when you need rollback / cache invalidation). Page queries use `usePageQuery` (auto-throws page-class errors to `RouteErrorBoundary`); sidebar/autocomplete use `useQuery` + `handleQueryError`.
- **Client: every new top-level `<Route element={…}>` MUST wrap in `<RouteErrorBoundary>`.** Caught by the route-tree lint check.
- **Bulk ops use `results[]` + `partialSuccess`** — surface as `"7 of 10 deleted — 3 failed [Show me]"`, never a binary toast.
- **Never invent a new error class or surface.** The 11 classes in §3.3 are exhaustive; the surface comes from `(class, callSite)` per §3.4. If it doesn't fit, update the spec.
- **Realtime status UI is the inline page-header dot**, not the avatar corner. Driven by `RealtimeStatusStore` + `useRealtimeStatus()`. Hidden on `'open'` for first 30s · amber on `'reconnecting'` · red + writes-disabled on `'broken'`.

### Admin / settings pages

**Full reference:** [`docs/admin-page-conventions.md`](docs/admin-page-conventions.md) — width enum, index+detail shape, save modes (auto / batch / per-section), `SettingsRow` vs `FieldGroup`, danger zone, primitives.

Quick mental model:
- Build with `SettingsPageShell` / `SettingsPageHeader` / `SettingsSection` / `SettingsFooterActions`.
- Pick width from the fixed enum: `narrow | default | wide | xwide | ultra | full`. Don't invent `max-w-[1180px]`.
- Index page: list with name linking to detail, no action column. Detail page: stack of `SettingsGroup` blocks (Identity → Primary config → Operations → Auth/limits → Danger zone).
- Use `SettingsRow` for independent decisions (Linear's "list of decisions"), `FieldGroup` for grouped forms.
- Default to **auto-save**. Use **batch-save** only when the edit is one atomic consequential decision (role permissions, workflow defs).
- Canonical exemplars to copy from: `/admin/webhooks/:id`, `/admin/criteria-sets/:id`, `/admin/users/roles/:id`, `/admin/users/:id`.

Skip the shell only for React Flow canvases (`/admin/workflow-editor`) and self-managed split-pane viewers.

## Spec Documents

In `docs/`:
- `spec.md` — main product specification (~3000 lines)
- `build-strategy.md` — build strategy (phase UI, not architecture)
- `phase-1.md` through `phase-4.md` — phase plans

## Design polish rules (baked into `apps/web/src/index.css`)

App-wide defaults. Don't override per component unless the design genuinely calls for it.

**Typography**
- Geist Sans + Geist Mono globally. Don't add another typeface without discussing.
- `body` is `antialiased` with grayscale AA, not subpixel — don't override.
- `h1–h4` use `text-wrap: balance`; paragraphs use `text-wrap: pretty`. Auto.
- `table`, `time`, `.tabular-nums`, `[data-tabular-nums]` get tabular numerals — use them on any changing number.

**Numbers + time — always via `@/lib/format`**
- Never call `toLocaleString` / `Intl.NumberFormat` / `Intl.RelativeTimeFormat` in page code.
- `formatCount(n)` — plain for < 1000, compact (`1.5K`, `23M`) above. Use on counters/badges.
- `formatRelativeTime(input)` — `"2 minutes ago"` / `"in 3 days"`. Use as visible label.
- `formatFullTimestamp(input)` — "Apr 24, 2026, 3:14 PM". Use as `title` tooltip on a `<time>` showing relative time.

**Motion**
- Easing tokens on `:root`: `--ease-snap` (fast feedback), `--ease-smooth` (layout), `--ease-spring` (modals), `--ease-swift-out` (dismiss). Use `transition-timing-function: var(--ease-smooth)` — never hand-roll a `cubic-bezier(...)` in TSX.
- Durations: hover/press 80–150ms snap · layout/dropdown 200–300ms smooth · modal/sheet 300–500ms spring · dismiss 150–220ms swift-out.
- Reduced-motion is handled globally — don't wrap components.
- Active press on buttons uses `translate-y-px`, not `scale` (scale blurs text mid-press). Non-button clickable rows have no press feedback — background hover is the affordance.
- View transitions: a global 240ms crossfade is set; pass `unstable_viewTransition` on `<Link>` to trigger.

**Elevation + borders**
- Shadows are last resort. Prefer `border border/50` + optional `ring-1 ring-black/5` over `shadow-*`. Exceptions: popover/dropdown/sheet overlays (already shipped), drag-overlays (`shadow-lg`).
- Focus rings: `focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50` (the Button baseline). Never `:focus` on mouse click.

**Copy chips**
- Permission keys / JSONPath / any copy-token: wrap in `<code className="chip">…</code>` or add `data-chip`. Global `user-select: all` handles atomic triple-click.
- `code` elements default to `user-select: text` — don't override.

**Widths**
- Settings pages use the fixed `SettingsPageWidth` enum — never `max-w-[NNNpx]`.
- Portal content is centred in `max-w-6xl` (1152px) by the portal layout — page components don't set their own.

**Platform**
- `<meta name="color-scheme" content="light dark" />` is in `index.html` — don't remove.
- shadcn `Dialog` handles focus trap + restore — don't hand-roll on top.
