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

### Scope: this spec governs `apps/web/` only

This spec is the contract for the **operator-side / admin-side / employee-portal web app at `apps/web/`**. It does NOT govern the separate vendor-portal codebase (project memory: `project_vendor_portal_separate_codebase.md`) or the future kiosk/mobile-native apps that may ship as separate projects.

**However, the wire shape (§3.1) IS shared.** Any client that talks to the FMIS API — vendor portal, kiosk, mobile-native, or anything else — receives the same RFC 9457-inspired body and the same `code` registry from `@prequest/shared`. They each ship their own renderer / classifier / messages package tuned to their surface (mobile-first, kiosk-only, etc.); the wire contract is non-negotiable across all clients.

A vendor or future-kiosk engineer reading this spec should: (1) consume `@prequest/shared` for the code union and registered messages they care about, (2) re-use the classifier / renderer concepts described here as a starting point, (3) NOT assume the helpers, hooks, or React-specific renderers in §3 are available in their codebase — those are `apps/web`-specific.

## 2 · Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | The wire shape is **RFC 9457-inspired** (`code`, `title`, `detail`, `status`, `fields[]`, `traceId`, plus app-specific extensions for `retryAfter`, version-conflict, bulk results). The literal `type` URI from the RFC is **not** included — nobody consumes it; Stripe / Linear / Vercel ship variants without it; including it implies a phantom dependency on a docs site at `errors.prequest.app/<code>` that doesn't exist. | The contract surface that matters is `code`. The RFC's `type` URI duplicates what `code` already conveys, costs bytes, and signals a docs site we haven't built. |
| 2 | Every error response carries `code` (stable, machine-readable) + `title` (human outcome) + `detail` (one-line explanation) + optional `fields[]` + always a `traceId`. | Code is the join key for client message lookup + recovery. TraceId is non-negotiable — support uses it. |
| 3 | A **single global Nest `AllExceptionsFilter`** normalises every thrown thing — `HttpException`, `ZodError`, raw `pg` errors, `PostgrestError`, unknown errors — into the wire shape. Migrating call sites is incremental; the filter handles legacy `BadRequestException(string)` cleanly. **Note:** the repo uses Zod for runtime validation (manually called per controller via `safeParse`); `class-validator` is not installed and there is no `ValidationPipe`. The filter has no `class-validator` branch. | One file, every endpoint benefits day one. Migrate throw sites by traffic, not all-at-once. |
| 4 | An **`AppError` class** (server) with `code`, `status`, `fields?`, `cause?`, `docsUrl?`. New throw sites use it. Legacy `BadRequestException(string)` is mapped by the filter to `code: 'generic.bad_request'` until migrated. | Coded errors at the source preserve intent; string errors stay supported during migration. |
| 5 | A **client-side `classify()` function** turns any thrown thing (`ApiError`, `Error`, fetch failure, abort) into a `ClassifiedError` with `class` + `code` + `fields?` + `traceId?` + `recovery`. **Classification happens once, at the boundary.** Renderers read the classified shape. | Decouples "what went wrong" from "how it shows up". Without this layer every renderer re-derives the same state. |
| 6 | **11 error classes** (`transport · auth · permission · not_found · validation · conflict · rate_limit · server · realtime · render · unknown`), each mapped to a default surface and recovery. (Matrix in §4.) Classes are exhaustive — every error must classify into exactly one. `unknown` exists as a last-resort bucket for renderer correctness, but landing there is a bug to fix at the classifier. **`gone` (410) is collapsed into `not_found` with `reason: 'removed'`** because no endpoint in the API throws 410 today and surfacing it requires a separate server-side discipline (soft-delete-aware endpoints) outside this spec's scope. The `not_found` page template branches on `reason ∈ ('missing','removed','hidden')` to show different copy. **`reason: 'hidden'` is the security control** — see decision #6.1. | A taxonomy with a default-OK case isn't a taxonomy. Forcing exhaustiveness drives classifier completeness. Don't ship a class without server-side support — it'd just be dead code. |
| 6.1 | **Tenant-isolation privacy: RLS-blocked rows MUST return `not_found` with `reason: 'hidden'`, never `permission.denied`.** Returning 403 for a row the user shouldn't even know exists leaks row existence (and therefore tenant boundaries) to the client. Server discipline: any read path that loads-then-checks-tenant returns 404 (`not_found` + `reason: 'hidden'`) for cross-tenant or out-of-scope rows. Permission-based denial (`permission.denied`) is reserved for **same-tenant** rows the user can't act on (e.g. an Operator trying to edit a ticket they can read but not write). The `not_found` page template renders the same copy for `'missing'` and `'hidden'` ("This doesn't exist or you don't have access") — the distinction is purely server-side, never user-visible. | This is a security finding, not a UX one. Without this rule, an attacker (or an over-curious internal user) can probe `/admin/users/:id`, `/desk/tickets/:id` etc. and infer cross-tenant existence by 403-vs-404. |
| 7 | The **surface for an error is decided by `(class, call-site-kind)`** — most classes pin a single surface, but two need the call-site to disambiguate: (a) `permission` is a page when the failing thing was a route load, a toast when it was an action; (b) `not_found` is a page when route-load, a toast when an action references a no-longer-existing entity ("Couldn't add — webhook was deleted"). Toasts are right ~30% of the time; transport errors get a banner, page-level errors replace the page, field errors paint inline. Renderers expose `handle(error, context)` where `context.callSite ∈ ('route_load','mutation','realtime','render')` lets the renderer pick correctly. | Right now every error is a toast. That's why the app feels noisy and useless when things go wrong. The class-only-decides claim was a simplification — make the dispatch contract honest so call sites pass `callSite` deliberately rather than guessing. |
| 8 | **Every error has a recovery.** If the design can't name one, the class is wrong. **v1 recovery options:** `retry` · `wait` (timed-retry, distinct from `retry` because the action is "do nothing") · `signIn` · `reload` · `goBack` · `pickAlternative` · `askAdmin` · `contactSupport` · `copyDraft` · `dismiss`. **`requestAccess` is deferred to a follow-up spec** because it requires a self-serve access-request ticket type, routing rule, and assignee resolution that don't exist in today's catalog — shipping a button that creates a ticket nobody owns is worse than shipping `askAdmin` that names the right person. The follow-up spec defines the access-request request type + routing + workflow before the button reappears. | "Try again" is the floor, not the ceiling. `wait` is distinct so the renderer shows a disabled-with-countdown button rather than a Retry that's wrong-labeled. `requestAccess` was hand-waved — defer until the ticket plumbing exists. `copyDraft` is the v1 conflict-toast partner action (see §6.3). |
| 9 | **Messages are looked up client-side by `code`. Unregistered codes fail closed — never display the server's `detail` verbatim.** A code that's not in `messages.<locale>.ts` renders as `unknown.server_error` copy + traceId, not as the server's English prose. The code registry lives in a shared workspace package (`packages/shared/error-codes`) so server enum + client message coverage stay in sync; CI fails on drift. | Localisation, ability to rewrite a confusing message without a deploy. **Fail-closed is the security control:** if a server message accidentally embeds a vendor name, SQL fragment, or stack frame, the client never displays it because the code-message lookup is the only path to user-visible copy. The detail field stays in the response (for support / dev tools) but is not rendered. |
| 10 | **TraceId everywhere on the wire and in logs; tiered visibility in the UI.** Generate at request boundary (`X-Request-Id`), echo in every error response and every server log line, capture on every `ApiError`. **UI tier:** visible by default for `server`-class errors (5xx) where contacting support is the recovery anyway, and on the page-replacement surfaces (`render` / route-load 5xx). For toasts on other classes (`validation`, `permission`, `not_found`, `conflict`, `rate_limit`, `transport`), traceId is hidden behind a "Show details" disclosure so non-technical users (Requester, Visitor, Receptionist) don't see hex strings under "Couldn't save visitor". Operator-class personas (Service Desk Operator, Tenant Admin, Facilities Admin) see traceId visibly on every toast — the user's role catalog already distinguishes them. | Highest-leverage single change for support, but raw traceId chips below "Couldn't save visitor" read as system noise to a non-technical user. The information stays available (one click), it just stops being the default UX texture. |
| 11 | **Field-level errors never toast.** When `fields[]` is present, the form's mutation hook stuffs them into RHF state and the toast either suppresses or becomes a generic "Some fields need attention." **The renderer also scrolls the first errored field into view, focuses its input, and applies a 500ms ring animation** so the user finds the offending field on long forms (e.g. 30-field request-type forms where the first error is below the fold). The mechanism: `handleMutationError` after `setFormError` calls a `scrollFirstErrorIntoView()` helper that finds the topmost field with an error in document order, scrolls with `block: 'center'`, focuses the input, and adds a `data-error-flash` attribute that drives a 500ms ring animation via the existing `--ease-snap` token. | The current setup turns Zod errors (via `formatZodError`) into a single comma-joined string — unusable as toast text and impossible to map to specific form fields. Best-in-class apps (Stripe, Linear) do scroll-and-focus by default; users on long forms otherwise get "Some fields need attention" with no idea which field is at fault. |
| 12 | **Optimistic-update rollback is animated and explained.** The `useMutation` `onError` rollback path adds a one-line toast "We undid that change because: <reason from code>". Silent reverts are banned. | Most apps fail here; it's a high-leverage polish moment. |
| 13 | **No vendor names leak to users.** Resend / Supabase / Stripe / Postgres errors are mapped to neutral codes (`email.dispatch_failed`, `realtime.unavailable`, `payment.failed`, `db.constraint`). Internal logs keep the original. | Both branding (don't ship "Resend down") and security (don't leak stack info). |
| 14 | **Page-level errors replace the page**, not toast over a now-broken page. Implemented via per-route React class `ErrorBoundary` components wrapping each top-level route element (`<Route element={<ErrorBoundary><DeskPage/></ErrorBoundary>}>`). The boundary catches both render errors *and* errors thrown into a `throwToBoundary()` ref by query/mutation hooks for page-level classes (`not_found`, `forbidden`, generic 500). Renders forbidden / not-found (with `reason` branch for "removed" copy) / offline / generic 500 states. | Toasting "Not found" while leaving a broken detail page on screen is the worst UX in the platform today. **Note:** the app currently uses `<BrowserRouter>` + `<Routes>` (component router). React Router's data-router `errorElement` is not available; migrating to `createBrowserRouter` is a separate decision (see §8). |
| 15 | **Error boundary at the route level**, not the app root. Catches render-time errors, classifies as `class: 'render'`, shows a minimal fallback with reload + a no-mailto support fallback. **The v1 5xx / render fallback shows: error code · traceId chip (copy-on-click) · `[Reload]` · `[Copy traceId]` · `[Go back]` · plain-text support email + phone displayed inline (not mailto links).** No `mailto:` — that breaks for the receptionist on a shared terminal (no personal mail), the visitor on a kiosk (no mail at all), and the vendor on a kitchen phone (work mail not configured). Copy-to-clipboard is universal across surfaces. The Sentry-style modal-with-comment dialog stays deferred to v2. | App-root boundaries lose all context. Per-route boundaries let other regions stay alive. Mailto assumes a desktop-Outlook environment that 3 of 8 personas don't have; copy-to-clipboard works on every surface. |
| 16 | **Realtime / sync drops are status-bar UI, not toasts.** **Placement (specified):** the dot lives inline with the page header on realtime-aware pages — the desk scheduler, booking lists, reception today, and any page using `usePresence`/`useRealtime*`. A 6×6 dot adjacent to the page title (right-aligned in the title row, before any action buttons), color-coded `green` (open) · `amber` (reconnecting) · `red` (broken). **NOT** in the global app shell next to the avatar — operators staring at a queue for 8 hours don't notice the avatar corner. **State transitions:** dot is hidden in `'open'` state for the first 30s (no churn during a normal page load); turns amber after 30s of `'reconnecting'`; if disconnected >30s it expands into a thin one-line banner above the page header ("Reconnecting — your changes will sync when reconnected"); if `'broken'` it shows red persistently and disables write actions on the page (the existing button `data-pending` styling). **This requires new infrastructure** — a `RealtimeStatusStore` (Zustand or context+reducer) that aggregates the state of every active Supabase channel. Today the three live realtime call sites (`use-realtime-bundle`, `use-realtime-scheduler`, `use-realtime-availability`) each manage their own `.channel().subscribe()` with no shared status. Wave 3 builds the store, exposes a `useRealtimeStatus()` hook, and migrates the three hooks to register/unregister channels with the store. The page header reads aggregate `'connecting' \| 'open' \| 'reconnecting' \| 'broken'`. | Realtime flaps. Toasting every flap is hostile. Avatar-corner status is invisible to anyone whose work is the page content. Inline with the page header is where the operator's eye already is. |
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

