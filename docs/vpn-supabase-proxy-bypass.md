# VPN ↔ Supabase proxy bypass — dev-only workaround

**Status:** dev-only workaround, NOT production architecture.
**Scope:** applies when developing this project from a network whose egress IP gets blocked at Cloudflare's edge for the project's Supabase zone — e.g. commercial VPNs, certain corporate VPNs, certain ISP routing paths. **Anonymised as "VPN" throughout** — the same mechanism applies regardless of which VPN you're on.
**Last updated:** 2026-05-13.

## The problem this solves

Cloudflare fronts each Supabase project's HTTPS gateway (`<project-ref>.supabase.co`). For some zones, Cloudflare drops TCP SYNs from known commercial-VPN IP ranges and from certain ISP routes that resolve to specific Cloudflare anycast IPs (`104.16.0.0/12` in the failure case observed for this project). The behaviour is observable as **TCP timeout at connect**, not an HTTP error.

Other Cloudflare-hosted destinations remain reachable (`1.1.1.1`, `discord.com`, `*.workers.dev`), so it's NOT a wholesale "Cloudflare blocks this VPN" problem — it's per-zone configuration. Supabase has officially acknowledged this affects some users (see https://akhilraaaj.medium.com/how-i-fixed-the-supabase-connectivity-issue-for-indian-users-662f69b079a4 for a public write-up).

Symptoms when triggered:
- Browser hangs on `supabase.auth.refreshSession()` → user stuck on "loading" screen.
- API auto-startup tasks fail: `TypeError: fetch failed`, `WorkflowWaitSweeperCron: candidates_failed`.
- `<img src="https://<project-ref>.supabase.co/storage/...">` images don't load.
- Supabase Realtime channels never connect (silent — bell badge, scheduler live updates, etc.).
- Postgres direct (port 5432) is **not** affected — that endpoint resolves to a different IP range than the HTTPS gateway.

## Architecture

```
                            ┌──────────────────────────────────────────┐
                            │  Browser (inside VPN tunnel)             │
                            └────────────┬─────────────────────────────┘
                                         │   HTTPS  +  WebSocket
                                         ▼
                            ┌──────────────────────────────────────────┐
                            │  Cloudflare Worker proxy                 │
                            │  https://<worker-subdomain>.workers.dev  │
                            │  Allowlists /auth/v1, /rest/v1,          │
                            │  /realtime/v1, /storage/v1               │
                            │  WebSocket-aware (Realtime works)        │
                            └────────────┬─────────────────────────────┘
                                         │   Cloudflare-internal
                                         ▼
                            ┌──────────────────────────────────────────┐
                            │  Real Supabase HTTPS gateway             │
                            │  https://<project-ref>.supabase.co       │
                            └──────────────────────────────────────────┘

                            ┌──────────────────────────────────────────┐
                            │  NestJS API Postgres pool                │
                            │  (inside VPN tunnel)                     │
                            └────────────┬─────────────────────────────┘
                                         │   TCP 5432 — not blocked
                                         ▼
                            ┌──────────────────────────────────────────┐
                            │  Real Supabase Postgres host             │
                            │  db.<project-ref>.supabase.co:5432       │
                            └──────────────────────────────────────────┘
```

Three pieces make this work:

1. **A Cloudflare Worker** at `<name>.<account>.workers.dev` transparently reverse-proxies to the real Supabase host. Allowlisted to four Supabase service paths (no general open-proxy surface). WebSocket-aware so Realtime works.

2. **Frontend `.env` swap** points `VITE_SUPABASE_URL` (frontend) and `SUPABASE_URL` (API's supabase-js calls) at the Worker.

3. **`PG_HOST` env pin** keeps the API's direct Postgres connection on the real Supabase host (the Postgres endpoint isn't VPN-blocked; only the HTTPS gateway is). A startup guard in `db.service.ts` fails loud if `SUPABASE_URL` is non-Supabase AND `PG_HOST` is unset.

## Generic + maintainable contract — TL;DR

The only code surface anyone needs to know:

```ts
import { rewriteSupabaseUrl } from '@/lib/rewrite-supabase-url';
```

**One helper, applied at three choke points** so most components don't need to know about this at all. Use one of these first; only leaf-wrap when there's no choke point:

| Surface | Choke point | What's automatic |
|---|---|---|
| Space / room images | `lib/image.ts` (`spaceImageThumbnail`, `spaceImagePreview`) | Every room/space image renderer |
| Branding (logo, favicon, hero) | `hooks/use-branding.tsx` (URL fields normalised on every state set) | Every component reading `useBranding()` — incl. tenant-logo |
| Person avatars | `components/person-avatar.tsx` (`<PersonAvatar person={...} />`) | Every PersonAvatar consumer |

If your data flows through any of the above, **do nothing** — rewrite happens automatically.

If you have a one-off URL that doesn't pass through a choke point (a stored absolute URL rendered through raw `<img src>`, `<image href>`, or `background-image: url()`), wrap it explicitly:

```tsx
<img src={rewriteSupabaseUrl(someStoredAbsoluteUrl)} />
<image href={rewriteSupabaseUrl(plan.floor.image_url)} />
<div style={{ backgroundImage: `url("${rewriteSupabaseUrl(item.image_url)}")` }} />
```

**Rules:**
- Browser-side only. Never apply server-side (Node) — emails / notifications go to arbitrary networks and must keep canonical Supabase URLs.
- Helper is a no-op in normal mode (`VITE_SUPABASE_URL` IS the real Supabase URL). Adding it never hurts; leaving it off in proxy mode = broken images.
- If you add a new render site that uses a stored absolute Supabase URL: pick a choke point if one exists; otherwise leaf-wrap and add the site to the inventory below.

## File-by-file changes in this repo

### `apps/api/src/common/db/db.service.ts`

`resolveConnectionString()` rewritten with `parseSupabaseHostname()` (URL API, not regex). Three branches:

- **`SUPABASE_DB_URL` set** → use it directly (full override).
- **`PG_HOST` set** → build `postgresql://postgres:…@<PG_HOST>:<PG_PORT>/postgres`. No derivation from `SUPABASE_URL` needed.
- **Neither set** → require `SUPABASE_URL` to have exact `<project-ref>.supabase.co` shape (3 labels, single label before `.supabase.co`). Rejects `api.supabase.co`, `a.b.supabase.co`, and proxy URLs. Error message names the real fix, not a derived bogus host.

### `apps/web/src/lib/rewrite-supabase-url.ts` — the single helper

Reads `VITE_SUPABASE_URL` at module load, computes `TARGET_ORIGIN` once. Replaces any `https?://<label>.supabase.co` origin in a string with that origin. Returns `undefined` for nullish input. Emits a one-shot `console.warn` in dev when `VITE_SUPABASE_URL` is empty or malformed. TypeScript overloads so call-site types stay tight.

### Three choke points

- **`apps/web/src/lib/image.ts`** — `spaceImageThumbnail` and `spaceImagePreview` pass output through the helper. Every space-image caller inherits.
- **`apps/web/src/hooks/use-branding.tsx`** — added `normalizeBrandingUrls()` applied at every state-set point: `refetch`, `updateBranding`, `uploadLogo`, `removeLogo`, plus `readCached()` init. The `STORAGE_KEY` is namespaced by host so flipping env automatically invalidates the cache. Every `useBranding()` consumer reads already-rewritten URLs.
- **`apps/web/src/components/person-avatar.tsx`** — wraps `person.avatar_url`. Every PersonAvatar consumer is covered.

### Leaf wraps (sites where no choke point fits)

- `apps/web/src/components/portal/portal-category-card.tsx` — `cover_image_url`
- `apps/web/src/components/portal/portal-category-banner.tsx` — `cover_image_url`
- `apps/web/src/components/portal/portal-home-hero.tsx` — `heroUrl`
- `apps/web/src/pages/portal/book-room/components/booking-result-row.tsx` — `room.image_url`
- `apps/web/src/components/booking-composer/service-picker-sheet.tsx` — `item.image_url` (background-image, quoted)
- `apps/web/src/components/portal/portal-account-menu.tsx` — direct `<AvatarImage src=>`
- `apps/web/src/components/portal/portal-request-thread.tsx` — direct `<AvatarImage src=>`
- `apps/web/src/components/entity-picker/adapters/person.tsx` — two direct `<AvatarImage src=>`
- `apps/web/src/pages/portal/profile.tsx` — direct `<AvatarImage src=>`
- `apps/web/src/components/admin/portal/portal-hero-slot.tsx` — admin preview
- `apps/web/src/components/admin/catalog/category-cover-picker.tsx` — admin preview
- `apps/web/src/components/floor-plan/floor-plan-canvas.tsx` — SVG `<image href=>`
- `apps/web/src/pages/kiosk/index.tsx` — kiosk idle screen logo
- `apps/web/src/pages/kiosk/setup.tsx` — kiosk setup URL query params

## Env vars (per-machine, NOT committed)

These changes live in `.env` files which are gitignored. **Two `.env` files in this repo, NOT cross-loaded**:

- `<repo-root>/.env` — read by the NestJS API
- `apps/web/.env` — read by Vite (the frontend)

Vite scopes its env loading to its own working directory (`apps/web/`), so editing only the root `.env` is **not enough** — the frontend will continue to use whatever's in `apps/web/.env`. Common foot-gun.

### Root `.env` (NestJS API)

```
SUPABASE_URL=https://<worker-subdomain>.workers.dev    # WAS https://<project-ref>.supabase.co
PG_HOST=db.<project-ref>.supabase.co                   # NEW — pin Postgres direct to real host
SUPABASE_PUBLISHABLE_KEY=…                              # unchanged
SUPABASE_SECRET_KEY=…                                   # unchanged
SUPABASE_DB_PASS=…                                      # unchanged
SUPABASE_AUTH_HOOK_SECRET=…                             # unchanged
VITE_SUPABASE_URL=https://<worker-subdomain>.workers.dev   # technically unused (Vite reads apps/web/.env) — keep in sync as a safety net
VITE_SUPABASE_PUBLISHABLE_KEY=…                         # unchanged
```

### `apps/web/.env` (Vite frontend)

```
VITE_API_URL=http://localhost:3001
VITE_SUPABASE_URL=https://<worker-subdomain>.workers.dev   # WAS https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=…                         # unchanged
SUPABASE_DB_PASS=…                                      # unchanged (used by some scripts)
```

## The Worker (v3)

Lives on Cloudflare's dashboard (Worker name varies per developer). Deploy via the Cloudflare dashboard editor (no Wrangler / repo dependency).

```js
const SUPABASE_HOST = '<project-ref>.supabase.co';   // hardcoded — Worker only proxies to this one project

const ALLOWED_PREFIXES = [
  '/auth/v1',
  '/rest/v1',
  '/realtime/v1',
  '/storage/v1',
  // '/functions/v1',  // uncomment if Edge Functions are added
];

const STRIP = new Set([
  'cf-connecting-ip',
  'cf-ipcountry',
  'cf-ray',
  'cf-visitor',
  'forwarded',
  'true-client-ip',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-prefix',
  'x-forwarded-proto',
  'x-real-ip',
]);

export default {
  async fetch(request) {
    const incoming = new URL(request.url);

    const allowed = ALLOWED_PREFIXES.some(
      (p) => incoming.pathname === p || incoming.pathname.startsWith(p + '/'),
    );
    if (!allowed) {
      return new Response('Not found', { status: 404 });
    }

    const upstreamUrl = new URL(
      incoming.pathname + incoming.search,
      `https://${SUPABASE_HOST}`,
    );

    const headers = new Headers(request.headers);
    for (const h of STRIP) headers.delete(h);

    const isWebSocketUpgrade =
      request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (isWebSocketUpgrade) {
      // Cloudflare Workers do NOT auto-tunnel WebSocket upgrades through
      // `fetch()`. Explicit relay: forward the upgrade request to the
      // upstream, and if the upstream returns a 101 with a `webSocket`
      // instance on the Response, hand that socket back to the client.
      // Cloudflare bridges both halves transparently — no `accept()`
      // needed because the Worker is relaying, not terminating.
      const upstreamRes = await fetch(upstreamUrl.toString(), {
        method: request.method,
        headers,
      });
      if (upstreamRes.webSocket) {
        return new Response(null, {
          status: 101,
          webSocket: upstreamRes.webSocket,
        });
      }
      return upstreamRes;
    }

    const response = await fetch(upstreamUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('Location');
      if (location && location.startsWith(`https://${SUPABASE_HOST}`)) {
        const rewritten = new Headers(response.headers);
        rewritten.set(
          'Location',
          location.replace(`https://${SUPABASE_HOST}`, `https://${incoming.host}`),
        );
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: rewritten,
        });
      }
    }

    return response;
  },
};
```

## How to set this up on a new dev machine

1. **Decide if you need the proxy at all.** Test first:
   ```bash
   curl --max-time 6 -o /dev/null -w "%{http_code} %{time_total}s\n" \
     https://<project-ref>.supabase.co/auth/v1/health
   ```
   If you get `200` in under 2s, you don't need this — leave `.env` pointed at the real Supabase URL.
   If you get a TCP timeout (curl exit 28), continue.

2. **Confirm Postgres direct still works** (it usually does):
   ```bash
   PGPASSWORD="$(grep -E '^SUPABASE_DB_PASS=' .env | cut -d= -f2-)" \
     psql "postgresql://postgres@db.<project-ref>.supabase.co:5432/postgres?connect_timeout=8" \
     -c "select 1"
   ```

3. **Sign up at https://dash.cloudflare.com** (free) if you don't have an account.

4. **Deploy the Worker via dashboard UI** (no CLI / Wrangler required):
   - Workers & Pages → Create application → Create Worker → name it `sb-dev-proxy`.
   - Deploy the default "Hello World" once, then click "Edit code".
   - Replace the contents with the v3 Worker code above. Update `SUPABASE_HOST` to your project's `<project-ref>.supabase.co`.
   - Deploy. Note the URL: `https://<name>.<your-handle>.workers.dev`.

