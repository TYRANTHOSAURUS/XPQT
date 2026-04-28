# Vendor Portal Phase B — Sprint 4 + 5 follow-ups

**Status when this file was written (2026-04-28):** Mail-delivery substrate (Resend EU adapter + Svix-signed webhook receiver + attachment-first daily-list dispatch) shipped through 2 codex review rounds (commits `3b0520c` → `fd1815b` → `4f92288`). 72/72 backend suites pass (594 tests). Migration `00183` on remote.

**Pending here:** the rest of vendor-portal Sprint 4 (email + webhook on order create + PWA shell) plus all of Sprint 5 (internal team variant), plus a codex round-3 verification that's blocked on usage-limit reset.

Spec: [`docs/superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md`](../superpowers/specs/2026-04-27-vendor-portal-phase-b-design.md) §7, §8, §15.

---

## A. Codex round-3 verification of mail substrate (BLOCKING)

**Why blocking:** the mail substrate (commits `3b0520c`, `fd1815b`, `4f92288`) ate 3 codex review rounds, the third one couldn't run because we hit the usage limit at 22:40 on 2026-04-28. Round-2 fixes are surgical + tested but not externally verified.

When usage resets (~02:40 next day or later):

```bash
codex exec --full-auto -C /Users/x/Desktop/XPQT "$(cat /tmp/codex-mail-r3.txt)"
```

The prompt should ask codex to verify each round-2 fix matches Resend's documented payloads (it has docs context cached): tags-object correlation, conditional linkSection, display-name escape, `data.failed.reason`, TitleCase bounce subtypes, top-level `ev.created_at`. Plus any NEW issues round-2 introduced.

**Acceptance:** codex APPROVE / APPROVE-WITH-CHANGES → proceed. REJECT → fix flagged issues, run again.

---

## B. Wire VendorMailer onto the shared MailProvider

**Where it stands:** `apps/api/src/modules/vendor-portal/vendor-mailer.service.ts` still ships only `LoggingVendorMailer`. The spec requires real magic-link delivery for production.

