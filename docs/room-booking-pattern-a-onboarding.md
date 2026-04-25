# Pattern A — Onboarding an Outlook Room Mailbox

This is the operational guide for connecting an Outlook room mailbox to
Prequest so that **every Outlook invite for that room flows through the
Prequest booking pipeline** — rules + conflict guard + notifications run
on every invite, regardless of source. Pattern A is the default and the
only mode that genuinely eliminates Prequest ↔ Outlook double-bookings.

If you don't want a room in Outlook at all (e.g. a secured boardroom that
should only be bookable through the Prequest portal), use **Pattern B**
instead — see `docs/room-booking.md` §Calendar sync.

## What you're configuring

Three things end up wired together:

1. The Outlook **room mailbox** stops auto-accepting invites.
2. The Prequest service principal becomes the **calendar processor /
   delegate** on that mailbox.
3. A **Microsoft Graph webhook subscription** is created that pushes
   every invite-arrival event back to Prequest's
   `POST /webhooks/outlook` endpoint.

After that, any Outlook user who adds the room as a resource sends an
invite that lands at the mailbox; the mailbox holds the request
(auto-accept off); Prequest's webhook fires; we run the booking pipeline
and write `accept` or `decline` back to the room calendar via Graph.
The Outlook user sees a normal accept / decline response — but it was
the rule resolver + conflict guard that made the call.

## Prerequisites

- Microsoft 365 tenant with admin access.
- The Prequest API has these env vars set:
  - `MICROSOFT_CLIENT_ID`
  - `MICROSOFT_CLIENT_SECRET`
  - `MICROSOFT_TENANT_ID`
  - `MICROSOFT_GRAPH_WEBHOOK_URL` (the public URL of `/webhooks/outlook`)
  - `MICROSOFT_GRAPH_WEBHOOK_CLIENT_STATE` (any opaque secret — used to
    verify the webhook payloads)
  - `CALENDAR_TOKEN_ENCRYPTION_KEY` (already set; used by `pgcrypto` to
    wrap stored OAuth tokens)
- The Prequest app registration in Entra ID has been granted **admin
  consent** for these application-permission scopes:
  - `Calendars.ReadWrite`
  - `MailboxSettings.ReadWrite`
  - `Subscription.Read.All`

## Step-by-step

### 1. Disable auto-accept on the room mailbox

Microsoft Graph does not expose `Set-CalendarProcessing -AutomateProcessing
None` directly. Run this in Exchange Online PowerShell as a tenant admin:

```powershell
Connect-ExchangeOnline -UserPrincipalName admin@yourtenant.onmicrosoft.com
Set-CalendarProcessing -Identity room-name@yourtenant.onmicrosoft.com `
  -AutomateProcessing None `
  -DeleteComments $false `
  -DeleteSubject $false `
  -RemovePrivateProperty $false
```

Verify:

```powershell
Get-CalendarProcessing -Identity room-name@yourtenant.onmicrosoft.com |
  Select-Object Identity, AutomateProcessing
```

`AutomateProcessing` should now read `None`. If it reads `AutoAccept` or
`AutoUpdate`, the mailbox will continue to accept invites independently
of Prequest and double-bookings can occur.

### 2. Bind the room mailbox to a Prequest space

In `/admin/locations/<space>`, on the room's **Booking config** tab:

- Set **Calendar sync mode** to `Pattern A`.
- Enter the room mailbox's UPN (`room-name@yourtenant.onmicrosoft.com`)
  in **External calendar id**.
- Set **External calendar provider** to `outlook`.
- Save.

### 3. Create the webhook subscription

Either via the admin UI ("Configure room mailbox" button on the room's
Booking config tab — calls `OutlookSyncAdapter.configureRoomMailbox`)
or directly via the API:

```bash
curl -X POST \
  -H "Authorization: Bearer <admin token>" \
  -H "X-Tenant-Id: <tenant uuid>" \
  /api/admin/calendar-sync/rooms/<space_id>/configure
```

This creates the Graph subscription and stores its id +
`expiresDateTime` on `spaces.external_calendar_subscription_id` /
`spaces.external_calendar_subscription_expires_at`. The
`roomMailboxWebhookRenew` cron renews it automatically an hour before
expiry.

### 4. Verify with a real invite

1. From any Outlook user, create a new meeting and invite the room as a
   resource.
2. The room mailbox shows the invite as "Tentative" (not auto-accepted).
3. Within ~5 seconds, the Prequest API receives the Graph notification.
   Check `/admin/calendar-sync` → "Last 30 days · invites intercepted"
   counter — it should increment.
4. The mailbox flips to "Accepted" (or "Declined" with a denial-message
   body if a rule denied the booking).
5. The reservation appears in `/portal/me/bookings` for the inviter,
   sourced as `calendar_sync`.

### 5. Healthy operation

`/admin/calendar-sync` is the daily-check surface:

- **Per-room sync status** — last sync, mode, next webhook renewal,
  errors. A healthy room shows `active` with a renewal timestamp in the
  near future.
- **Conflicts inbox** — should normally be empty. Non-empty rows surface
  webhook misses, etag mismatches, recurrence drift, or orphan events.
  Most resolve automatically (the heartbeat reconciler picks up dropped
  webhook notifications); manual cases offer one-click "Cancel external"
  / "Adopt external" with audit log.

## Common failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Invites still auto-accept and never reach Prequest | `AutomateProcessing` is not `None` | Re-run step 1 |
| Webhook fires but the booking is rejected as `denied: Organizer is not a registered Prequest user` | Inviter's email isn't in the `persons` table for this tenant | Add the user to Prequest, or onboard them via SSO |
| Conflicts inbox fills with `webhook_miss_recovered` rows | Subscription renewal is failing (token expired, scope removed) | Reconnect the room mailbox via the admin UI; verify the Entra app has the application-permission scopes above |
| User sees "Booking rejected: Off-hours bookings need facilities approval" in Outlook | A `require_approval` rule fired. The user should have been routed to approval, not denied — check the rule's effect in `/admin/room-booking-rules` | If correct: user resubmits; the approval flow runs. If wrong: change the rule from `deny` to `require_approval` |

## Disconnecting / decommissioning a room

To stop using Pattern A on a room (e.g. converting to Pattern B):

1. In `/admin/locations/<space>` Booking config, change Calendar sync
   mode to `Pattern B`. The unconfigure handler runs automatically: the
   Graph subscription is cancelled and the stored subscription id is
   cleared.
2. **Re-enable auto-accept on the room mailbox in Exchange Online**:
   ```powershell
   Set-CalendarProcessing -Identity room-name@yourtenant.onmicrosoft.com `
     -AutomateProcessing AutoAccept
   ```
   Otherwise the mailbox sits "Tentative" forever on new invites.

## See also

- `docs/room-booking.md` — full operational reference
- `docs/superpowers/specs/2026-04-25-room-booking-foundation-design.md`
  §5 — the design contract for calendar sync (Pattern A vs B,
  reconciler, conflicts inbox)