5. **Smoke-test (HTTP):**
   ```bash
   curl https://<name>.<your-handle>.workers.dev/auth/v1/settings \
     -H "apikey: $(grep -E '^VITE_SUPABASE_PUBLISHABLE_KEY=' apps/web/.env | cut -d= -f2-)" \
     -H "Authorization: Bearer $(grep -E '^VITE_SUPABASE_PUBLISHABLE_KEY=' apps/web/.env | cut -d= -f2-)"
   ```
   Expected: a GoTrue JSON response with auth provider settings. 200 status.

6. **Smoke-test (WebSocket — Realtime):**
   ```bash
   ANON_KEY=<your-anon-key> node --input-type=module -e "
   const url = \`wss://<name>.<your-handle>.workers.dev/realtime/v1/websocket?apikey=\${process.env.ANON_KEY}&vsn=1.0.0\`;
   const ws = new WebSocket(url);
   ws.onopen = () => { console.log('OPEN'); ws.send(JSON.stringify({topic:'realtime:lobby',event:'phx_join',payload:{},ref:'1'})); };
   ws.onmessage = (e) => { console.log('MSG:', e.data.toString()); process.exit(0); };
   setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 8000);
   "
   ```
   Expected: `OPEN`, then a `phx_reply` message from Supabase Realtime within ~800ms.

