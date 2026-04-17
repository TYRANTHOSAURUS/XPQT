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

## Frontend Rules
- **Always use shadcn/ui components first.** Before creating any UI element, check if shadcn has a component for it. Use `context7` to look up the latest shadcn docs. Only use raw HTML elements if no shadcn component exists for the use case.
- **Install shadcn components before using them:** `npx shadcn@latest add <component-name>`
- **Design reference:** Linear app — clean, spacious, minimal borders, subtle color usage, properties sidebar on the right.
- Installed components are in `apps/web/src/components/ui/`. Check there before installing duplicates.
- **Make components reusable/generic by default.** Before writing an inline block of JSX or a page-local helper component, ask: will this pattern be used in more than one place? If yes (or plausibly yes), extract it into `apps/web/src/components/` as a prop-driven, domain-parameterized component — not a one-off. If you spot duplicated JSX across two or more files, stop and consolidate into a shared component instead of copying it a third time. Exceptions only for truly page-specific, non-reusable markup.

## Spec Documents
All in `docs/`:
- `docs/spec.md` — main product specification (~3000 lines, comprehensive)
- `docs/build-strategy.md` — build strategy (phase UI, not architecture)
- `docs/phase-1.md` through `docs/phase-4.md` — phase plans with detailed scope per phase
