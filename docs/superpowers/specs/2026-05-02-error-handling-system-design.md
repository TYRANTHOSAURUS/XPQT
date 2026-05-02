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
| 1 | The wire shape is **RFC 9457-inspired** (`code`, `title`, `detail`, `status`, `fields[]`, `traceId`, plus app-specific extensions for `retryAfter`, version-conflict, bulk results). The literal `type` URI from the RFC is **not** included — nobody consumes it; Stripe / Linear / Vercel ship variants without it; including it implies a phantom dependency on a docs site at `errors.prequest.app/<code>` that doesn't exist. | The contract surface that matters is `code`. The RFC's `type` URI duplicates what `code` already conveys, costs bytes, and signals a docs site we haven't built. |
| 2 | Every error response carries `code` (stable, machine-readable) + `title` (human outcome) + `detail` (one-line explanation) + optional `fields[]` + always a `traceId`. | Code is the join key for client message lookup + recovery. TraceId is non-negotiable — support uses it. |
| 3 | A **single global Nest `AllExceptionsFilter`** normalises every thrown thing — `HttpException`, `ZodError`, raw `pg` errors, `PostgrestError`, unknown errors — into the wire shape. Migrating call sites is incremental; the filter handles legacy `BadRequestException(string)` cleanly. **Note:** the repo uses Zod for runtime validation (manually called per controller via `safeParse`); `class-validator` is not installed and there is no `ValidationPipe`. The filter has no `class-validator` branch. | One file, every endpoint benefits day one. Migrate throw sites by traffic, not all-at-once. |
| 4 | An **`AppError` class** (server) with `code`, `status`, `fields?`, `cause?`, `docsUrl?`. New throw sites use it. Legacy `BadRequestException(string)` is mapped by the filter to `code: 'generic.bad_request'` until migrated. | Coded errors at the source preserve intent; string errors stay supported during migration. |
| 5 | A **client-side `classify()` function** turns any thrown thing (`ApiError`, `Error`, fetch failure, abort) into a `ClassifiedError` with `class` + `code` + `fields?` + `traceId?` + `recovery`. **Classification happens once, at the boundary.** Renderers read the classified shape. | Decouples "what went wrong" from "how it shows up". Without this layer every renderer re-derives the same state. |
| 6 | **10 error classes**, each mapped to a default surface and recovery. (Matrix in §4.) Classes are exhaustive — every error must classify into exactly one. `unknown` exists as a last-resort bucket for renderer correctness, but landing there is a bug to fix at the classifier. **`gone` (410) is collapsed into `not_found` with `reason: 'removed'`** because no endpoint in the API throws 410 today and surfacing it requires a separate server-side discipline (soft-delete-aware endpoints) outside this spec's scope. The `not_found` page template branches on `reason` to show different copy ("Removed" vs "Doesn't exist"); the wire shape supports the distinction without a separate class. | A taxonomy with a default-OK case isn't a taxonomy. Forcing exhaustiveness drives classifier completeness. Don't ship a class without server-side support — it'd just be dead code. |
| 7 | The **surface for an error is decided by `(class, call-site-kind)`** — most classes pin a single surface, but two need the call-site to disambiguate: (a) `permission` is a page when the failing thing was a route load, a toast when it was an action; (b) `not_found` is a page when route-load, a toast when an action references a no-longer-existing entity ("Couldn't add — webhook was deleted"). Toasts are right ~30% of the time; transport errors get a banner, page-level errors replace the page, field errors paint inline. Renderers expose `handle(error, context)` where `context.callSite ∈ ('route_load','mutation','realtime','render')` lets the renderer pick correctly. | Right now every error is a toast. That's why the app feels noisy and useless when things go wrong. The class-only-decides claim was a simplification — make the dispatch contract honest so call sites pass `callSite` deliberately rather than guessing. |
| 8 | **Every error has a recovery.** If the design can't name one, the class is wrong. Recovery options are typed: `retry` · `signIn` · `reload` · `goBack` · `pickAlternative` · `askAdmin` · `contactSupport` · `dismiss`. | "Try again" is the floor, not the ceiling. The button labels are the UX. |
| 9 | **Messages are looked up client-side by `code`. Unregistered codes fail closed — never display the server's `detail` verbatim.** A code that's not in `messages.<locale>.ts` renders as `unknown.server_error` copy + traceId, not as the server's English prose. The code registry lives in a shared workspace package (`packages/shared/error-codes`) so server enum + client message coverage stay in sync; CI fails on drift. | Localisation, ability to rewrite a confusing message without a deploy. **Fail-closed is the security control:** if a server message accidentally embeds a vendor name, SQL fragment, or stack frame, the client never displays it because the code-message lookup is the only path to user-visible copy. The detail field stays in the response (for support / dev tools) but is not rendered. |
| 10 | **TraceId everywhere.** Generate at request boundary (`X-Request-Id`), echo in every error response and every server log line, surface subtly on every user-visible error (copy-on-click). Frontend captures it on every `ApiError`. | Highest-leverage single change. Support resolution drops from 30 min to 30 sec. |
| 11 | **Field-level errors never toast.** When `fields[]` is present, the form's mutation hook stuffs them into RHF state and the toast either suppresses or becomes a generic "Some fields need attention." | The current setup turns Zod errors (via `formatZodError`) into a single comma-joined string — unusable as toast text and impossible to map to specific form fields. |
| 12 | **Optimistic-update rollback is animated and explained.** The `useMutation` `onError` rollback path adds a one-line toast "We undid that change because: <reason from code>". Silent reverts are banned. | Most apps fail here; it's a high-leverage polish moment. |
| 13 | **No vendor names leak to users.** Resend / Supabase / Stripe / Postgres errors are mapped to neutral codes (`email.dispatch_failed`, `realtime.unavailable`, `payment.failed`, `db.constraint`). Internal logs keep the original. | Both branding (don't ship "Resend down") and security (don't leak stack info). |
| 14 | **Page-level errors replace the page**, not toast over a now-broken page. Implemented via per-route React class `ErrorBoundary` components wrapping each top-level route element (`<Route element={<ErrorBoundary><DeskPage/></ErrorBoundary>}>`). The boundary catches both render errors *and* errors thrown into a `throwToBoundary()` ref by query/mutation hooks for page-level classes (`not_found`, `forbidden`, generic 500). Renders forbidden / not-found (with `reason` branch for "removed" copy) / offline / generic 500 states. | Toasting "Not found" while leaving a broken detail page on screen is the worst UX in the platform today. **Note:** the app currently uses `<BrowserRouter>` + `<Routes>` (component router). React Router's data-router `errorElement` is not available; migrating to `createBrowserRouter` is a separate decision (see §8). |
| 15 | **Error boundary at the route level**, not the app root. Catches render-time errors, classifies as `class: 'render'`, shows a minimal fallback with reload + report. **No "report dialog" in v1** — the fallback page shows the error code + traceId, a Reload action, and a "Contact support" link that mailto's a pre-filled support address with the traceId. The Sentry-style modal-with-comment dialog is deferred to v2 once we have data on whether it actually helps; "power users" was an undefined audience. | App-root boundaries lose all context. Per-route boundaries let other regions stay alive. The cheapest report path (mailto + traceId) is good enough for v1 and avoids designing/maintaining a dialog UI before we know it's used. |
| 16 | **Realtime / sync drops are status-bar UI, not toasts.** A subtle dot in the app shell shows connection state; only escalate to a banner if disconnected >30s; only toast if unrecoverable. **This requires new infrastructure** — a `RealtimeStatusStore` (Zustand or context+reducer) that aggregates the state of every active Supabase channel. Today the three live realtime call sites (`use-realtime-bundle`, `use-realtime-scheduler`, `use-realtime-availability`) each manage their own `.channel().subscribe()` with no shared status. Wave 3 builds the store, exposes a `useRealtimeStatus()` hook, and migrates the three hooks to register/unregister channels with the store. The status-bar dot reads aggregate `'connecting' \| 'open' \| 'reconnecting' \| 'broken'`. | Realtime flaps. Toasting every flap is hostile. Aggregate-status is the prerequisite for the dot — name it explicitly. |
| 17 | **Rate-limit errors carry `retryAfter` seconds** and the renderer shows a live countdown ("Try in 47s"). 429s without `retryAfter` are a server bug. | "Too many requests" with no countdown is information-free. |
| 18 | **Stale / version conflicts ship with `serverVersion` and `clientVersion` in the body** so a future modal has the data it needs. **v1 surface is a toast** ("This was changed by someone else — Reload"); the Use-theirs/Keep-mine/Show-diff modal is **deferred to v2**. | XPQT is a workflow tool, not a real-time collaborative document. The surfaces with genuine concurrent-edit pressure (workflow definitions, routing rules) are narrow and admin-only. Shipping the modal as tier-1 is gold-plating; ship the wire fields now and revisit the modal when a real surface demands it. |
| 19 | **TraceId infrastructure is greenfield in this codebase and ships as part of Wave 0.** Today there is no request-id middleware, `req.id` is not populated (NestJS/Express don't set it), and structured logs do not carry a traceId. Wave 0 builds: (a) a request-id Nest middleware (`req.id = req.headers['x-request-id'] ?? newUlid()`), (b) `X-Request-Id` response header, (c) traceId injection into the existing logger (no new logging *system*; minimal changes to the existing Logger to include traceId on every log line), (d) traceId propagation into `ApiError` from the response header. **Out of scope:** Sentry / external log aggregator / centralized observability platform — those remain a separate decision. | Resist scope creep on observability tooling, but be honest that the traceId glue this spec relies on is new code, not "already exists." |
| 20 | **Ship behind a feature flag for the renderer**, not the filter. The filter normalises silently; the new toast/page renderers can be toggled per surface during rollout to validate they aren't more noisy than the old behaviour. | Filter is server-side and harmless to turn on. UX changes need supervised rollout. |

## 3 · Architecture

### 3.1 Wire shape — RFC 9457-inspired

Every non-2xx response from the API has the same body, regardless of route, framework feature, or error origin:

```jsonc
{
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
  "clientVersion": "v22",                                       // present on 409 version conflicts
  "results": [                                                  // present iff this was a bulk operation
    { "id": "abc", "status": "ok" },
    { "id": "def", "status": "ok" },
    { "id": "ghi", "status": "error", "code": "ticket.routing_no_match", "detail": "No matching team" }
  ],
  "partialSuccess": true                                        // present iff at least one bulk item succeeded AND at least one failed
}
```

`code` is the contract surface. Once shipped, codes never change semantics — only new codes are added. Codes are dot-namespaced by domain (`ticket.*`, `permission.*`, `routing.*`, `db.*`, `email.*`, `auth.*`, `quota.*`, `network.*`).

**Bulk operations:** any endpoint that accepts a batch of items (delete-many, update-many, dispatch-many, etc.) returns the same wire shape with `results[]` + `partialSuccess`. The HTTP status is the worst-case outcome (any failed → 207 Multi-Status; all failed → 4xx/5xx; all ok → 2xx with `results[]` for confirmation). The renderer surfaces partial-success as a toast: `"7 of 10 deleted — 3 failed [Show me]"` where Show-me opens a sheet listing the failed items with per-item code lookup. **Adding bulk semantics is not optional and not deferrable** — once a non-bulk endpoint exists, evolving it to a bulk shape would be a breaking change to the wire contract that decision #1 forbids.

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
//   ZodError          → 422 + fields[] (see "Zod migration" below — non-trivial)
//   PostgrestError    → 4xx/5xx based on code; map RLS denial → permission.denied
//   pg native error   → 'db.constraint' / 'db.unique_violation' / 'db.fk_violation'; never leak SQL
//   AbortError        → 'request.cancelled' (don't log)
//   anything else     → 'unknown.server_error', 500, log full stack
```

`normalize()` is the **only** place errors become wire-shaped. Lives behind 100% unit-test coverage. Adding a new server error class = adding one branch + tests.

**Zod migration** — the repo uses Zod manually via `safeParse` + a helper called `formatZodError` that returns a **single comma-joined string** (e.g. `"title: Required, priority: Invalid enum value"`). For the filter to produce structured `fields[]` output, every controller's Zod-handling site needs to switch from "join into a string" to "pass the raw `ZodError` up so the filter formats it." Plan:

1. Add a `throwZodError(result: SafeParseError)` helper that throws an `AppError` with `code: 'validation.failed'`, `status: 422`, and `fields[]` derived from `result.error.issues` (mapping `path` → `field`, `code` → field code, `message` → message).
2. Update `formatZodError` to be a thin wrapper that calls `throwZodError`.
3. Migrate call sites — they're already in a uniform shape, so this is a 1-line replacement per site.
4. The filter's `ZodError` branch is then a fallback for any uncaught `ZodError` that escapes (via library code).

This is a real piece of work — call it out in Wave 0 rather than burying it.

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
  | 'not_found'        // 404 + 410 (page-template branches on body.reason: 'missing' | 'removed')
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

### 3.4 Renderers — surface chosen by `(class, callSite)`

**The renderer composes with the existing toast helpers in `apps/web/src/lib/toast.ts` — it does not replace them.** When a classified error needs a toast, the renderer calls `toastError(title, { error, retry })` from the existing module so the voice rule ("Couldn't <verb> <thing>"), Retry/View/Undo conventions, and styling stay consistent across the app. Two toast systems would drift; one is mandatory.

Concretely: `renderError(classified, ctx)` derives `title` from the code-message lookup (§5), then calls `toastError(title, { description: classified.detail, retry: ctx.retry })`. The `actionTitle` parameter the call site passes to `handleMutationError` (§3.5) is what becomes the toast title — and the call site is responsible for writing it in the existing voice ("Couldn't save webhook" not "Save webhook").


```ts
// apps/web/src/lib/errors/renderer.tsx

type Surface = 'toast' | 'inline' | 'page' | 'banner' | 'modal' | 'silent';
type CallSite = 'route_load' | 'mutation' | 'realtime' | 'render';

// Surface = f(class, callSite). Most rows ignore callSite; two need it.
function surfaceFor(cls: ErrorClass, callSite: CallSite): Surface {
  switch (cls) {
    case 'transport':  return 'banner';                                            // offline pill in app shell
    case 'auth':       return 'silent';                                            // redirect handler claims it before render
    case 'permission': return callSite === 'route_load' ? 'page' : 'toast';        // see decision #7
    case 'not_found':  return callSite === 'route_load' ? 'page' : 'toast';        // 404 page on nav; toast on action
    case 'validation': return 'inline';                                            // FieldError per field; never toast
    case 'conflict':   return 'toast';                                             // v1; modal deferred to v2
    case 'rate_limit': return 'toast';                                             // with countdown
    case 'server':     return 'toast';                                             // with traceId + report dialog
    case 'realtime':   return 'banner';                                            // status pill, escalates to banner
    case 'render':     return 'page';                                              // ErrorBoundary
    case 'unknown':    return 'toast';
  }
}

// One entry point. Hook for mutations and queries call this.
export function renderError(classified: ClassifiedError, context: RenderContext): void;

// React-side state + UI primitives:
export function ErrorBanner(): JSX.Element;             // mounts in app shell, listens to transport/realtime store
export class RouteErrorBoundary extends React.Component  // class component (componentDidCatch); wraps each top-level route
                                  <Props, State> { ... } // exposes a context: { throwToBoundary(error) } so query/mutation hooks
                                                         // can promote a page-class error (not_found, forbidden)
                                                         // to the same boundary that catches render errors.
// Page templates — wrap with SettingsPageShell + SettingsPageHeader so
// the back-nav, title, and chrome are uniform with every other admin
// surface. NotFoundPage / ForbiddenPage / ServerErrorPage / OfflinePage
// all live under apps/web/src/components/errors/ and share the same
// shell. Width = 'default' (640px); the page is mostly headline copy +
// one or two recovery actions.
// ConflictModal — deferred to v2. The wire shape (§3.1) ships
// serverVersion + clientVersion now so v2 can land without contract change.
export function RateLimitToast(props): JSX.Element;     // live countdown via useNow
```

Why a class component, not data-router `errorElement`: the app uses `<BrowserRouter>` + `<Routes>` (`apps/web/src/main.tsx:13-21`). `errorElement` requires `createBrowserRouter` + `RouterProvider`. Migrating the route tree (131 `<Route>` declarations across `App.tsx` + nested layouts) is a multi-day refactor outside this spec. Class boundaries handle the same use case with less ceremony and don't block this work; if/when a future decision migrates to a data router, the boundary becomes a thin wrapper around `errorElement`.

### 3.5 Hook integration — composable helpers, not a hook replacement

A wrapper hook that owns `onError` fights React Query's contract: caller `onError` is where rollback / cache invalidation lives, `onMutate` returns context the rollback path reads, and ordering between wrapper-`onError` and caller-`onError` is ambiguous. Of the ~42 `useMutation` call sites in the codebase, ~6 use `onMutate` (optimistic) and several are RHF-coupled or composer-flow-coupled — none of these compose cleanly with a wrapping hook.

Instead, ship **composable helpers** that the caller invokes from inside their own `onError`:

```ts
// apps/web/src/lib/errors/handle-mutation-error.ts
export function handleMutationError(
  error: unknown,
  context: {
    actionTitle: string;                                          // 'Couldn't save webhook' (voice rule applies)
    retry?: () => void;                                           // re-run, if mutation is re-runnable
    setFormError?: (field: string, error: FieldError) => void;    // RHF setError, for validation
    onConflict?: 'modal' | 'silent_revert' | 'throw_to_boundary'; // default 'modal' once shipped
    rollbackExplain?: string;                                     // appended to optimistic-rollback toast if set
  },
): void;

// apps/web/src/lib/errors/mutation-options.ts
export function withErrorHandling<TVars>(
  context: HandleMutationErrorContext,
): { onError: (error: unknown, vars: TVars, ctx: unknown) => void };
//   ↑ returns an `onError` the caller spreads into mutationOptions when they
//     don't have their own onError. For callers with their own onError, they
//     call handleMutationError(error, { ... }) directly inside it.
```

Three usage shapes — caller picks the one that fits:

**A. Simple mutation (no optimistic, no form, no rollback) — most common:**

```tsx
const mutation = useMutation({
  mutationFn: api.saveWebhook,
  ...withErrorHandling({ actionTitle: "Couldn't save webhook" }),
});
```

**B. Form-coupled mutation — fields[] route to RHF:**

```tsx
const form = useForm<WebhookFormValues>();
const mutation = useMutation({
  mutationFn: api.saveWebhook,
  ...withErrorHandling({
    actionTitle: "Couldn't save webhook",
    setFormError: form.setError,                       // validation errors paint inline
  }),
});
```

**C. Optimistic mutation — caller owns onError, calls helper inside:**

```tsx
const mutation = useMutation({
  mutationFn: api.toggleFavorite,
  onMutate: async (vars) => {
    await qc.cancelQueries(...);
    const prev = qc.getQueryData(...);
    qc.setQueryData(..., optimistic(prev, vars));
    return { prev };
  },
  onError: (error, vars, ctx) => {
    qc.setQueryData(..., ctx?.prev);                   // rollback FIRST
    handleMutationError(error, {                       // then surface
      actionTitle: "Couldn't update favorite",
      rollbackExplain: 'We undid your change',
    });
  },
  onSettled: () => qc.invalidateQueries(...),
});
```

That's the single new API surface. The voice rule (`actionTitle = "Couldn't <verb> <thing>"`) is preserved because the helpers feed into the existing `toastError` from `apps/web/src/lib/toast.ts` (see §3.4 below). The wrapper-hook idea is explicitly rejected.

A matching `handleQueryError` helper exists for read paths and is thinner — most read errors surface via the route ErrorBoundary (page-class) or React Query's normal error state (inline-class). Pages that want a toast fallback for transient query errors call `handleQueryError(error, { actionTitle })` from a `useEffect` keyed on `error`.

## 4 · The error class × surface × recovery matrix

This is the contract. Every classifier branch lands one row. **Surface = `f(class, callSite)`** — most classes pin one surface; `permission` and `not_found` branch on whether the failing thing was a route load (page surface) or an action (toast surface).

| Class | Default surface (callSite) | Default recovery (in order) | Notes |
|---|---|---|---|
| `transport` (offline / DNS / timeout) | Banner pill in app shell | `retry` (auto-retry on reconnect) · `dismiss` | React Query `onlineManager` triggers refetch on reconnect. No toast; banner says it. |
| `auth` (401 expired) | Silent → redirect to sign-in | `signIn` (carries `next=` to current URL with form draft preserved) | Toast is wrong here. Just navigate. AuthProvider already partly handles this. |
| `permission` (403) | Page (`route_load`) · Toast (`mutation`) | `askAdmin` (with admin names if known) · `goBack` | Page state for navigation; toast for 'Save failed: missing permission' |
| `not_found` (404 / 410) | Page (`route_load`) · Toast (`mutation`) | `goBack` · `reload` | Page template branches on `body.reason ∈ ('missing','removed')` — "Doesn't exist" vs "This was removed". Toast for "Couldn't add — webhook was deleted." Hook calls `throwToBoundary()` to promote a query 404 into the same boundary that catches render errors. 410 is supported in the wire shape but no endpoint throws it today; soft-delete-awareness is server-side discipline that ships separately. |
| `validation` (422) | Inline `<FieldError>` | (no toast; field errors are the recovery) | Submit button disabled until form is valid. |
| `conflict` (409) | Toast (v1) · Modal (deferred to v2) | `reload` (v1) · `pickAlternative` (v2 only) | v1 surfaces "This was changed by someone else" + Reload. v2 modal with use-theirs/keep-mine deferred until a real surface demands it. Wire fields `serverVersion` / `clientVersion` ship now. |
| `rate_limit` (429) | Toast with live countdown | `retry` (auto, when timer expires) · `dismiss` | If `retryAfter` missing, that's a server bug — log it. |
| `server` (5xx) | Toast | `retry` · `contactSupport` (with traceId pre-filled) | TraceId is small text in toast, click to copy. |
| `realtime` (ws drop) | Status-bar dot → banner if >30s | `retry` (auto-reconnect with backoff) | Distinct from `transport` because realtime can drop while HTTP works. |
| `render` (caught by `RouteErrorBoundary`) | Per-route fallback page | `reload` · `goBack` · `contactSupport` | App keeps running, only the broken route is replaced. Same boundary that handles `not_found`/`forbidden`-as-page. |
| `unknown` | Toast | `retry` · `contactSupport` | Landing here is a classifier bug. Add a class branch. |

## 5 · Code taxonomy — the registry

Codes are domain-namespaced. The **single source of truth** is the workspace package `packages/shared/error-codes` (already a viable home — `packages/shared` exists and exports types consumed by both apps). The package exports:

- `ErrorCode` — a TypeScript string-literal union of every registered code.
- `ERROR_CODE_DOMAINS` — `Record<string, string>` mapping code → domain (`'ticket' | 'permission' | …`) for ESLint partition rules.
- A runtime `Set<string>` for the filter to validate that any code it emits is registered.

The server reads `ErrorCode` from this package when constructing `AppError`. The client reads it as the key set for `messages.<locale>.ts`. Adding a code = one PR that updates the shared package + adds messages in `messages.en.ts` + (Wave 4+) `messages.nl.ts`. CI guard:

- Build fails if the server emits a code that isn't in the shared `Set`.
- Build fails if `messages.en.ts` is missing any code from `ErrorCode`.
- Build warns (not fails) if `messages.nl.ts` is missing any code (Dutch lags English by design — translate within a sprint).

**No fall-through to server `detail`.** The renderer never displays the server's `title`/`detail` verbatim. If a code isn't registered (which the CI guard makes nearly impossible), the renderer shows `unknown.server_error` copy + traceId. This is the leak-prevention control for decision #13: even if a server error string accidentally embeds a vendor name, SQL, or stack, the user never sees it.

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

### 6.2 Mid-call session-refresh resilience (the real auth problem)

The `auth.expired` UX problem isn't "user gets redirected to sign-in mid-edit" — Supabase's JS client uses `autoRefreshToken: true` + `persistSession: true` by default, refreshes the token silently in the background, and surfaces a 401 to `apiFetch` only when the refresh token itself is dead (rare; the refresh window is days). The frequent failure mode is different:

- A mutation fires.
- The access token expires *during* the request (server reads it as expired before responding).
- The mutation gets a 401 even though the user is "still signed in" client-side — Supabase has by now silently refreshed the access token in another listener.

**v1 behaviour for this case:** when `apiFetch` sees a 401 and the Supabase client reports a *different* (newer) session than the one used for the request, retry the request once with the new token transparently, no UX. Implement at the `apiFetch` boundary so every call site benefits.

**Hard 401 (refresh token dead) — fallback path:**
1. Clear local Supabase session.
2. Redirect to sign-in with `?next=<current_url>`.
3. (Polish, deferred) Form-draft preservation via `sessionStorage` keyed by route + form id, rehydrated post-sign-in. This is genuinely a "love this app" detail in Linear / Stripe, but it fires approximately never given Supabase's silent refresh, so demote to a polish item — ship the redirect first, add the draft preservation when there's user demand.

**Refresh-loop bail rule (mandatory).** A dead refresh token surfaces a 401 on every subsequent request. If the AuthProvider re-attempts to read the session after the redirect (or if a third-party tab races the sign-in), the user can land in a tight 401 → redirect → 401 loop with the URL never settling.

The rule: `apiFetch` tracks consecutive `auth.expired` 401s in a single rolling 10-second window via a module-scoped counter (`Map<sessionId, { count, firstAt }>`). On the **3rd** consecutive `auth.expired` within 10s:

1. Hard-clear the Supabase session (`supabase.auth.signOut({ scope: 'local' })`).
2. Clear all React Query caches.
3. Replace history with `/sign-in?error=session_lost` (no `next=`; the next URL itself may be the trigger).
4. The sign-in page renders an explicit "Your session ended unexpectedly. Sign in again." banner — distinct from the normal sign-in copy — so the user knows what happened.

The counter resets on any 2xx response or after 10 seconds idle.

### 6.3 Stale conflict resolution (v1)

When a mutation hits `409 conflict` with `serverVersion` + `clientVersion`:
1. Renderer surfaces a toast: `"<Thing> was changed by someone else"` (e.g. "This webhook was changed by someone else"), with action `[Reload]`.
2. Reload re-fetches the server state via React Query's `invalidateQueries` for the relevant key.
3. The user re-applies their edits manually.

**Deferred to v2** — the modal with `[Use theirs] [Keep mine] [Show diff]` and forced `If-Match` re-submit. The wire shape (§3.1) ships `serverVersion` + `clientVersion` now so v2 can land without breaking the contract. The trigger to revisit: a concrete admin surface with measured concurrent-edit collisions (e.g. routing rules) where the toast-then-redo flow is shown to be high-friction.

### 6.4 Optimistic rollback animation

The caller owns the `onMutate` / rollback path (see §3.5 shape C). `handleMutationError` ships an opt-in animation step:

1. Caller restores previous state inside its own `onError` (using `ctx.prev` from `onMutate`).
2. Caller passes `rollbackExplain: 'We undid your change'` to `handleMutationError`.
3. The helper renders a toast with that prefix + the classified message, duration 6s, `Retry` action wired to the caller's mutation.

The animation itself (smooth revert, not a flicker) is the **caller's** responsibility and is enabled by passing the previous and current values through a shared `useTransition` / `view-transition` wrapper — documented as a recipe, not enforced. Silent reverts are still banned: callers must pass `rollbackExplain` if the rollback is user-visible.

### 6.5 Internationalization

`messages.nl.ts` ships in v1 alongside `messages.en.ts`. Codes that don't exist in the active locale fall back to English, then to the server `detail`, then to a generic `"Something went wrong"`. Untranslated codes show up in dev console; CI fails if any code in `codes.ts` is missing from `messages.en.ts`.

## 7 · Migration plan

This is incremental. Nothing breaks on day one.

**Wave 0 — Foundation (mostly invisible UX change)** — ~5 days
- **Body-shape audit + shim FIRST.** Today some call sites read `error.body` / `error.details` directly. Confirmed consumer: `apps/web/src/components/booking-composer/helpers.ts:72-85` (`extractAlternatives`) reads `error.details.alternatives` from 409 conflict bodies. There may be a small number of others — `grep -rn "error\.\(body\|details\)" apps/web/src --include="*.ts" --include="*.tsx"` is the audit. The filter ships in two phases:
  - **0a (shim):** the new `AllExceptionsFilter` writes the new wire shape AND preserves any pre-existing top-level keys legacy consumers rely on (`alternatives`, etc.) at the root level for one release. The filter logs whenever a request hits the legacy-shim branch so we can confirm the consumer set is empty before phase 0b.
  - **0b (cutover):** once the audit + shim usage logs confirm zero legacy reads in a 1-week window, drop the shim and ship the clean wire shape.
- Ship request-id middleware (`apps/api/src/common/middleware/request-id.middleware.ts`): reads `X-Request-Id` from inbound, generates ULID-prefixed `req_<ulid>` if missing, attaches to `req.id`, sets response header.
- Ship logger enrichment so every log line includes `traceId` (extend the existing Nest `Logger` adapter; no new logging system).
- Ship `AllExceptionsFilter` server-side with `normalize()` covering AppError / HttpException / ZodError / Postgrest / pg-native / AbortError / unknown.
- Ship `AppError` + factory module + ESLint guard against bare `throw new Error(...)` outside the factory.
- Ship `ApiError` client extensions (typed accessors for `code`, `traceId`, `fields`, etc.) + read `X-Request-Id` from every response.
- **Visible result:** every error now has a traceId in the body and in server logs. The booking-composer 409 alternatives flow continues to work (via the shim). Nothing else changes user-visibly.

**Wave 1 — Classifier + 3 surfaces** — ~5 days
- Ship `classify()` + `ClassifiedError` types + tests.
- Ship `handleMutationError` + `withErrorHandling` + `handleQueryError` helpers.
- Ship 3 renderers: toast, inline (FieldError integration), banner.
- Wire `apiFetch` mid-call session-refresh retry (§6.2).
- Migrate the 5 highest-traffic mutations behind a feature flag; verify voice rule preserved.
- **Visible result:** validation errors paint inline; offline shows a banner; toasts for everything else look mostly the same but now have traceId.

**Wave 2 — Page-level surfaces** — ~5 days
- Ship `RouteErrorBoundary` (class component) + `throwToBoundary` context bridge.
- Wrap each top-level route element with the boundary (single edit per route in `App.tsx`).
- Ship 404-with-`reason` / 403 / 5xx page templates, all wrapped in `SettingsPageShell` + `SettingsPageHeader` (width `default`) for back-nav uniformity. 404 page branches on `body.reason ∈ ('missing','removed')`.
- Migrate top-traffic queries to call `throwToBoundary()` for page-class errors.
- **Visible result:** broken pages now show real page state instead of stale content + toast.

**Wave 2 explicitly does NOT migrate the route tree to a data router.** That migration (`createBrowserRouter` + loaders/actions) is a separate decision; it's a multi-day refactor across 131+ routes and is out of scope here.

**Wave 3 — Recovery polish + realtime** — ~5 days
- Realtime status store + listener wiring (no central store today; three call sites manage their own channels).
- Rate-limit live countdown.
- Optimistic-rollback animation recipe (caller composes; documented).
- Render-error boundary per route (already shipped in Wave 2 — this is the polish pass).
- 401 refresh-loop bail rule.
- (Polish, not strictly required) Form-draft preservation on hard sign-out.
- **Visible result:** every error has an actionable next step; the platform feels "smart" when things go wrong.

**Wave 4 — Backfill + Dutch** — ~3 days, can run in parallel with Wave 3
- Migrate the next 30 highest-traffic throw sites to coded `AppError`.
- Migrate every `safeParse` call site to throw `AppError` via `throwZodError` (Zod migration — see §3.2).
- Ship `messages.nl.ts` for the registered code set.
- Add CI guard that fails the build if a registered code lacks an English message; warn on production-log codes that aren't registered.
- Document the spec under `docs/error-handling.md` (operational ref, like `docs/visibility.md`).

**Total: ~23 working days (~4–5 weeks) for one engineer.** Waves 0+1 alone (~10 days) eliminate the bulk of the user-visible badness; the rest is the discipline that makes the system stay good.

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
| Engineers throw `new Error('something')` and skip `AppError` | High | Two layers: (a) ESLint rule `no-restricted-syntax` flags `throw new Error(...)` outside the AppError factory module; (b) **runtime audit** — when `normalize()` hits the `unknown` branch on an `Error` instance with no `code` property, log a structured `error_normalize_unknown` line with the request URL, error message, and stack frame so we can find missing migrations even when the throw happens in a dependency, generated code, or a path the linter can't see. The two layers complement each other: lint catches first-party regressions in code review; runtime audit catches everything that escapes review (including `new Error()` thrown from monorepo packages, library code, and async closures the AST walker missed). |
| Filter normalises a sensitive error (e.g. JWT secret in stack) into the response | Low if reviewed; catastrophic if missed | Filter strips `cause` from response body (kept in logs only). Test for it. |

## 10 · Open questions

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Do we want a dedicated `docs.prequest.app/errors/<code>` site, or just inline help text? | Inline help only for v1; build docs site if support volume justifies it. |
| 2 | Should `traceId` be visible to all users or only operators? | All users. The copy-on-click chip is small; doesn't add noise; hugely speeds support. |
| 3 | When a 5xx happens, do we surface a 'Report this' dialog (Sentry-style) or just a toast? | Toast for v1 with traceId + Contact-support mailto. No modal dialog — see decision #15. Revisit if support volume warrants. |
| 4 | Conflict modal: do we render a real field-level diff, or just 'their values vs your values'? | Side-by-side per-field for v1. Real merge UI is overkill. |
| 5 | How aggressive is auto-retry on transport errors? | React Query default (2 retries with backoff); banner shows attempt count. |
| 6 | Do we ship `messages.nl.ts` in v1 or punt to v2? | Ship in v1 — Benelux-primary market, doing this once is cheaper than twice. |
| 7 | Do we audit-log every user-facing error event? | No. Too noisy. Audit-log only the underlying domain events (failed mutation = the existing audit; the user's visual error = client log only). |
| 8 | Form-draft preservation on auth-redirect — `sessionStorage` or in-memory? | `sessionStorage` so it survives the actual sign-in redirect (which is a full page nav). Cleared on rehydrate. |

## 11 · Success criteria

The spec is shipped when:

- Every error response from the API has the wire shape (verified by an integration test that hits 30+ endpoints and asserts shape).
- The 5 highest-traffic mutations + the 10 highest-traffic queries use the new error helpers (`handleMutationError` / `withErrorHandling` / `handleQueryError`). An ESLint rule **warns** (not fails) on `useMutation` call sites that don't compose with `withErrorHandling` or call `handleMutationError` from `onError`. Migration of the remaining ~37 mutations is tracked as follow-on work, not a blocker for shipping the system.
- 95% of errors that *reach the renderer* classify into a class other than `unknown` (measured via client-side `logger.warn` count when `classify()` returns `unknown`, sampled over 1 week).
- A manual QA pass exercises one error from each of the 11 classes and verifies the correct surface + recovery.
- TraceId is present on every server log line, every error response, and every user-visible error UI.
- A support engineer can resolve a "something broke" ticket in <2 minutes given only a traceId and the URL the user was on.
- `messages.nl.ts` covers 100% of registered codes; lint passes.
- The codex review of the implementation finds zero "vendor name leaks" and zero "stack trace in response body" issues.

When all eight hold, we have an error system that's better than every product in the FMIS market and competitive with the best products outside it.