7. **Update both `.env` files** as described above. Don't forget `PG_HOST`. **Don't forget the frontend reads `apps/web/.env`, not root.**

8. **Restart `pnpm dev`** so both apps re-read env. Browser **hard reload** (Cmd+Shift+R) — Vite inlines `import.meta.env.VITE_*` so stale bundles persist URLs.

## How to revert (back to direct Supabase)

When you're off the blocked network, revert all three env values:

```
SUPABASE_URL=https://<project-ref>.supabase.co
# remove PG_HOST line (or leave it — it's redundant but harmless)
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
```

Restart `pnpm dev` and hard-reload the browser.

**`rewriteSupabaseUrl` becomes a no-op automatically** (the regex matches the real Supabase URL → replaces with itself). The `STORAGE_KEY` for branding is host-scoped, so the old cached branding doesn't leak. No frontend code change needed.

## Open gotchas — read before touching anything

### 1. Storage write paths bake the proxy URL into DB rows

Any code that calls `supabase.storage.from(...).getPublicUrl()` while in proxy mode and stores the return value will persist `https://<worker-subdomain>.workers.dev/storage/...` into the row. That URL is **specific to whoever happened to be developing at that moment** and will break for everyone else, including production.

Mitigations, in order of preference:
- **Best:** store only the storage *path*, resolve at render via supabase-js. Future refactor — not done.
- **Acceptable:** before committing/pushing changes that write storage URLs, run a SQL one-shot. Two shapes — text columns and JSONB columns — both need fixing:

  **Text columns** (simple `replace()`):
  ```sql
  update service_catalog_categories
     set cover_image_url = replace(cover_image_url,
                                   'https://<worker-subdomain>.workers.dev',
                                   'https://<project-ref>.supabase.co')
   where cover_image_url like 'https://<worker-subdomain>.workers.dev%';

  update portal_appearance
     set hero_image_url = replace(hero_image_url,
                                  'https://<worker-subdomain>.workers.dev',
                                  'https://<project-ref>.supabase.co')
   where hero_image_url like 'https://<worker-subdomain>.workers.dev%';

  update catalog_items
     set image_url = replace(image_url,
                             'https://<worker-subdomain>.workers.dev',
                             'https://<project-ref>.supabase.co')
   where image_url like 'https://<worker-subdomain>.workers.dev%';

  update persons
     set avatar_url = replace(avatar_url,
                              'https://<worker-subdomain>.workers.dev',
                              'https://<project-ref>.supabase.co')
   where avatar_url like 'https://<worker-subdomain>.workers.dev%';

  update floor_plans
     set image_url = replace(image_url,
                             'https://<worker-subdomain>.workers.dev',
                             'https://<project-ref>.supabase.co')
   where image_url like 'https://<worker-subdomain>.workers.dev%';
  ```

  **JSONB columns** (rewrite via cast through text):
  ```sql
  -- tenants.branding is JSONB; logo_light_url / logo_dark_url / favicon_url live inside it.
  update tenants
     set branding = replace(
           branding::text,
           'https://<worker-subdomain>.workers.dev',
           'https://<project-ref>.supabase.co'
         )::jsonb
   where branding::text like '%<worker-subdomain>.workers.dev%';

  -- spaces.attributes is JSONB; image_url lives inside it.
  update spaces
     set attributes = replace(
           attributes::text,
           'https://<worker-subdomain>.workers.dev',
           'https://<project-ref>.supabase.co'
         )::jsonb
   where attributes::text like '%<worker-subdomain>.workers.dev%';
  ```

