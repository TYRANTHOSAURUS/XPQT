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
- `pnpm db:reset` — reset database and re-run migrations

## Architecture
- **Tenant isolation:** Supabase RLS (row-level security). Every table has tenant_id.
- **Tenant resolution:** AsyncLocalStorage middleware resolves tenant from subdomain or X-Tenant-Id header.
- **Auth:** Supabase Auth (JWT). Backend validates tokens via AuthGuard.
- **Module boundaries:** NestJS modules with explicit service exports. No module touches another module's tables directly.

## Routing model
Ticket assignment is a two-layer system:
1. **Overrides:** admin-defined `routing_rules` (first match wins) — used when a specific situation needs to bypass the default resolver.
2. **Resolver chain:** `ResolverService` (`apps/api/src/modules/routing/resolver.service.ts`) picks an assignee based on the request type's `fulfillment_strategy`:
   - `asset` → asset's `override_team_id` → asset type's `default_team_id` → request type's `default_team_id` → unassigned
   - `location` → `location_teams(space, domain)` → walk parent spaces → request type's `default_team_id` → unassigned
   - `auto` → asset first, location second, then fallbacks
   - `fixed` → request type's `default_team_id` → unassigned

Every decision is persisted to `routing_decisions` with a full trace. To debug "why did my ticket land on team X?":
```sql
select chosen_by, strategy, trace from routing_decisions where ticket_id = '…';
```

Vendors are first-class assignees alongside teams and users — see `tickets.assigned_vendor_id`, `asset_types.default_vendor_id`, `location_teams.vendor_id`.

## Frontend Rules
- **Always use shadcn/ui components first.** Before creating any UI element, check if shadcn has a component for it. Use `context7` to look up the latest shadcn docs. Only use raw HTML elements if no shadcn component exists for the use case.
- **Install shadcn components before using them:** `npx shadcn@latest add <component-name>`
- **Design reference:** Linear app — clean, spacious, minimal borders, subtle color usage, properties sidebar on the right.
- Installed components are in `apps/web/src/components/ui/`. Check there before installing duplicates.

## Spec Documents
All in `docs/`:
- `docs/spec.md` — main product specification (~3000 lines, comprehensive)
- `docs/build-strategy.md` — build strategy (phase UI, not architecture)
- `docs/phase-1.md` through `docs/phase-4.md` — phase plans with detailed scope per phase