**Bulk operations:** any endpoint that accepts a batch of items (delete-many, update-many, dispatch-many, etc.) returns the same wire shape with `results[]` + `partialSuccess`. The HTTP status is the worst-case outcome (any failed → 207 Multi-Status; all failed → 4xx/5xx; all ok → 2xx with `results[]` for confirmation). **Adding bulk semantics is not optional and not deferrable** — once a non-bulk endpoint exists, evolving it to a bulk shape would be a breaking change to the wire contract that decision #1 forbids.

**Bulk surface (v1 — keep simple).** When `handleMutationError` sees `partialSuccess: true` on a 207 response, it overrides the call site's `actionTitle` and renders a toast formatted from the bulk shape: `"<n_ok> of <n_total> <entityPlural> <verbPast> — <n_fail> failed [Show me]"` (e.g. `"7 of 10 webhooks deleted — 3 failed [Show me]"`). Two new params on the call site's helper:

- `entityPlural: string` — e.g. `'webhooks'` (used in the partial-success toast title).
- `verbPast: string` — e.g. `'deleted'`, `'updated'` (drives the past-tense template).

Both are inferred from the `actionTitle` when possible (`"Couldn't delete webhooks"` → `entityPlural: 'webhooks'`, `verbPast: 'deleted'`); the call site overrides explicitly when the inference fails.