### 2. Auth flows that issue redirects / emails

The Worker rewrites `Location:` headers in 3xx responses. This is fine for synchronous password login.

It's **NOT fine** for:
- **Magic-link email:** Supabase Auth builds callback URLs from the project URL or the configured "Site URL". If "Site URL" / "Redirect URLs" in the Supabase Auth dashboard point at the worker, real users on real networks get emails with worker-URL links — broken outside dev.
- **OAuth (Google/GitHub/etc.):** the `redirect_uri` registered with the identity provider must match exactly. If you set it to the worker URL, OAuth callbacks for production users break.

**Don't use magic-link or OAuth flows while in proxy mode.** If you must: keep Supabase Auth dashboard "Site URL" / "Redirect URLs" pointed at the real frontend URL (localhost or production), never at the worker.

### 3. Worker has no auth gate

The worker is publicly reachable. Anyone who finds the URL can hit it with the project's anon key (which is public anyway via the frontend bundle). Anon-key signup/signin is rate-limited per source IP by Supabase. All proxy traffic arrives from Cloudflare edge IPs → one source → rate limiter sees one client. Free-tier Worker quota: 100,000 requests/day.

Mitigations if abuse becomes real:
- Cloudflare Access policy on the Worker route.
- Cloudflare WAF rule restricting source ASN.
- **Do NOT add a shared-secret header in `VITE_*` env** — it would leak into the public browser bundle.

