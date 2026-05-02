# Error Handling System — Design

Date: 2026-05-02
Status: design proposal; awaiting brainstorming + writing-plans
Owner: platform / frontend
Depends on: nothing — this is foundational and unblocks every other surface

Related code (current state, audited 2026-05-02):
- [`apps/web/src/lib/api.ts`](../../../apps/web/src/lib/api.ts) — `ApiError` exists with `isNetworkError / isClientError / isServerError` and a `details` getter, but stops there.
- [`apps/web/src/lib/query-client.ts`](../../../apps/web/src/lib/query-client.ts) — already partly classifies retry behaviour by error class, and logs 401s in two cache callbacks. No redirect, no toast routing.
- [`apps/web/src/lib/toast.ts`](../../../apps/web/src/lib/toast.ts) — `describeError` blindly stringifies whatever was thrown. No code lookup, no recovery action, no locale.
- `apps/api/src` has **zero `*.filter.ts` files** and **zero `@Catch` decorators**. Errors flow through Nest's default filter; a single coded error exists (`permission_denied` in `permission-guard.ts:45`), the rest are free-form prose.

## 1 · Why this exists

Today every error in the platform — network drop, expired session, RLS denial, 422 validation, version conflict, 5xx, Postgres constraint, Resend down, Supabase realtime drop, optimistic-update rollback — funnels through one path: `something throws → React Query onError → toastError(title, { error })`. The user gets the same flavour of "Couldn't save (something cryptic)" regardless of cause.

That's not a missing feature. It's a missing **contract** at three layers (server → transport → client) and a missing **taxonomy** of error classes with per-class recovery. Until both ship, every other UX investment runs into the same wall: things go wrong, the user can't tell why, and they can't tell what to do.

This is also a **competitive** problem. Linear, Stripe Dashboard, Vercel Dashboard, Figma — all treat error UX as a designed surface. The platforms FMIS competes with (Eptura, Planon, ServiceNow, Robin) are *worse* at this than us. The platforms FMIS aspires to are dramatically better. Closing that gap is a one-time platform investment, not a feature.