`[Show me]` opens an **expanding inline list under the toast** (not a separate sheet) listing each failed item with per-item code lookup. Spec'd as expanding-inline because most bulk operations in this app today are admin-side and the failure list is short (1–10 items). When a real high-volume bulk surface ships and 50+-item failure lists become normal, promote to a Sheet with virtualized scroll. Spec'ing the Sheet now would gold-plate v1 for a path that fires rarely.

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
  | 'not_found'        // 404 + 410 + RLS-blocked (page-template branches on body.reason: 'missing' | 'removed' | 'hidden')
  | 'validation'       // 422 with fields[]
  | 'conflict'         // 409, version conflict
  | 'rate_limit'       // 429
  | 'server'           // 5xx (other than known third-party degradation)
  | 'realtime'         // websocket / SSE drop, distinct from transport
  | 'render'           // ErrorBoundary catch
  | 'unknown';         // last resort; landing here is a classifier bug

export type Recovery =
  | { kind: 'retry'; run: () => void }
  | { kind: 'wait'; until: number; run: () => void }                            // rate_limit countdown — disabled button until `until`
  | { kind: 'signIn'; next: string }
  | { kind: 'reload' }
  | { kind: 'goBack' }
  | { kind: 'pickAlternative'; alternatives: unknown[]; pick: (alt: unknown) => void }
  | { kind: 'askAdmin'; permission?: string; admins?: Array<{ id: string; name: string }> }
  // requestAccess deferred — needs ticket-type / routing / workflow plumbing that doesn't exist yet
  | { kind: 'contactSupport'; traceId: string; supportEmail: string; supportPhone?: string }
  | { kind: 'copyDraft'; serialize: () => string }                              // §6.3 conflict toast partner
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

#### Voice per surface

