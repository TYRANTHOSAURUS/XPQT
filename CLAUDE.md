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

## Frontend Rules
- **Always use shadcn/ui components first.** Before creating any UI element, check if shadcn has a component for it. Use `context7` to look up the latest shadcn docs. Only use raw HTML elements if no shadcn component exists for the use case.
- **Install shadcn components before using them:** `npx shadcn@latest add <component-name>`
- **Design reference:** Linear app — clean, spacious, minimal borders, subtle color usage, properties sidebar on the right.
- Installed components are in `apps/web/src/components/ui/`. Check there before installing duplicates.

## Spec Documents
The full product specification and phase plans are in `/Users/x/Downloads/`:
- `prequest_x_.md` — main product specification
- `prequest_build_strategy.md` — build strategy (phase UI, not architecture)
- `prequest_phase_1.md` through `prequest_phase_4.md` — phase plans