**Tasks:**
1. New `ResendVendorMailer` (or rename to `ProviderVendorMailer`) that injects `MAIL_PROVIDER`.
2. `sendMagicLink` builds a `MailMessage`:
   - `subject`: `"Sign in to {vendor.name} on Prequest"` (NL/FR/EN per Sprint 4 i18n).
   - `textBody`: short body with the magic-link URL + 30-min expiry note + "If you didn't request this, ignore" line.
   - `tags`: `{ entity_type: 'vendor_user_magic_link', vendor_user_id, vendor_id, reason }`.
   - `idempotencyKey`: `vendor_magic_link:<vendor_user_id>:<reason>:<token_hash_prefix>` — stable per token (we don't want to dedupe across re-issues for the same user).
   - No attachment.
3. Update `vendor-portal.module.ts`:
   - Import `MailModule`.
   - Bind `VENDOR_MAILER` to the new provider class.
   - Keep `LoggingVendorMailer` registered for tests (let tests provide it explicitly).
4. Webhook correlation: extend `mail-webhook.controller.ts:correlate()` to handle `entity_type === 'vendor_user_magic_link'`. Today only `vendor_daily_list` is correlated; magic-link delivery state is currently informational.
   - To correlate magic-link bounces, we need a stable id in tags. We already pass `vendor_user_id`. The receiver should write `correlated_entity_type='vendor_user_magic_link'` + `correlated_entity_id=vendor_user_id` into `email_delivery_events` even though there's no per-row state to update. This gives ops a per-vendor-user delivery audit trail.
   - Optional: add a `vendor_users.last_email_status` text column (delivered / bounced / complained) updated by the webhook so the admin "Vendor users" page can flag bouncing addresses.

**Acceptance:**
- Inviting a vendor user via `POST /admin/vendors/:id/users` actually delivers an email (with `RESEND_API_KEY` set in `.env`).
- Bouncing the magic-link email writes a row to `email_delivery_events` with `correlated_entity_type='vendor_user_magic_link'`.
- Tests cover `ResendVendorMailer.sendMagicLink` building the right `MailMessage` shape (mock the `MailProvider`).

**Estimate:** ~half a day including tests + codex review.

---

## C. Per-order email on order create (portal/hybrid vendors)

Spec §7. Vendors with `fulfillment_mode IN ('portal','hybrid')` should get an email when a new order is created against them, with a deep link to `/vendor/orders/:id`.

**Tasks:**
1. New `VendorNotificationService` in `apps/api/src/modules/vendor-portal/`:
   - `notifyOrderCreated(args: { tenantId, vendorId, orderId })` — async, called from the orders create flow OR a Postgres listen/notify hook.
2. Hook into the orders pipeline:
   - When an `order_line_items` row is inserted with `vendor_id` set AND that vendor's `fulfillment_mode` is `portal` or `hybrid`, schedule a notification.
   - Best mechanism: a Postgres trigger that writes to `vendor_notification_outbox` (new table); a worker drains the outbox + calls the mailer. This decouples the order-create transaction from mail-provider latency and gives us retry semantics for free.
   - Migration: `vendor_notification_outbox` table + insertion trigger.
3. Email body (per spec §7):
   - Subject: `"New order · {service_type} · {delivery_time} · {building}"`.
   - Body: date, time, location, headcount, "View in portal" CTA → `${VENDOR_PORTAL_BASE_URL}/vendor/orders/${order_id}`.
   - **No PII beyond what the portal already shows** (per spec). First-name-only requester at most.
   - Tags: `{ entity_type: 'vendor_order_email', order_id, vendor_id }`.
   - Idempotency key: `vendor_order_email:<order_id>` — stable so bursty edits don't fan out duplicate emails.
4. Internationalisation: i18n strings bundle (NL/FR/EN) — pattern matches `daily-list/templates/strings.ts`.
5. Audit: emit `vendor.order_email_dispatched` from the worker on success and `vendor.order_email_failed` on permanent failure.

**Acceptance:**
- Creating an order against a portal-mode vendor results in one email landing in the vendor's inbox within ~1 min.
- Spec test: `VendorNotificationService.notifyOrderCreated` builds the right `MailMessage` for each fulfillment mode (portal → email; hybrid → email + the daglijst flow keeps running; paper_only → skip — daglijst already covers them).
- The outbox-drain worker tolerates Resend rate limiting (retries with backoff).

**Estimate:** 1 day (table + trigger + service + worker + tests + codex review).

---

## D. Vendor webhook channel

Spec §7. Vendors with `webhook_url` configured should get a signed POST on order create.

**Tasks:**
1. Migration is partly done (`vendors.webhook_url` + `vendors.webhook_secret_encrypted` exist per spec §3 line 200). Confirm + add if missing.
2. New `VendorWebhookService`:
   - `dispatchOrderCreated(args)` — POSTs `{event: 'order.created', tenant_id, vendor_id, order_id, delivery_at, delivery_location, lines, headcount}` to `vendor.webhook_url`.
   - Sign with HMAC-SHA256 of the body using the decrypted `webhook_secret`. Header: `X-Prequest-Signature: v1=<base64>`.
   - Send `X-Prequest-Idempotency-Key: order.created:<order_id>` for vendor-side dedupe.
   - Retry with exponential backoff (3 attempts, base 5s).
   - Persist every attempt to `vendor_webhook_deliveries` (new table) with response status + body.
3. Hooked from the same trigger as the email path (vendor-notification outbox), with a separate row type so ops can disable email vs webhook independently.
4. Per spec, optional `webhook_on_status_update` (also fires on edits / cancellations) is a follow-up — leave it as a flag on `vendors` for Sprint 5.
5. Audit: `vendor.webhook_delivered` / `vendor.webhook_failed` (already in `vendor-portal/event-types.ts`).

**Acceptance:**
- Configuring `webhook_url` + `webhook_secret` on a vendor results in signed POSTs on order-create.
- Vendor side validates the signature with the secret and accepts (or rejects) the request. We can write a Resend-style timing-safe verify helper they can copy.
- Failures retry up to 3 times then give up (audit `webhook_failed` with the response code + body excerpt).
- Tests: signing math, retry semantics, key encryption/decryption round-trip.

**Estimate:** 1 day.

---

## E. PWA configuration on vendor portal frontend

Spec §11 + §12.5. The vendor portal should be installable on phones / tablets and work offline for the inbox view.

**Tasks:**
1. `apps/web/public/manifest.webmanifest` — name, short_name, icons (192/512), theme_color, background_color, display: 'standalone', scope: '/vendor', start_url: '/vendor/inbox'.
2. Service worker via `vite-plugin-pwa`:
   - Pre-cache the vendor portal shell + critical assets.
   - Runtime cache `/api/vendor/*` GET responses with stale-while-revalidate (network-first for POST).
   - Versioning + cleanup of old caches on activate.
3. Add a `<link rel="manifest">` + theme-color meta tag in the vendor-portal HTML entry. Probably the existing `index.html` since the SPA is shared, but scope the manifest to `/vendor` so the rest of the app doesn't get installed as a PWA.
4. iOS-specific apple-touch-icon + apple-mobile-web-app-* metas.
5. Web Push API integration is OUT of scope for this slice — Sprint 5+. Phase B v1 ships PWA-installable; push notifications come later.
6. Tests:
   - Lighthouse PWA audit ≥ 90 on `/vendor/inbox`.
   - `npm run build` produces a `sw.js` + `manifest.webmanifest` in dist.
   - Service worker activates + caches the inbox shell on first visit (manual smoke).

**Acceptance:**
- iPhone Safari + Chrome Android can "Add to Home Screen" the vendor portal.
- Inbox loads from cache when offline (last-known data).
- Detail page shows a "you're offline" banner when offline + can't reach the API.

**Estimate:** 1 day including QA pass on real devices.

---

## F. i18n strings bundle for vendor portal

Spec §15 Sprint 4 mentions "i18n: NL + FR + EN strings."

The existing portal copy is hardcoded in TSX. Sprint 4 spec wants per-locale bundles (matches the daily-list `templates/strings.ts` pattern).

**Tasks:**
1. New `apps/web/src/pages/vendor/strings.ts` with NL/FR/EN bundles, parity-checked at runtime + via a unit test (mirror `daily-list/templates/strings.spec.ts`).
2. Replace hardcoded strings in:
   - `vendor-login.tsx` (or wherever the magic-link landing page is)
   - `vendor-inbox.tsx`
   - `vendor-order-detail.tsx`
   - Status-update controls
   - Decline-flow modal
3. Resolve locale from `vendor_users.preferred_language` (column needs adding if not present) → fall back to vendor's default (`vendors.daglijst_language`) → fall back to NL.
4. Persist preferred_language updates from a profile-page selector.

**Acceptance:**
- Switching `vendor_users.preferred_language` flips the entire portal UI.
- Parity test enforces every locale has every key.

**Estimate:** half a day; tedious but mechanical.

---

## G. Sprint 5 — Internal team /desk/fulfillment surface

Spec §9 + §15 Sprint 5.

Internal teams (catering / AV / etc.) get a **mirror** of the vendor portal at `/desk/fulfillment`, scoped by `team_members.team_id` instead of `vendor_id`. Same components, different data filter.

**Tasks:**
1. New `/desk/fulfillment` route in `App.tsx`. ProtectedRoute requires `agent` role + a `team_members` row (so only team members see it; admins see it via permission override).
2. New `apps/api/src/modules/fulfillment/` module:
   - `FulfillmentService.listMyOrders(userId)` → joins `order_line_items` against the user's team memberships, returns the same projection shape as `VendorOrderService.list()` for component reuse.
   - `FulfillmentService.updateStatus(...)` → mirrors `VendorOrderStatusService.updateStatus` but operates on team-fulfillment lines (no vendor portal session check).
3. Frontend reuses the components from `apps/web/src/pages/vendor/`:
   - Lift inbox / detail / status-controls into `apps/web/src/components/fulfillment/` (rename from `vendor-` to `fulfillment-`).
   - The vendor-portal page imports from `components/fulfillment/` and passes the vendor data adapter; `/desk/fulfillment` imports the same components and passes the team data adapter.
4. Daglijst download from portal — when a fulfillment user's team has a `vendors.daglijst_email`, surface today's daglijst PDF in their inbox header (uses `daily-list-admin.controller.ts:download` with admin TTL).
5. Auth alignment for Path 2 (internal team with login):
   - `vendor_users` is NOT used; the team member is already a regular `users` row with the `fulfiller` role.
   - `/desk/fulfillment` is gated by `team_members.role IN ('fulfiller','manager')`.

**Acceptance:**
- A user in `team_members` of an internal catering team logs in to `/login` and lands on `/desk/fulfillment`.
- Sees the same UI as a vendor would, scoped to their team's incoming orders.
- Status updates flow through to the same audit + realtime channels as vendor-portal updates.

**Estimate:** 1.5 days (component lift + new module + auth wiring + tests).

---

## H. Sprint 5 — accessibility + final UX pass

Spec §15 Sprint 5: "Accessibility audit + final UX pass."

**Tasks:**
1. Run Lighthouse a11y audit on every vendor-portal route + `/desk/fulfillment`. Target ≥95.
2. Keyboard-only nav check: tab order, focus traps in modals, escape-to-close.
3. Screen-reader pass on inbox + detail (VoiceOver / NVDA): announcements on status change, ARIA-live for realtime updates.
4. Reduced-motion: confirm the global `prefers-reduced-motion` rule covers the new components.
5. Touch-target sizes: ≥44px on every interactive element on `/vendor/inbox` (mobile-first per spec).

**Estimate:** half a day.

---

## I. Optional / deferred-from-Sprint-4

These came up during Sprint 4 review but aren't blocking:

1. **Vendor magic-link `email_message_id` column** — `vendor_user_magic_links` doesn't carry one today. Add when wiring the VendorMailer to MAIL_PROVIDER (item B).
2. **Per-tenant provider routing** — tenant A on Resend, tenant B on SES. Spec §11 calls it out as Sprint 5+. The current `useFactory` in `mail.module.ts` resolves a single provider for the whole platform.
3. **Webhook engagement events** — Resend `email.opened` / `email.clicked` events are dropped today. If we want open-rate metrics for daily-list emails (procurement value: "did the kitchen actually open today's list?"), we surface them in `email_delivery_events` with type='engagement' and aggregate them into a vendor-scorecard KPI. Sprint 5+.
4. **Postmark / SES adapters** — only Resend is wired. The `MailProvider` interface is provider-agnostic so adding another is a single-file slice if a tenant requires a different provider for compliance reasons.
5. **Mail outbox / retry framework** — per-order email + webhook (items C + D) call for an outbox worker. Right now we don't have one. Could reuse the audit-outbox pattern from `apps/api/src/modules/privacy-compliance/audit-outbox.service.ts`.

---

## Pickup checklist

When resuming this work:

- [ ] Confirm Resend account + verified sender domain (or block on tenant-onboarding).
- [ ] Set the operator config in `.env`:
   ```
   RESEND_API_KEY=...
   RESEND_DEFAULT_FROM_EMAIL=noreply@<domain>
   RESEND_WEBHOOK_SECRET=whsec_...
   ```
- [ ] Run codex round-3 on the mail substrate (item A) before stacking new code on top.
- [ ] Wire VendorMailer (item B) — small, gates everything else.
- [ ] Pick item C, D, E, F by priority (per-order email is highest-leverage; webhook is tier-3-POS-prep; PWA is enterprise-credibility; i18n is required-but-mechanical).
- [ ] Sprint 5 (G + H) waits until 4 closes.