The "Couldn't <verb> <thing>" rule applies to **toasts**. Other surfaces have their own voice — applying toast voice to a banner reads as awkward translation ("Couldn't reach Prequest" doesn't fit a persistent connection-status pill). The `messages.<locale>.ts` lookup table is keyed by `(code, surface)` so the same code can render different copy on different surfaces.

| Surface | Voice | Examples |
|---|---|---|
| **Toast** | "Couldn't <verb> <thing>." Description = code-resolved detail. Retry/View/Undo per existing toast.ts contract. | "Couldn't save webhook." "Couldn't add visitor." "Webhook saved." (success) |
| **Banner** | Plain present-state. No verbs about the user's last action. | "You're offline." "Reconnecting…" "Working offline — changes will sync when you reconnect." |
| **Inline (`<FieldError>`)** | RHF-native. Single short phrase. No subject. | "Required." "Must be at least 32 characters." "Pick one of: low, normal, high, urgent." |
| **Page** | "We can't <find/show/load> <this thing>." First-person plural; less mechanical than the toast voice. | "We can't find this webhook." "You don't have access to this booking." "Something went wrong on our end." |
| **Modal** | (Conflict modal deferred to v2.) When shipped: "<Thing> was changed by someone else." | (See §6.3 v1 toast equivalent for now.) |
| **Silent** | No copy — handler claims it (e.g. auth → redirect). | n/a |

When you add a new code, you specify the toast title and detail; the page surface auto-falls-back to a generic per-class template ("We can't find this <thing>" using the entity name from the code's first dotted segment) unless you override per-surface.

#### Bilingual reference copy (en / nl) for the new surfaces

The decisions in §6.2 / §6.3 / §3.1 introduce surface-specific copy that doesn't fit the generic code-message lookup. Pin the canonical en + nl phrases here so Wave 1 ships with both locales and Wave 4 doesn't have to retro-translate from English screenshots:

| Surface fragment | English | Dutch (operational) |
|---|---|---|
| Bulk partial-success toast title | `"<n_ok> of <n_total> <entityPlural> <verbPast> — <n_fail> failed"` | `"<n_ok> van <n_total> <entityPlural> <verbPast.nl> — <n_fail> mislukt"` |
| Bulk "Show me" action | `"Show me"` | `"Toon details"` |
| Rate-limit countdown button | `"Try in {seconds}s"` | `"Probeer over {seconds}s"` |
| Mid-call refresh button label | `"<verb>… (signing back in)"` | `"<verb.nl>… (opnieuw aanmelden)"` |
| Realtime banner (>30s disconnected) | `"Reconnecting — your changes will sync when reconnected."` | `"Verbinden… je wijzigingen worden gesynchroniseerd zodra de verbinding terug is."` |
| Realtime banner (broken / writes disabled) | `"Connection lost. Saving is paused until you reconnect."` | `"Geen verbinding. Opslaan is uitgeschakeld tot de verbinding terug is."` |
| Conflict toast title | `"<Thing> was changed by someone else."` | `"<Thing.nl> is door iemand anders gewijzigd."` |
| Conflict toast — Copy action | `"Copy my changes"` | `"Kopieer mijn wijzigingen"` |
| Conflict toast — Reload action | `"Reload"` | `"Herladen"` |
| 5xx page heading | `"Something went wrong on our end."` | `"Er is iets misgegaan aan onze kant."` |
| 5xx page traceId helper | `"Reference: {traceId}"` | `"Referentie: {traceId}"` |
| Hard sign-out banner | `"Your session ended unexpectedly. Sign in again."` | `"Je sessie is onverwacht afgesloten. Meld je opnieuw aan."` |

Translation rule (already in §6.5): translate the operational consequence, not the literal English. The table above is the v1 baseline; native-NL review still required per §6.5.


```ts
// apps/web/src/lib/errors/renderer.tsx

type Surface = 'toast' | 'inline' | 'page' | 'banner' | 'modal' | 'silent';
type CallSite = 'route_load' | 'mutation' | 'realtime' | 'render';
//                                          ^^^^^^^^^^   ^^^^^^^^
//   `'realtime'` — passed by the realtime hooks when a Supabase channel
//   callback throws (so the renderer routes to the realtime banner /
//   status dot, not an action-class toast).
//   `'render'` — passed by `RouteErrorBoundary.componentDidCatch`.

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
    case 'server':     return 'toast';                                             // with traceId chip + copy-to-clipboard fallback
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
export type CallSite = 'route_load' | 'mutation' | 'realtime' | 'render';

export function handleMutationError(
  error: unknown,
  context: {
    actionTitle: string;                                          // 'Couldn't save webhook' (voice rule applies for toast surfaces)
    callSite?: CallSite;                                          // default 'mutation'; pass 'route_load' for queries that block a page
    retry?: () => void;                                           // re-run, if mutation is re-runnable
    setFormError?: (field: string, error: FieldError) => void;    // RHF setError, for validation
    onConflict?: 'toast' | 'silent_revert' | 'throw_to_boundary'; // default 'toast' (v1); v2 will add 'modal'
    rollbackExplain?: string;                                     // appended to optimistic-rollback toast if set
    formDraftKey?: string;                                        // serialise RHF draft to sessionStorage on auth.expired
  },
): void;

// apps/web/src/lib/errors/mutation-options.ts
export function withErrorHandling<TVars>(
  context: Omit<Parameters<typeof handleMutationError>[1], never>,
): { onError: (error: unknown, vars: TVars, ctx: unknown) => void };
//   ↑ returns an `onError` the caller spreads into mutationOptions when they
//     don't have their own onError. For callers with their own onError, they
//     call handleMutationError(error, { ... }) directly inside it.

// apps/web/src/lib/errors/handle-query-error.ts
export function handleQueryError(
  error: unknown,
  context: {
    callSite: CallSite;                                           // explicit; queries differ — page-load vs sidebar
    actionTitle?: string;                                         // 'Couldn't load webhooks' (only used on toast surfaces)
    retry?: () => void;
  },
): void;
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

A matching `handleQueryError` helper exists for read paths and is thinner — most read errors surface via the route ErrorBoundary (page-class) or React Query's normal error state (inline-class). Pages that want a toast fallback for transient query errors call `handleQueryError(error, { actionTitle, callSite: 'mutation' })` from a `useEffect` keyed on `error`.

#### Page-load query routing convention

The mechanism that promotes a page-load query's error to the route boundary (instead of a toast) is the boundary-context. The `RouteErrorBoundary` exposes a `throwToBoundary(error: ApiError)` function via React context. The convention:

- A page's **primary** queries (the ones whose failure means the page can't render meaningfully) wrap their query in `usePageQuery(...)` — a thin shadcn-style helper that calls `useQuery(...)` and, on error with class ∈ `('not_found','permission','server')`, calls `throwToBoundary(error)` from the boundary context. The boundary catches it the same way it catches a render error.
- A page's **secondary** queries (sidebar lists, autocomplete sources, prefetch) call `useQuery(...)` normally and pass the error to `handleQueryError(error, { callSite: 'mutation', actionTitle: "Couldn't load <thing>" })` from a `useEffect`. These don't fail the page; they toast.

The distinction is made by the call site, not inferred — there's no implicit "first query in the file." A page that has 3 primary queries calls `usePageQuery` 3 times.

This is also why `callSite` is `'mutation'` for query toasts in helper signatures: from the renderer's perspective, "an action on this page failed" is the same surface whether it was a mutation or a sidebar query.


## 4 · The error class × surface × recovery matrix

This is the contract. Every classifier branch lands one row. **Surface = `f(class, callSite)`** — most classes pin one surface; `permission` and `not_found` branch on whether the failing thing was a route load (page surface) or an action (toast surface).

| Class | Default surface (callSite) | Default recovery (in order) | Notes |
|---|---|---|---|
| `transport` (offline / DNS / timeout) | Banner pill in app shell | `retry` (auto-retry on reconnect) · `dismiss` | React Query `onlineManager` triggers refetch on reconnect. No toast; banner says it. |
| `auth` (401 expired) | Silent → redirect to sign-in | `signIn` (carries `next=` to current URL with form draft preserved) | Toast is wrong here. Just navigate. AuthProvider already partly handles this. |
| `permission` (403) | Page (`route_load`) · Toast (`mutation`) | `askAdmin` (with admin names if known) · `goBack` | Page state for navigation; toast for 'Save failed: missing permission'. `requestAccess` (self-serve ticket creation) is deferred to a follow-up spec — see decision #8. |
| `assignment.invalid` / `vendor.not_in_scope` (subset of `permission`-class operations) | Toast (`mutation`) | `pickAlternative` (eligible-list inline expansion) · `dismiss` | When an Operator picks an assignee or vendor that isn't eligible (permission revoked, scope changed mid-edit, vendor became inactive), the right recovery is "show the eligible list", not "ask an admin". The classifier branches `permission` → `pickAlternative` recovery for these specific codes; the eligible list is fetched lazily by the recovery callback (`alternatives: () => Promise<…>` rather than the up-front `alternatives: unknown[]`) so the list is fresh. |
| `not_found` (404 / 410 / RLS-hidden) | Page (`route_load`) · Toast (`mutation`) | `goBack` · `reload` | Page template branches on `body.reason ∈ ('missing','removed','hidden')`. Server returns `'hidden'` for RLS-blocked rows (security: never leak tenant existence via 403 vs 404 — see decision #6.1). Page renders the same copy for `'missing'` and `'hidden'`; the difference is only relevant in audit logs. Toast for "Couldn't add — webhook was deleted." 410 is supported in the wire shape but no endpoint throws it today. |
| `validation` (422) | Inline `<FieldError>` | (no toast; field errors are the recovery) | Submit button disabled until form is valid. |
| `conflict` (409) | Toast | `copyDraft` (when caller supplies `serialize`) · `reload` | v1 surfaces "This was changed by someone else" with `[Copy my changes]` (offered only when the caller supplies a `serialize` callback — approver toggles, view-mode rows, and similar non-draft surfaces omit it) + `[Reload]`. Copy serializes the form draft to clipboard before reload destroys edits. v2 will introduce the use-theirs/keep-mine modal once a surface demands it; wire fields `serverVersion` / `clientVersion` ship now so the upgrade lands without breaking the contract. |
| `rate_limit` (429) | Toast with live countdown | `wait` (disabled button shows "Try in 47s"; auto-fires when timer expires) · `dismiss` | If `retryAfter` missing, that's a server bug — log it. |
| `server` (5xx) | Toast | `retry` · `contactSupport` (with traceId pre-filled) | TraceId is small text in toast, click to copy. |
| `realtime` (ws drop) | Status-bar dot → banner if >30s | `retry` (auto-reconnect with backoff) | Distinct from `transport` because realtime can drop while HTTP works. |
| `render` (caught by `RouteErrorBoundary`) | Per-route fallback page | `reload` · `goBack` · `contactSupport` | App keeps running, only the broken route is replaced. Same boundary that handles `not_found`/`forbidden`-as-page. |
| `unknown` | Toast | `retry` · `contactSupport` | Landing here is a classifier bug. Add a class branch. |

## 5 · Code taxonomy — the registry

Codes are domain-namespaced. The **single source of truth** lives in the existing workspace package `@prequest/shared` (`packages/shared/`, single-export `index.ts`). Add `packages/shared/src/error-codes.ts` and re-export from `index.ts`; consumers import via `import { ErrorCode, ERROR_CODES } from '@prequest/shared'`. No subpath exports, no package config changes — extend the existing surface, don't fork it. The module exports:

- `ErrorCode` — a TypeScript string-literal union of every registered code.
- `ERROR_CODE_DOMAINS` — `Record<ErrorCode, string>` mapping code → domain (`'ticket' | 'permission' | …`) for ESLint partition rules.
- `ERROR_CODES: ReadonlySet<ErrorCode>` — runtime set the filter uses to validate every code it emits is registered.

The server reads `ErrorCode` from `@prequest/shared` when constructing `AppError`. The client reads it as the key set for `messages.<locale>.ts`. Adding a code = one PR that touches `packages/shared/src/error-codes.ts` + adds messages in `messages.en.ts` + (Wave 4+) `messages.nl.ts`. CI guard:

- Build fails if the server emits a code that isn't in the shared `Set`.
- Build fails if `messages.en.ts` is missing any code from `ErrorCode`.
- Build warns (not fails) if `messages.nl.ts` is missing any code (Dutch lags English by design — translate within a sprint).

**No fall-through to server `detail`.** The renderer never displays the server's `title`/`detail` verbatim. If a code isn't registered (which the CI guard makes nearly impossible), the renderer shows `unknown.server_error` copy + traceId. This is the leak-prevention control for decision #13: even if a server error string accidentally embeds a vendor name, SQL, or stack, the user never sees it.

**Wave-0 transition escape hatch (time-limited).** During Wave 0, every legacy `BadRequestException(string)` site is mapped to `code: 'generic.bad_request'` by the filter — registered, fine. But if a code escapes the migration to `'unknown.server_error'` during the transition, the user sees a generic "Something went wrong" instead of the legacy English string that would have been adequate. To avoid this regression during the migration window:

- A **dev-only** env flag `ERRORS_RENDER_DETAIL_ON_UNKNOWN=1` makes the renderer fall back to `detail` for `unknown.server_error` (engineering can see the underlying message in dev / staging).
- A **prod** feature flag `errors_render_detail_on_unknown` (default off) can be temporarily flipped during the Wave-0a/0b transition window if a regression is observed for end users. The flag is removed in Wave 4 once the runtime audit (§9 risks) shows zero `error_normalize_unknown` events from production for a 1-week window.

The escape hatch is explicitly scoped: feature-flagged, time-limited, and removed by Wave 4. After that, fail-closed is permanent.

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

**v1 behaviour for this case:** when `apiFetch` sees a 401 and the Supabase client reports a *different* (newer) session than the one used for the request, retry the request once with the new token transparently. Implement at the `apiFetch` boundary so every call site benefits.

**Pending-state UX (mandatory).** A request that goes through the silent-refresh path takes longer than a normal request — usually 200ms vs ~1.5s when the refresh fires mid-flight. Without an indicator, the user sees a Save button that "hangs." Rule:

- React Query's `mutation.isPending` is exposed at the call site as today.
- `apiFetch` writes per-call `phase ∈ ('in_flight','refreshing')` to a **dedicated Zustand store** (`apps/web/src/lib/errors/api-call-phase-store.ts`) keyed by a per-request id (`apiFetch` generates a ULID per call and threads it through `RequestInit.signal` or a `headers['X-Client-Call-Id']` header so React Query can reach it). React Query mutations don't expose per-call meta updates between phases — that's why this is a side channel and not `mutation.meta`.
- React Query's `useMutation` exposes the mutation's most recent call id via a `mutateAsync` wrapper that records it; a hook `useMutationStatus(mutation)` joins the mutation to the call-phase store and returns `{ isPending, phase }`.
- Any button bound to a mutation past **600ms** of pending should re-label to a "<verb>… (signing back in)" form when phase is `'refreshing'`. Below 600ms, no change — the user doesn't notice.
- The button primitives (`<Button>` from `apps/web/src/components/ui/button.tsx`) get a new `mutation` prop that wires `useMutationStatus` automatically — call sites pass `<Button mutation={saveWebhook}>Save</Button>` instead of manually flipping the label. **No new component is created**; existing `Button` is extended. (Spec previously named `SubmitButton`/`RowActionButton` as new components; that was wrong — these don't exist as named exports and don't need to be created.)

This is the difference between "weird latency, did it work?" and "ah, it's signing me back in." Cheap to implement, big perceived-quality lift.

**Hard 401 (refresh token dead) — fallback path:**
1. Serialise the current form state (RHF `getValues()`) to `sessionStorage` under a **user-scoped key** `prequest:draft:${userId}:${route}:${formId}` — see "Form-draft preservation v1 scope" below.
2. Clear local Supabase session.
3. Redirect to sign-in with `?next=<current_url>`.
4. After sign-in, the form's `useEffect` rehydrates from `sessionStorage` (only if the rehydrated key's `userId` matches the freshly-signed-in user) and clears the key.

**Form-draft preservation v1 scope** (mandatory, not polish):

The receptionist persona explains why this can't wait. Shared front-desk terminal during a 09:00 visitor rush, JWT silently expires under load, six in-progress visitor entries vanish on the redirect — that's not a "love this app" detail, it's catastrophic data loss for a non-technical user during a peak. The same logic applies to the ticket form (employees mid-submission) and the booking-composer (operators mid-edit). v1 ships draft preservation for:

- **`/reception/walk-up`** + `/reception/check-in` (visitor forms — receptionist primary surface)
- **`/portal/new-ticket`** + the desk inline ticket creator (employee + operator surfaces)
- **The booking composer** (operators, often mid-rush)
- **Any admin form open in a `SettingsPageShell` with `dirty: true` form state** (catch-all for /admin/*)

Out-of-scope for v1: file inputs (warn the user to re-attach), drag-and-drop ordering state, mid-flight uploads. The text/select/checkbox/radio/textarea path covers the harm.

**`formDraftKey` mechanism (how the helper integrates).** The helper signature exposes a `formDraftKey?: string` param that the call site provides; it is the user-facing identifier (`'visitor-walkup'`, `'ticket-create'`, `'webhook-edit-:id'`) that combines with the user-scoped prefix below to form the storage key. The full lifecycle:

1. **Write trigger.** `handleMutationError(error, { formDraftKey, … })` runs on `auth.expired` (the hard-401 path). Before redirecting, the helper reads `form.getValues()` from the same form instance the call site is using (passed via the React `FormProvider` context, or — for non-RHF surfaces — via the registered `getDraftSnapshot()` callback below) and writes it to `sessionStorage` under `prequest:draft:${userId}:${formDraftKey}`.
2. **Where the form is.** RHF forms use `useFormContext()`; if the helper is called from inside `<FormProvider>`, the form is reachable. For mutations triggered outside a form (rare — most are inside one), the call site passes `getDraftSnapshot: () => unknown` instead of `formDraftKey`.
3. **Read trigger.** Each form-bearing route mounts a `useDraftRehydrate(formDraftKey)` hook that, on mount, reads `prequest:draft:${currentUserId}:${formDraftKey}` from sessionStorage. If a value is present and the userId matches the current session, the hook calls `form.reset(value)` and clears the key. If the userId doesn't match, the key is deleted, not consumed (see GDPR rule below).
4. **No automatic write on every keystroke.** sessionStorage is written only on `auth.expired` — not as the user types. This avoids both performance overhead and stale-draft accumulation.

**🔒 GDPR / shared-terminal privacy rule (mandatory).** `sessionStorage` is per-tab, not per-user — without scoping, a draft visitor's PII (name, ID number, license plate, host) survives sign-out and is visible to the next user on a shared front-desk terminal. The protections:

1. **All draft keys are user-scoped:** `prequest:draft:${userId}:${route}:${formId}`. The `userId` segment is the Supabase user UUID at the time of write.
2. **On every Supabase `onAuthStateChange` event** (sign-in, sign-out, refresh that produces a different user), an `AuthProvider` listener iterates `sessionStorage` keys matching `prequest:draft:*` and **deletes any whose `userId` segment doesn't match the current session's user**. Sign-out → all draft keys are wiped (no current user). Sign-in as user B → user A's drafts are wiped before B's session begins.
3. **Rehydrate guard:** the form's `useEffect` rehydrating from sessionStorage MUST verify the key's `userId` matches the current user; mismatched keys are deleted, not consumed.
4. **No PII in `localStorage`** — sessionStorage is the floor, not the ceiling. Use `localStorage` only for the kiosk visitor surface (no logged-in user; see "Kiosk surface" below) where a per-device TTL is the protection.

This is a GDPR control, not just UX: the receptionist persona is the trigger, but every shared-terminal scenario in the platform falls under the same rule.

**Kiosk surface (visitor self-check-in).** The kiosk has no logged-in user, so the user-scoped sessionStorage rule above doesn't apply. The kiosk visitor form preserves its draft to `localStorage` under a key `prequest:kiosk-draft:${kioskId}:${formId}` with a **5-minute TTL** auto-purge — i.e. the rehydrate path checks `Date.now() - lastWriteAt < 300_000` and deletes the key otherwise. PII never persists past 5 minutes on a public-facing surface; the visitor's expected session is well under that.

**Non-RHF surfaces (workflow editor, routing studio).** React Flow graphs hold their state in Zustand / local reducer, not in RHF. `getValues()` returns nothing meaningful. These surfaces register a `getDraftSnapshot(): unknown` callback with the `AuthProvider`'s draft registry on mount. On hard-401, the auth flow calls each registered snapshot fn; the returned object is JSON-stringified and stored under the same user-scoped sessionStorage key shape. On rehydrate, the surface's `restoreDraftSnapshot(snapshot)` callback is invoked. If a non-RHF surface doesn't register, the draft is lost — explicitly accept that path, don't silently lose state.

**Refresh-loop bail rule (mandatory).** A dead refresh token surfaces a 401 on every subsequent request. If the AuthProvider re-attempts to read the session after the redirect (or if a third-party tab races the sign-in), the user can land in a tight 401 → redirect → 401 loop with the URL never settling.

The rule: `apiFetch` tracks consecutive `auth.expired` 401s in a single rolling 10-second window via a module-scoped counter (`Map<sessionId, { count, firstAt }>`). **The silent-retry path (above) does NOT increment the counter on the initial 401** — it only increments when the *retry's* response is also a 401, and only when the Supabase client reports the same session both before and after the retry (i.e. no refresh actually happened, so the token is genuinely dead). This avoids double-counting one user-facing call. Initial 401s that successfully retry do not contribute to the counter.

On the **3rd** consecutive `auth.expired` within 10s (where each strike is a request that the silent-retry path could not rescue):

1. Hard-clear the Supabase session (`supabase.auth.signOut({ scope: 'local' })`).
2. Clear all React Query caches.
3. Replace history with `/sign-in?error=session_lost` (no `next=`; the next URL itself may be the trigger).
4. The sign-in page renders an explicit "Your session ended unexpectedly. Sign in again." banner — distinct from the normal sign-in copy — so the user knows what happened.

The counter resets on any 2xx response or after 10 seconds idle.

### 6.3 Stale conflict resolution (v1)

When a mutation hits `409 conflict` with `serverVersion` + `clientVersion`:
1. Renderer surfaces a toast: `"<Thing> was changed by someone else"` (e.g. "This webhook was changed by someone else"), with two actions:
   - `[Copy my changes]` — `kind: 'copyDraft'` recovery; serializes the current form state (`form.getValues()`) as JSON or human-readable markdown to the clipboard, then closes the toast. The user can paste their work into the reloaded form.
   - `[Reload]` — `kind: 'reload'` recovery; re-fetches via React Query's `invalidateQueries` and resets the form.
2. Toast duration is doubled (12s) so the user has time to choose.
3. If the user dismisses without choosing, the mutation stays failed (no auto-reload) — destructive default is wrong here.

**Why both actions:** for a Facilities Admin who has 30 minutes of edits open in a routing rule editor, `[Reload]` alone destroys the work. `[Copy my changes]` is the lifeline — paste into the freshly-reloaded form and re-apply. Cheap UX, prevents catastrophic loss until v2 ships a real merge UI.

**Deferred to v2** — the modal with `[Use theirs] [Keep mine] [Show diff]` and forced `If-Match` re-submit. The wire shape (§3.1) ships `serverVersion` + `clientVersion` now so v2 can land without breaking the contract. The trigger to revisit: a concrete admin surface with measured concurrent-edit collisions where the toast-then-redo flow is shown to be high-friction.

### 6.4 Optimistic rollback animation

The caller owns the `onMutate` / rollback path (see §3.5 shape C). `handleMutationError` ships an opt-in animation step:

1. Caller restores previous state inside its own `onError` (using `ctx.prev` from `onMutate`).
2. Caller passes `rollbackExplain: 'We undid your change'` to `handleMutationError`.
3. The helper renders a toast with that prefix + the classified message, duration 6s, `Retry` action wired to the caller's mutation.

The animation itself (smooth revert, not a flicker) is the **caller's** responsibility and is enabled by passing the previous and current values through a shared `useTransition` / `view-transition` wrapper — documented as a recipe, not enforced. Silent reverts are still banned: callers must pass `rollbackExplain` if the rollback is user-visible.

### 6.5 Internationalization

`messages.nl.ts` ships in v1 alongside `messages.en.ts`. Codes that don't exist in the active locale fall back to English, then to the generic `unknown.server_error` copy (per fail-closed). The server `detail` is **never** rendered to a user (decision #9). Untranslated codes show up in dev console; CI fails if any code in `@prequest/shared` is missing from `messages.en.ts` and warns (not fails) when `messages.nl.ts` lacks coverage.

**Translation discipline (mandatory).** Dutch translations are the responsibility of the engineer adding the code — they cannot be hand-waved to "translate later." Two rules:

1. **Translate the *operational consequence*, not the English copy.** `routing.no_match` should not be "Kon ticket niet versturen" (literal: "Couldn't send ticket"); it should be "Kon geen team vinden voor dit ticket" (operational: "Couldn't find a team for this ticket"). The receptionist or facilities admin reading the message needs to know what happened, not what the original English said.
2. **Native-NL review is required before merge.** The engineer drafts a Dutch message; a native Dutch speaker on the team reviews. Until a designated native reviewer exists on the team, the rule is: any Dutch message merged unreviewed must include a `// TODO(translation): native NL review pending` comment so the linter can flag it. CI lint warns on these comments older than 14 days.

Adding new locales beyond `en` + `nl` is a separate decision; the registry supports `messages.<locale>.ts` arbitrarily but the spec only mandates en + nl for v1.

### 6.6 Accessibility (mandatory)

The error system spans toasts, banners, inline field errors, and full-page replacements — every one of which must work for keyboard and screen-reader users. The platform sells into Benelux including public-sector tenants where WCAG 2.1 AA is a procurement floor; this is non-negotiable.

The rules:

- **Toasts are `role="alert"` + `aria-live="assertive"`.** Sonner ships with this default; the renderer must not override it. A toast that fires must announce immediately to assistive tech.
- **`<FieldError>` is `role="alert"` + `aria-live="polite"`.** Per-field validation errors announce to a screen reader without interrupting current speech. RHF doesn't add this for free — the shadcn `<FieldError>` primitive in `apps/web/src/components/ui/field.tsx` must include the attributes; verify before merging Wave 1.
- **`scrollFirstErrorIntoView()` (decision #11) sets DOM focus on the offending input** in addition to scrolling. Focus is the screen-reader cue; scroll is the visual cue. Both fire.
- **The 500ms ring animation respects `prefers-reduced-motion: reduce`.** The global `index.css` rule clamps every animation/transition to 0.001ms under that media query; the ring uses `transition-timing-function: var(--ease-snap)` so it inherits the clamp. Verify with axe / a manual setting check before Wave 1 ships.
- **`RouteErrorBoundary` page replacement moves DOM focus to the page heading.** When the boundary swaps the page tree, focus is otherwise lost — screen-reader users hear nothing about the new content. The boundary's `componentDidMount` (or `useEffect`-equivalent in a render-once swap) calls `headingRef.current?.focus()`; the page template's `<h1>` carries `tabIndex={-1}` to make it programmatically focusable without becoming a tab stop.
- **The realtime status dot announces transitions to a polite live region.** A visually-hidden `<span aria-live="polite">` adjacent to the dot reads "Reconnecting" / "Connection lost — write actions disabled" / "Reconnected" when state transitions. Otherwise sighted users see the dot change but SR users miss it entirely.
- **TraceId chips are `<button>` not `<span>`.** Click-to-copy is a button action, must be reachable by keyboard, must announce "Copy trace ID" via `aria-label`.
- **Bulk partial-success "Show me" expanding list is a `<details>` / `<summary>` pair** so it works with native keyboard expansion (Enter/Space) and announces collapsed/expanded state to SR.

The Wave 0 + Wave 1 implementation MUST pass an automated `axe-core` scan plus a manual VoiceOver/NVDA walk through one error from each class before either wave can be marked done. Add to §11 success criteria.

This is incremental. Nothing breaks on day one.

**Wave 0 — Foundation (mostly invisible UX change)** — ~5 days
- **Body-shape audit + shim FIRST.** Today some call sites read `error.body` / `error.details` directly. Confirmed consumer: `apps/web/src/components/booking-composer/helpers.ts:67-83` (`extractAlternatives`) reads `error.details.alternatives` from 409 conflict bodies. There may be a small number of others — `grep -rn "error\.\(body\|details\)" apps/web/src --include="*.ts" --include="*.tsx"` is the audit. The filter ships in two phases:
  - **0a (shim):** the new `AllExceptionsFilter` writes the new wire shape AND preserves any pre-existing top-level keys legacy consumers rely on (`alternatives`, etc.) at the root level for one release. The filter logs whenever a request hits the legacy-shim branch so we can confirm the consumer set is empty before phase 0b.
  - **0b (cutover):** once the audit + shim usage logs confirm zero legacy reads in a 1-week window, drop the shim and ship the clean wire shape.
- Ship request-id middleware (`apps/api/src/common/middleware/request-id.middleware.ts`): reads `X-Request-Id` from inbound, generates ULID-prefixed `req_<ulid>` if missing, attaches to `req.id`, sets response header.
- Ship logger enrichment so every log line includes `traceId` (extend the existing Nest `Logger` adapter; no new logging system).
- Ship `AllExceptionsFilter` server-side with `normalize()` covering AppError / HttpException / ZodError / Postgrest / pg-native / AbortError / unknown.
- Ship `AppError` + factory module + ESLint guard against bare `throw new Error(...)` outside the factory.
- Ship `ApiError` client extensions (typed accessors for `code`, `traceId`, `fields`, etc.) + read `X-Request-Id` from every response.
- **Visible result:** every error now has a traceId in the body and in server logs. The booking-composer 409 alternatives flow continues to work (via the shim). Nothing else changes user-visibly.

**Wave 1 — Classifier + 3 surfaces + form-draft v1** — ~7-8 days
- Ship `classify()` + `ClassifiedError` types + tests.
- Ship `handleMutationError` + `withErrorHandling` + `handleQueryError` helpers.
- Ship 3 renderers: toast, inline (FieldError integration), banner. **Banner is scoped to `transport`-class only in Wave 1** — the banner UI mounts and listens to a transport-only state (offline / online). Realtime aggregation is added in Wave 3 once the `RealtimeStatusStore` exists; the same banner component then accepts a second source.
- Wire `apiFetch` mid-call session-refresh retry (§6.2).
- **Migrate the Zod sites that back the 5 highest-traffic mutations to `throwZodError`** in lockstep — the helper's `setFormError` integration depends on `fields[]` being present, and that requires the Zod migration described in §3.2 to land *for these 5 endpoints* in Wave 1. The remaining controllers stay on the old `formatZodError` string until Wave 4; their validation errors surface as a single whole-form toast in the meantime (no field-level inline display).
- Migrate the 5 highest-traffic mutations behind a feature flag; verify voice rule preserved.
- Ship the **form-draft preservation v1 mechanism** (per §6.2): user-scoped sessionStorage key shape, `useDraftRehydrate` hook, `AuthProvider`-driven cleanup of mismatched-userId keys on auth state change, kiosk localStorage TTL purge job. Wire into the four surfaces named in §6.2 (visitor forms / ticket forms / booking-composer / dirty admin forms).
- Ship the **phase-signal Zustand store** + `useMutationStatus` hook + `<Button mutation>` prop extension (per §6.2 pending-state UX).
- Ship the **scroll-to-error / focus / 500ms ring** infrastructure (per decision #11 + §6.6) — `scrollFirstErrorIntoView()` helper + `data-error-flash` attribute + axe scan in CI.
- Ship the **bulk partial-success toast** + expanding inline list rendering (per §3.1).
- **Visible result:** validation errors on the 5 migrated endpoints paint inline (with scroll/focus/ring); everything else still toasts whole-form. Offline shows a banner; toasts for everything else look mostly the same but now have traceId. Form drafts survive auth.expired on every v1 surface. Saves past 600ms on a refresh-retry path show "Saving… (signing back in)".

**Wave 2 — Page-level surfaces** — ~5 days
- Ship `RouteErrorBoundary` (class component) + `throwToBoundary` context bridge.
- Wrap each top-level route element with the boundary (single edit per route in `App.tsx`).
- Ship 404-with-`reason` / 403 / 5xx page templates, all wrapped in `SettingsPageShell` + `SettingsPageHeader` (width `default`) for back-nav uniformity. 404 page branches on `body.reason ∈ ('missing','removed','hidden')` — `'hidden'` renders the same copy as `'missing'` (security control per decision #6.1; the distinction is server-side-only).
- Migrate top-traffic queries to call `throwToBoundary()` for page-class errors.
- **Visible result:** broken pages now show real page state instead of stale content + toast.

**Wave 2 explicitly does NOT migrate the route tree to a data router.** That migration (`createBrowserRouter` + loaders/actions) is a separate decision; it's a multi-day refactor across 131+ routes and is out of scope here.

**Wave 3 — Recovery polish + realtime** — ~5 days
- Realtime status store + listener wiring (no central store today; three call sites manage their own channels).
- Rate-limit live countdown.
- Optimistic-rollback animation recipe (caller composes; documented).
- Render-error boundary per route (already shipped in Wave 2 — this is the polish pass).
- 401 refresh-loop bail rule.
- Form-draft preservation polish — non-RHF `getDraftSnapshot()` registry, kiosk localStorage TTL purge job, and the v1 form-draft preservation paths are already shipped earlier (Wave 1). This Wave-3 line refers to **the cross-surface coordination** (notifying the user about discarded drafts on rehydrate, animating draft restoration, telemetry on rehydrate hits/misses).
- **Visible result:** every error has an actionable next step; the platform feels "smart" when things go wrong.

**Wave 4 — Backfill + Dutch** — ~3 days, can run in parallel with Wave 3
- Migrate the next 30 highest-traffic throw sites to coded `AppError`.
- Migrate every `safeParse` call site to throw `AppError` via `throwZodError` (Zod migration — see §3.2).
- Ship `messages.nl.ts` for the registered code set.
- Add CI guard that fails the build if a registered code lacks an English message; warn on production-log codes that aren't registered.
- Document the spec under `docs/error-handling.md` (operational ref, like `docs/visibility.md`).

**Total: ~26-28 working days (~5-6 weeks) for one engineer.** Waves 0+1 alone (~12-13 days) eliminate the bulk of the user-visible badness AND the GDPR-relevant form-draft preservation; the rest is the discipline that makes the system stay good. The realignment from the original 13-day estimate captures: greenfield traceId infra (Wave 0), Zod migration in lockstep with Wave 1, form-draft preservation promoted to v1, phase-signal wiring + button extension, scroll-to-error infra, axe + manual SR walk in success criteria, 86 throw-site lint phasing, and the realtime store + page-header placement.

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
| Engineers throw `new Error('something')` and skip `AppError` | High | Three layers, phased: (a) **Wave 0 ships the ESLint rule as `'warn'` only** — turning it on as `'error'` day-one would block CI immediately because there are ~86 `throw new Error(...)` sites in `apps/api/src` today (verify with `grep -rn "throw new Error" apps/api/src --include="*.ts" \| wc -l`). Warn-only surfaces the violations in IDE + CI logs without blocking merges. (b) **Each Wave migrates a tranche** — Wave 0 migrates 0–10 (alongside the new factory), Wave 4 migrates the next 30 highest-traffic per the existing plan, and the residual ~46 sites get tracked as a follow-on cleanup ticket. (c) **Wave 4 promotes the rule to `'error'`** once the residual count is in single digits, with a per-file `// eslint-disable-next-line errors/no-bare-throw` allowlist for any remaining holdouts that need one more PR to retire. (d) **Runtime audit** — when `normalize()` hits the `unknown` branch on an `Error` instance with no `code` property, log a structured `error_normalize_unknown` line with the request URL, error message, and stack frame so we can find missing migrations even when the throw happens in a dependency, generated code, or a path the linter can't see. The runtime audit is the safety net for everything the lint can't see. |
| Filter normalises a sensitive error (e.g. JWT secret in stack) into the response | Low if reviewed; catastrophic if missed | Filter strips `cause` from response body (kept in logs only). Test for it. |

## 10 · Open questions

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Do we want a dedicated `docs.prequest.app/errors/<code>` site, or just inline help text? | Inline help only for v1; build docs site if support volume justifies it. |
| 2 | Should `traceId` be visible to all users or only operators? | Tiered (per decision #10): visible by default for `server`-class + page-replacement; hidden behind "Show details" for toasts on other classes for non-operator personas. Operator personas see it always. |
| 3 | When a 5xx happens, do we surface a 'Report this' dialog (Sentry-style) or just a toast? | Toast for action-class 5xx; route-class 5xx replaces the page (decision #15). Both expose copy-traceId-to-clipboard + plain-text support email and phone. No mailto, no modal. Revisit if support volume warrants. |
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
- An automated `axe-core` scan of every error surface returns zero violations; a manual VoiceOver/NVDA walk of one error from each of the 11 classes confirms the announcement and focus rules in §6.6.

When all eight hold, we have an error system that's better than every product in the FMIS market and competitive with the best products outside it.