### 4. Server-side code must NOT apply the rewrite

`apps/api/src/modules/visitors/templates/visitor-emails.ts:147` and any other server-side template that embeds a stored absolute URL **must NOT call `rewriteSupabaseUrl`**. Emails go to arbitrary networks; they must use canonical Supabase URLs.

The helper is browser-only by design (lives in `apps/web`). Adding it to a Node-side template is a regression.

### 5. The architecture could be simpler

The split-brain `SUPABASE_URL` vs `PG_HOST` exists because we swap `SUPABASE_URL` on the API as well as the frontend. The API's NestJS process runs on the same VPN'd machine, so its outbound `fetch` calls ALSO get blocked when hitting `<project-ref>.supabase.co`. Server-side calls (e.g. `OutboxWorker`, `WorkflowWaitSweeperCron`, `BookingNotificationsService`) need the worker just as much as the browser does. Reverting the server-side swap would re-break those tasks.

If/when the API runs on different infra (Vercel, a real VPS, anywhere outside the VPN), the swap can stay browser-only and `PG_HOST` can go.

## Production posture

This setup is **dev-only**. None of these changes should ship to production:
- Production users are not behind a VPN with this block.
- The Worker is a single point of failure for the project (if it goes down, all dev clients break).
- A custom domain (e.g. `api.<your-domain>` with Cloudflare proxy DNS) would be the equivalent setup for production, if Supabase reachability via the real domain ever proves unreliable for real users. See the Medium write-up linked at the top for that pattern.