## 2 · Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Adopt **RFC 9457 Problem Details** as the wire shape for all error responses. | Industry standard, replaces RFC 7807, already what Stripe / Linear / Vercel converged on. Future-proof. |
| 2 | Every error response carries `code` (stable, machine-readable) + `title` (human outcome) + `detail` (one-line explanation) + optional `fields[]` + always a `traceId`. | Code is the join key for client message lookup + recovery. TraceId is non-negotiable — support uses it. |
| 3 | A **single global Nest `AllExceptionsFilter`** normalises every thrown thing — `HttpException`, `class-validator` errors, raw `pg` errors, `PostgrestError`, unknown errors — into the wire shape. Migrating call sites is incremental; the filter handles legacy `BadRequestException(string)` cleanly. | One file, every endpoint benefits day one. Migrate throw sites by traffic, not all-at-once. |
| 4 | An **`AppError` class** (server) with `code`, `status`, `fields?`, `cause?`, `docsUrl?`. New throw sites use it. Legacy `BadRequestException(string)` is mapped by the filter to `code: 'generic.bad_request'` until migrated. | Coded errors at the source preserve intent; string errors stay supported during migration. |
| 5 | A **client-side `classify()` function** turns any thrown thing (`ApiError`, `Error`, fetch failure, abort) into a `ClassifiedError` with `class` + `code` + `fields?` + `traceId?` + `recovery`. **Classification happens once, at the boundary.** Renderers read the classified shape. | Decouples "what went wrong" from "how it shows up". Without this layer every renderer re-derives the same state. |
| 6 | **11 error classes**, each mapped to a default surface and recovery. (Matrix in §4.) Classes are exhaustive — every error must classify into exactly one. `unknown` exists as a last-resort bucket for renderer correctness, but landing there is a bug to fix at the classifier. | A taxonomy with a default-OK case isn't a taxonomy. Forcing exhaustiveness drives classifier completeness. |
| 7 | The **surface for an error is decided by class, not call site**. Toasts are right ~30% of the time; transport errors get a banner, page-level errors replace the page, field errors paint inline. Renderers expose `handle(error, context)` that routes correctly. | Right now every error is a toast. That's why the app feels noisy and useless when things go wrong. |
| 8 | **Every error has a recovery.** If the design can't name one, the class is wrong. Recovery options are typed: `retry` · `signIn` · `reload` · `goBack` · `pickAlternative` · `askAdmin` · `contactSupport` · `dismiss`. | "Try again" is the floor, not the ceiling. The button labels are the UX. |
| 9 | **Messages are looked up client-side by `code`, not read from the server's `title`/`detail`.** Server message is fallback only. Lookup table is per-locale; Dutch first-class. | Localisation, ability to rewrite a confusing message without a deploy, ability to gracefully handle codes the client doesn't know yet. |
| 10 | **TraceId everywhere.** Generate at request boundary (`X-Request-Id`), echo in every error response and every server log line, surface subtly on every user-visible error (copy-on-click). Frontend captures it on every `ApiError`. | Highest-leverage single change. Support resolution drops from 30 min to 30 sec. |
| 11 | **Field-level errors never toast.** When `fields[]` is present, the form's mutation hook stuffs them into RHF state and the toast either suppresses or becomes a generic "Some fields need attention." | The current setup turns `class-validator` arrays into comma-joined toast text — unusable. |
| 12 | **Optimistic-update rollback is animated and explained.** The `useMutation` `onError` rollback path adds a one-line toast "We undid that change because: <reason from code>". Silent reverts are banned. | Most apps fail here; it's a high-leverage polish moment. |
| 13 | **No vendor names leak to users.** Resend / Supabase / Stripe / Postgres errors are mapped to neutral codes (`email.dispatch_failed`, `realtime.unavailable`, `payment.failed`, `db.constraint`). Internal logs keep the original. | Both branding (don't ship "Resend down") and security (don't leak stack info). |
| 14 | **Page-level errors replace the page**, not toast over a now-broken page. Implemented via per-route React class `ErrorBoundary` components wrapping each top-level route element (`<Route element={<ErrorBoundary><DeskPage/></ErrorBoundary>}>`). The boundary catches both render errors *and* errors thrown into a `throwToBoundary()` ref by query/mutation hooks for page-level classes (`not_found`, `forbidden`, `gone`, generic 500). Renders forbidden / not-found / gone / offline / generic 500 states. | Toasting "Not found" while leaving a broken detail page on screen is the worst UX in the platform today. **Note:** the app currently uses `<BrowserRouter>` + `<Routes>` (component router). React Router's data-router `errorElement` is not available; migrating to `createBrowserRouter` is a separate decision (see §8). |
| 15 | **Error boundary at the route level**, not the app root. Catches render-time errors, classifies as `class: 'render'`, shows a minimal fallback with reload + report. Sentry-style report dialog gated to power users (settings flag). | App-root boundaries lose all context. Per-route boundaries let other regions stay alive. |
| 16 | **Realtime / sync drops are status-bar UI, not toasts.** A subtle dot in the app shell shows connection state; only escalate to a banner if disconnected >30s; only toast if unrecoverable. | Realtime flaps. Toasting every flap is hostile. |
| 17 | **Rate-limit errors carry `retryAfter` seconds** and the renderer shows a live countdown ("Try in 47s"). 429s without `retryAfter` are a server bug. | "Too many requests" with no countdown is information-free. |
| 18 | **Stale / version conflicts ship with `serverVersion` and `clientVersion` in the body.** Renderer surfaces "Someone else just changed this" with `[Use theirs] [Keep mine] [Show diff]` — actual conflict resolution, not a generic "Reload". | Linear / Notion / Figma all do this. It's a tier-1 differentiator for a multi-user product. |
| 19 | **TraceId infrastructure is greenfield in this codebase and ships as part of Wave 0.** Today there is no request-id middleware, `req.id` is not populated (NestJS/Express don't set it), and structured logs do not carry a traceId. Wave 0 builds: (a) a request-id Nest middleware (`req.id = req.headers['x-request-id'] ?? newUlid()`), (b) `X-Request-Id` response header, (c) traceId injection into the existing logger (no new logging *system*; minimal changes to the existing Logger to include traceId on every log line), (d) traceId propagation into `ApiError` from the response header. **Out of scope:** Sentry / external log aggregator / centralized observability platform — those remain a separate decision. | Resist scope creep on observability tooling, but be honest that the traceId glue this spec relies on is new code, not "already exists." |
| 20 | **Ship behind a feature flag for the renderer**, not the filter. The filter normalises silently; the new toast/page renderers can be toggled per surface during rollout to validate they aren't more noisy than the old behaviour. | Filter is server-side and harmless to turn on. UX changes need supervised rollout. |

## 3 · Architecture

### 3.1 Wire shape — RFC 9457

Every non-2xx response from the API has the same body, regardless of route, framework feature, or error origin:

```jsonc
{
  "type": "https://errors.prequest.app/ticket.title_required",  // RFC 9457; opaque URN, not a real fetch
  "code": "ticket.title_required",                              // STABLE machine-readable code; never changes
  "title": "Couldn't create ticket",                            // human outcome, optional override per locale
  "detail": "Title is required.",                               // one-line explanation
  "status": 422,                                                // numeric HTTP status
  "fields": [                                                   // present iff this is a validation error
    { "field": "title", "code": "required", "message": "Title is required" },
    { "field": "priority", "code": "invalid_enum", "message": "Pick low, normal, high or urgent" }
  ],
  "traceId": "req_01HW8X2P9F8Y3MNX5TQK3JC0RV",                  // ALWAYS present
  "docsUrl": "https://docs.prequest.app/errors/ticket.title_required",  // optional, surfaced when present
  "retryAfter": 47,                                             // present on 429 only; seconds
  "serverVersion": "v23",                                       // present on 409 version conflicts
  "clientVersion": "v22"                                        // present on 409 version conflicts
}
```

`code` is the contract surface. Once shipped, codes never change semantics — only new codes are added. Codes are dot-namespaced by domain (`ticket.*`, `permission.*`, `routing.*`, `db.*`, `email.*`, `auth.*`, `quota.*`, `network.*`).

### 3.2 Server: `AppError` + global filter

```ts
// apps/api/src/common/errors/app-error.ts
export class AppError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    opts?: {
      detail?: string;
      fields?: Array<{ field: string; code: string; message: string }>;
      cause?: unknown;
      docsUrl?: string;
      retryAfter?: number;
      serverVersion?: string;
      clientVersion?: string;
    },
  ) {
    super(opts?.detail ?? code);
    this.name = 'AppError';
    Object.assign(this, opts ?? {});
  }
}

// Common factories — short, opinionated, the only sanctioned way to throw new errors.
export const AppErrors = {
  notFound: (entity: string, id?: string) =>
    new AppError(`${entity}.not_found`, 404, { detail: id ? `${entity} ${id} not found` : `${entity} not found` }),
  permissionDenied: (permission: string) =>
    new AppError('permission.denied', 403, { detail: `Missing permission: ${permission}` }),
  validation: (fields: AppError['fields']) =>
    new AppError('validation.failed', 422, { fields }),
  conflict: (code: string, opts?: { serverVersion?: string; clientVersion?: string }) =>
    new AppError(code, 409, opts),
  rateLimited: (retryAfter: number) =>
    new AppError('rate_limit.exceeded', 429, { retryAfter }),
  // ... and ~10 more
};
```

```ts
// apps/api/src/common/filters/all-exceptions.filter.ts
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse();
    const req = ctx.getRequest();
    const traceId = req.id ?? randomTraceId();

    const normalized = normalize(error, traceId);  // pure function, well-tested

    // Always log with traceId; status decides log level.
    this.logger.log({ level: normalized.status >= 500 ? 'error' : 'info', traceId, error });

    res.status(normalized.status).json(normalized.body);
  }
}

// normalize() handles, in order:
//   AppError          → straight passthrough
//   HttpException     → map status → code; pull message into detail
//   ZodError          → 422 + fields[]
//   class-validator   → 422 + fields[]
//   PostgrestError    → 4xx/5xx based on code; map RLS denial → permission.denied
//   pg native error   → 'db.constraint' / 'db.unique_violation' / 'db.fk_violation'; never leak SQL
//   AbortError        → 'request.cancelled' (don't log)
//   anything else     → 'unknown.server_error', 500, log full stack
```

`normalize()` is the **only** place errors become wire-shaped. Lives behind 100% unit-test coverage. Adding a new server error class = adding one branch + tests.

### 3.3 Client: `ApiError` extension + `classify()`

`ApiError` already carries `status` + `body` + `isNetworkError`. Add typed accessors that read the new wire shape:

```ts
// apps/web/src/lib/api.ts (additions)
export class ApiError extends Error {
  // existing fields ...
  get code(): string | undefined { return readBodyField(this.body, 'code'); }
  get traceId(): string | undefined { return readBodyField(this.body, 'traceId'); }
  get fields(): Array<{ field: string; code: string; message: string }> | undefined { ... }
  get retryAfter(): number | undefined { ... }
  get serverVersion(): string | undefined { ... }
  get clientVersion(): string | undefined { ... }
  get docsUrl(): string | undefined { ... }
}
```

```ts
// apps/web/src/lib/errors/classify.ts
export type ErrorClass =
  | 'transport'        // offline, DNS, timeout, fetch fail
  | 'auth'             // 401, JWT expired
  | 'permission'       // 403, role lacks permission, RLS hide
  | 'not_found'        // 404, deleted-while-watching
  | 'gone'             // 410, soft-deleted, revoked
  | 'validation'       // 422 with fields[]
  | 'conflict'         // 409, version conflict
  | 'rate_limit'       // 429
  | 'server'           // 5xx (other than known third-party degradation)
  | 'realtime'         // websocket / SSE drop, distinct from transport
  | 'render'           // ErrorBoundary catch
  | 'unknown';         // last resort; landing here is a classifier bug

export type Recovery =
  | { kind: 'retry'; run: () => void }
  | { kind: 'signIn'; next: string }
  | { kind: 'reload' }
  | { kind: 'goBack' }
  | { kind: 'pickAlternative'; alternatives: unknown[] }
  | { kind: 'askAdmin'; permission?: string; admins?: Array<{ id: string; name: string }> }
  | { kind: 'contactSupport'; traceId: string }
  | { kind: 'dismiss' };

export interface ClassifiedError {
  class: ErrorClass;
  code: string;                          // 'permission.denied', 'transport.offline', etc
  title?: string;                        // server-supplied override; usually unused, lookup wins
  detail?: string;                       // server-supplied; usually fallback only
  fields?: Array<{ field: string; code: string; message: string }>;
  traceId?: string;
  docsUrl?: string;
  retryAfter?: number;                   // rate_limit
  serverVersion?: string;                // conflict
  clientVersion?: string;                // conflict
  recoveries: Recovery[];                // ordered: most-likely-helpful first
  raw: unknown;                          // original, for logging
}

export function classify(error: unknown, ctx?: ClassifyContext): ClassifiedError;
```

`classify()` is pure. It looks at the error, the route it came from (passed via `ctx`), the user's permissions (passed via `ctx`), and produces a `ClassifiedError` with **at least one** recovery. If it would produce zero, that's a bug — caught by tests on the `recoveries[].length >= 1` invariant.

### 3.4 Renderers — surface chosen by class

```ts
// apps/web/src/lib/errors/renderer.tsx

type Surface = 'toast' | 'inline' | 'page' | 'banner' | 'modal' | 'silent';

const SURFACE_BY_CLASS: Record<ErrorClass, Surface> = {
  transport:  'banner',     // offline pill in app shell
  auth:       'silent',     // redirect handler claims it before render
  permission: 'inline',     // page-level if route, toast if action
  not_found:  'page',       // route errorElement
  gone:       'page',
  validation: 'inline',     // FieldError per field; never toast
  conflict:   'modal',      // 'Use theirs / Keep mine'
  rate_limit: 'toast',      // with countdown
  server:     'toast',      // with traceId + report dialog
  realtime:   'banner',     // status pill, escalates to banner
  render:     'page',       // ErrorBoundary
  unknown:    'toast',
};

// One entry point. Hook for mutations and queries call this.
export function renderError(classified: ClassifiedError, context: RenderContext): void;

// React-side state + UI primitives:
export function ErrorBanner(): JSX.Element;             // mounts in app shell, listens to transport/realtime store
export class RouteErrorBoundary extends React.Component  // class component (componentDidCatch); wraps each top-level route
                                  <Props, State> { ... } // exposes a context: { throwToBoundary(error) } so query/mutation hooks
                                                         // can promote a page-class error (not_found / forbidden / gone)
                                                         // to the same boundary that catches render errors.
export function ConflictModal(props): JSX.Element;      // 'Use theirs / Keep mine / Show diff'
export function RateLimitToast(props): JSX.Element;     // live countdown via useNow
```

Why a class component, not data-router `errorElement`: the app uses `<BrowserRouter>` + `<Routes>` (`apps/web/src/main.tsx:13-21`). `errorElement` requires `createBrowserRouter` + `RouterProvider`. Migrating the route tree (131 `<Route>` declarations across `App.tsx` + nested layouts) is a multi-day refactor outside this spec. Class boundaries handle the same use case with less ceremony and don't block this work; if/when a future decision migrates to a data router, the boundary becomes a thin wrapper around `errorElement`.

### 3.5 Hook integration — the only API call sites should learn

```ts
// apps/web/src/lib/errors/use-mutation-with-errors.ts
export function useMutationWithErrors<TData, TVars>(
  options: UseMutationOptions<TData, ApiError, TVars> & {
    /** Title for action-class toasts. Required if onError isn't provided. */
    actionTitle?: string;
    /** RHF setError, if this mutation backs a form. Field errors flow here. */
    setFormError?: (field: string, error: { type: string; message: string }) => void;
  },
): UseMutationResult<TData, ApiError, TVars>;
```

That's the single new API surface. Hand-rolling `onError` is no longer needed for 95% of cases. The hook:

1. Classifies the thrown `ApiError`.
2. If validation + `setFormError` provided → routes fields, optionally suppresses toast.
3. If conflict → opens `ConflictModal` with the body's `serverVersion`/`clientVersion`.
4. If retry-able server error → toast with `Retry` action wired to mutation re-run.
5. If anything else → renders to the surface for that class.
6. Logs the full classified error with traceId.

A matching `useQueryWithErrors` exists for read paths; mostly thinner because read errors usually surface as page state, not toast.

## 4 · The error class × surface × recovery matrix

This is the contract. Every classifier branch lands one row.

| Class | Default surface | Default recovery (in order) | Notes |
|---|---|---|---|
| `transport` (offline / DNS / timeout) | Banner pill in app shell | `retry` (auto-retry on reconnect) · `dismiss` | React Query `onlineManager` triggers refetch on reconnect. No toast; banner says it. |
| `auth` (401 expired) | Silent → redirect to sign-in | `signIn` (carries `next=` to current URL with form draft preserved) | Toast is wrong here. Just navigate. AuthProvider already partly handles this. |
| `permission` (403) | Page if route-level; toast if action-level | `askAdmin` (with admin names if known) · `goBack` | Inline page state for navigation; toast for 'Save failed: missing permission' |
| `not_found` (404) | Page replacement via `RouteErrorBoundary` | `goBack` · `reload` | Renders 'This was removed' page-level; never toast over a stale page. Hook calls `throwToBoundary()` to promote a query/mutation 404 into the same boundary that catches render errors. |
| `gone` (410) | Page replacement via `RouteErrorBoundary` | `goBack` | Distinguished from 404 — entity existed, was removed. Different copy. |
| `validation` (422) | Inline `<FieldError>` | (no toast; field errors are the recovery) | Submit button disabled until form is valid. |
| `conflict` (409) | Modal | `pickAlternative` (use theirs/keep mine/show diff) · `reload` | Tier-1 multi-user differentiator. |
| `rate_limit` (429) | Toast with live countdown | `retry` (auto, when timer expires) · `dismiss` | If `retryAfter` missing, that's a server bug — log it. |
| `server` (5xx) | Toast | `retry` · `contactSupport` (with traceId pre-filled) | TraceId is small text in toast, click to copy. |
| `realtime` (ws drop) | Status-bar dot → banner if >30s | `retry` (auto-reconnect with backoff) | Distinct from `transport` because realtime can drop while HTTP works. |
| `render` (caught by `RouteErrorBoundary`) | Per-route fallback page | `reload` · `goBack` · `contactSupport` | App keeps running, only the broken route is replaced. Same boundary that handles `not_found`/`gone`/`forbidden`-as-page. |
| `unknown` | Toast | `retry` · `contactSupport` | Landing here is a classifier bug. Add a class branch. |

## 5 · Code taxonomy — the registry

Codes are domain-namespaced. Every code is registered in `apps/web/src/lib/errors/messages.<locale>.ts` and the server's `apps/api/src/common/errors/codes.ts`. The two are **not** a single shared file — server owns the wire, client owns the message.

Initial code set (not exhaustive — extend as the migration ships):

```
auth.expired
auth.invalid
permission.denied
permission.missing_role

ticket.not_found
ticket.title_required
ticket.assignment_invalid
ticket.routing_no_match

booking.conflict
booking.window_closed
booking.capacity_exceeded
booking.permission_denied

reservation.version_conflict
order.line_invalid

routing.no_match
routing.cycle_detected
sla.policy_invalid

vendor.unavailable
vendor.not_in_scope

email.dispatch_failed         (maps Resend errors; vendor name never leaks)
realtime.unavailable          (maps Supabase realtime errors)
db.constraint                 (maps pg / PostgREST; never leaks SQL)
db.unique_violation
db.fk_violation
db.deadlock

quota.exceeded
rate_limit.exceeded
request.too_large
request.cancelled

network.offline
network.timeout

generic.bad_request           (legacy bucket while migrating)
unknown.server_error
```

Adding a new code to the server without registering a client message is allowed — `classify()` falls back to `detail` from the body. CI lint checks coverage and warns on unregistered codes seen in production logs.

## 6 · Operational design beats

### 6.1 TraceId propagation

**This is greenfield infrastructure** — see decision #19. Today the API has no request-id middleware, `req.id` is unset, and the logger does not include a traceId on log lines. Wave 0 ships all of the below:

- **New** Nest middleware (`apps/api/src/common/middleware/request-id.middleware.ts`): reads `X-Request-Id` from inbound headers, falls back to a generated `req_<ulid>`, assigns to `req.id`, and sets `X-Request-Id` on the response. Registered globally before any route handlers run.
- **Existing logger gets enrichment**: extend the Nest `Logger` adapter so every log line emitted during a request automatically includes `traceId` from `req.id` via AsyncLocalStorage (the same ALS the tenant middleware already uses — see `apps/api/src/common/middleware/tenant.middleware.ts`). No new logging system, no log shipper.
- `AllExceptionsFilter` injects `traceId` into the response body's `traceId` field.
- `apiFetch` reads `X-Request-Id` from every response (success or error) and stamps it on `ApiError.traceId`.
- Toast helper for server-class errors renders traceId as small monospace text below the description with a copy-on-click.
- The contact-support recovery pre-fills the support form with the traceId.

### 6.2 Form drafts survive auth redirects

If a mutation fails with `auth.expired`, before redirecting:
1. Serialise the current form state (RHF `getValues()`) into `sessionStorage` keyed by route + form id.
2. Redirect to sign-in with `?next=<current_url>`.
3. After sign-in, the form's `useEffect` rehydrates from `sessionStorage` and clears the key.

This is one of the biggest "I love this app" details in Linear / Stripe — never lose the user's typing.

### 6.3 Stale conflict resolution

When a mutation hits `409 conflict` with `serverVersion` + `clientVersion`:
1. Renderer fetches the server's current state via the same query.
2. Modal shows three actions:
   - **Use theirs** — overwrite local with server, discard local edits.
   - **Keep mine** — re-issue the mutation with `If-Match: <new serverVersion>` (forced).
   - **Show diff** — side-by-side field-level diff for non-trivial conflicts.
3. The mutation hook handles all three without the call site knowing.

### 6.4 Optimistic rollback animation

`useMutationWithErrors` extends React Query's `onError` rollback path:
1. Restore previous state via the user-supplied `rollback`.
2. If `setFormError` not provided and class is server/conflict/permission → toast: "We undid your change — <message>".
3. Toast duration = 6s; includes `Retry`.

### 6.5 Internationalization

`messages.nl.ts` ships in v1 alongside `messages.en.ts`. Codes that don't exist in the active locale fall back to English, then to the server `detail`, then to a generic `"Something went wrong"`. Untranslated codes show up in dev console; CI fails if any code in `codes.ts` is missing from `messages.en.ts`.

## 7 · Migration plan

This is incremental. Nothing breaks on day one.

**Wave 0 — Foundation (no UX change yet)** — ~5 days
- Ship request-id middleware (`apps/api/src/common/middleware/request-id.middleware.ts`): reads `X-Request-Id` from inbound, generates ULID-prefixed `req_<ulid>` if missing, attaches to `req.id`, sets response header.
- Ship logger enrichment so every log line includes `traceId` (extend the existing Nest `Logger` adapter; no new logging system).
- Ship `AllExceptionsFilter` server-side with `normalize()` covering AppError / HttpException / ZodError / Postgrest / pg-native / AbortError / unknown.
- Ship `AppError` + factory module + ESLint guard against bare `throw new Error(...)` outside the factory.
- Ship `ApiError` client extensions (typed accessors for `code`, `traceId`, `fields`, etc.) + read `X-Request-Id` from every response.
- **Visible result:** every error now has a traceId in the body and in server logs. Nothing else changes user-visibly.

**Wave 1 — Classifier + 3 surfaces** — ~3 days
- Ship `classify()` + `ClassifiedError` types + tests.
- Ship `useMutationWithErrors` + `useQueryWithErrors`.
- Ship 3 renderers: toast, inline (FieldError integration), banner.
- Migrate the 5 highest-traffic mutations behind a feature flag.
- **Visible result:** validation errors paint inline; offline shows a banner; toasts for everything else look mostly the same but now have traceId.

**Wave 2 — Page-level surfaces** — ~3 days
- Ship `RouteErrorBoundary` (class component) + `throwToBoundary` context bridge.
- Wrap each top-level route element with the boundary (single edit per route in `App.tsx`).
- Ship 404 / 403 / 410 / 5xx page templates.
- Ship `ConflictModal`.
- Migrate top-traffic queries to call `throwToBoundary()` for page-class errors.
- **Visible result:** broken pages now show real page state instead of stale content + toast.

**Wave 2 explicitly does NOT migrate the route tree to a data router.** That migration (`createBrowserRouter` + loaders/actions) is a separate decision; it's a multi-day refactor across 131+ routes and is out of scope here.

**Wave 3 — Recovery polish** — ~3 days
- Sign-in `next=` redirect with form-draft preservation.
- Rate-limit live countdown.
- Optimistic-rollback animation + explanation.
- Realtime status indicator.
- Render-error boundary per route.
- **Visible result:** every error has an actionable next step; the platform feels "smart" when things go wrong.

**Wave 4 — Backfill + Dutch** — ~2 days, can run in parallel with Wave 3
- Migrate the next 30 highest-traffic throw sites to coded `AppError`.
- Ship `messages.nl.ts` for the registered code set.
- Add CI lint that warns on unregistered codes seen in production.
- Document the spec under `docs/error-handling.md` (operational ref, like `docs/visibility.md`).

**Total: ~13 working days** for one engineer. Worth noting: Waves 0+1 alone (~6 days) eliminate ~80% of the user-visible badness. The rest is polish.

## 8 · Out of scope

| Topic | Why out | Where it goes |
|---|---|---|
| Sentry / observability platform | Spec doesn't touch the log pipeline; only requires traceId | Separate infra slice |
| Telemetry on which recoveries users actually pick | Build it, then measure | Phase 2 of the rollout |
| Self-serve `docsUrl` content | Need actual docs site; orthogonal | Documentation site project |
| Per-tenant error message overrides | Niche; YAGNI for v1 | Future spec if customer demand appears |
| Localisation beyond `en` + `nl` | Market-driven | Add per locale as markets open |
| Audit-log integration ("user saw error X") | Not actionable enough to justify storage | Maybe later if support uses it |
| AI-suggested recoveries ("looks like you meant X") | Too speculative; ship the deterministic version first | Long-tail UX investigation |
| Adapting non-API errors (drag-and-drop fail, file pick fail) | Same classifier handles them via the `unknown` branch initially; specialise later | Add `client.*` codes as they arise |

## 9 · Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Renderer routing produces *more* noise (e.g. transport banner flickers on every flap) | High | Hysteresis: don't show banner until error persists 2s+; clear after 2s of recovery. Manually QA the offline banner under flapping wifi. |
| Migrating throw sites takes longer than budgeted because every domain has its own error vocabulary | Medium | Don't migrate all at once. Filter handles legacy `BadRequestException(string)` cleanly via `generic.bad_request`. Migrate by traffic. |
| Conflict modal too disruptive for low-stakes edits | Medium | Allow mutation hook to opt out (`onConflict: 'silent_revert'`) for fields where overwrite is fine (e.g. presence indicators). |
| 'Sign in and restore form' behaviour breaks if form serialisation lossy (file inputs, etc.) | Medium | Document scope: text/select/checkbox/radio/textarea fields restore; file inputs warn the user and ask to re-attach. |
| Server `code` strings drift over time, breaking the client lookup contract | High if not enforced | CI: snapshot test that flags any change to existing codes. Adding new codes is fine; removing/renaming requires explicit acknowledgment. |
| Codes leak internal vocabulary (e.g. `routing.no_match` confuses non-engineers) | Medium | Codes are *not* user-facing. Messages are. Keep code names internal-friendly; messages are designed copy. |
| Engineers throw `new Error('something')` and skip `AppError` | High | ESLint rule: `no-restricted-syntax` flags `throw new Error(...)` outside the AppError factory module. Provide ergonomic factories so AppError is easier than Error. |
| Filter normalises a sensitive error (e.g. JWT secret in stack) into the response | Low if reviewed; catastrophic if missed | Filter strips `cause` from response body (kept in logs only). Test for it. |

## 10 · Open questions

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Do we want a dedicated `docs.prequest.app/errors/<code>` site, or just inline help text? | Inline help only for v1; build docs site if support volume justifies it. |
| 2 | Should `traceId` be visible to all users or only operators? | All users. The copy-on-click chip is small; doesn't add noise; hugely speeds support. |
| 3 | When a 5xx happens, do we surface a 'Report this' dialog (Sentry-style) or just a toast? | Toast for v1; report dialog is a polish item later. |
| 4 | Conflict modal: do we render a real field-level diff, or just 'their values vs your values'? | Side-by-side per-field for v1. Real merge UI is overkill. |
| 5 | How aggressive is auto-retry on transport errors? | React Query default (2 retries with backoff); banner shows attempt count. |
| 6 | Do we ship `messages.nl.ts` in v1 or punt to v2? | Ship in v1 — Benelux-primary market, doing this once is cheaper than twice. |
| 7 | Do we audit-log every user-facing error event? | No. Too noisy. Audit-log only the underlying domain events (failed mutation = the existing audit; the user's visual error = client log only). |
| 8 | Form-draft preservation on auth-redirect — `sessionStorage` or in-memory? | `sessionStorage` so it survives the actual sign-in redirect (which is a full page nav). Cleared on rehydrate. |

## 11 · Success criteria

The spec is shipped when:

- Every error response from the API has the wire shape (verified by an integration test that hits 30+ endpoints and asserts shape).
- Every `useMutation` in the codebase uses `useMutationWithErrors` (verified by an ESLint rule).
- 95% of errors classify into a class other than `unknown` (measured via client-side log sampling for 1 week).
- A manual QA pass exercises one error from each of the 11 classes and verifies the correct surface + recovery.
- TraceId is present on every server log line, every error response, and every user-visible error UI.
- A support engineer can resolve a "something broke" ticket in <2 minutes given only a traceId and the URL the user was on.
- `messages.nl.ts` covers 100% of registered codes; lint passes.
- The codex review of the implementation finds zero "vendor name leaks" and zero "stack trace in response body" issues.

When all eight hold, we have an error system that's better than every product in the FMIS market and competitive with the best products outside it.