When promoting to production:
- Revert all env files to the real Supabase URL.
- Confirm `rewriteSupabaseUrl` becomes a no-op (which it will).
- Remove `PG_HOST` if you want, or leave it for ops flexibility.
- Run the SQL one-shots from §1 above to clean any worker-URLs baked into rows during dev.

## Related work

- **Codex pre-shipped recommendations** integrated into the Worker code: path allowlist, header stripping, redirect rewriting, removed redundant `Host` set, explicit WebSocket upgrade relay.
- **`PG_HOST` startup guard** in `db.service.ts` was also a codex recommendation. Uses `URL.hostname` (not regex) and requires exact `<project-ref>.supabase.co` shape — rejects `api.supabase.co`, `a.b.supabase.co`, etc.
- **Full-review + two codex-review passes** identified all the render sites consolidated above. The choke-point architecture (3 helpers/hooks/components) eliminates whack-a-mole for future contributors.
- **WebSocket relay empirically smoke-tested** through the v3 Worker: Phoenix `phx_join` → `phx_reply` round-trip in 788ms via Mullvad NL exit.

## What this doc deliberately does NOT cover

- How to set up a production custom-domain proxy. That's a different doc when the time comes.
- How to migrate stored absolute URLs to path-only storage. That's a future refactor.
- How to add explicit IP/origin allow-listing to the Worker. Not needed for dev; document if it becomes needed.
