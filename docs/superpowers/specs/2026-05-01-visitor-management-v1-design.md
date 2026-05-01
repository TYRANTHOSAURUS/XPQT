# Visitor Management — v1 Design Spec

**Date:** 2026-05-01
**Status:** Design — pending implementation. Single coherent v1 ship.
**Supersedes:** [`2026-04-27-visitor-management-design.md`](2026-04-27-visitor-management-design.md) (kiosk-heavy spec; replaced after persons-as-truth identity model and v1 scope reset).
**Estimated effort:** ~6-8 weeks elapsed for a single coherent v1 ship including kiosk-lite. Trust the relative sizing of sub-tracks more than the absolute calendar number — AI-authored estimates inflate by historical pattern (memory `feedback_discount_ai_timelines`).

**Why this spec exists:** the older 2026-04-27 spec proposed flat PII on a `visitors` table, contradicting the persons-as-truth model already shipped in migrations 00015/00164 and the GDPR baseline pipeline. It also deferred kiosk and translations in ways that, on adversarial review, undercut the legacy-replacement story (`project_legacy_replacement.md`). This v1 reset:

1. Aligns identity model with what's already in the database (visitors are a kind of `persons` row, not a flat table).
2. Restores kiosk-lite to v1 scope so wave-1 migration customers (Envoy/Proxyclick incumbents) can adopt.
3. Defers translations to a single platform-wide pass (per user direction) — risk acknowledged at sales/migration time.
4. Folds in the platform conventions the older spec missed: cross-tenant FK guards, RLS-per-verb, GDPR adapter alignment, approvals module reuse via dispatcher, space-tree inheritance.

**Coordination with parallel work:** memory `project_visitors_track_split_off.md` notes a parallel backend agent scoped visitors backend at 2026-04-27. The split happened before this redesign. If that agent's work is still in flight, reconcile with the locked decisions here before merging.

**Context:**
- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §E (visitor track).
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md) — Envoy reference.
- [`docs/users.md`](../../users.md) — visitor + receptionist personas.
- [`docs/visibility.md`](../../visibility.md) — 3-tier visibility model.
- Sibling specs: [GDPR baseline](2026-04-27-gdpr-baseline-design.md) · [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) (deferred upstream of v1) · [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) (token auth pattern reused for kiosk).

---

## 1. Goals + non-goals

### Goals (v1)

1. **Persons-as-truth identity model.** Visitor PII (first/last/email/phone/company) lives on `persons` rows tagged `type='visitor'`, `is_external=true`. The `visitors` table holds visit *events* with a `person_id` FK. One PII pipeline; one anonymization worker; one source of truth.
2. **Two entry points.**
   - **Booking-first** — visitor as a line item in a booking bundle (Prequest's wedge).
   - **Visitor-first** — `/portal/visitors/invite` standalone form.
3. **Three arrival modes, configurable per building** —
   - Self-service kiosk (kiosk-lite in v1: QR scan + name-typed fallback + host-ping; reception still handles physical badges + passes).
   - Reception desk (a real human, with a fast workspace).
   - Host-escort (no kiosk, no reception; host walks down to lobby).
4. **Walk-ups allowed, per-visitor-type configurable.** Tenants set per type whether walk-ups are admissible; if approval is required for a type, walk-ups for that type are denied.
5. **Multi-host on day one.** A visitor can have one primary host plus N co-hosts. All notified on arrival; first to acknowledge owns the visit.
6. **Approval reuses the existing approvals module.** Tenant-configurable, default off. Routes via the existing dispatcher (with a new `visitor_invite` branch). Multi-host doesn't change approval — approvers are gatekeepers, not hosts.
7. **Bundle cascade.** When a meeting moves time → visitor's `expected_at` updates; visitor receives a "your visit moved" email (only if status is `expected` — not if visitor is already on-site). When room changes → email updated. When visitor cancels → just that visitor's invite is cancelled. Cancellation cascades both ways: host cancels meeting → visitor cancellation email goes out.
8. **Recurring booking → recurring visits.** Each occurrence of a recurring booking gets its own visitor lifecycle, all linked to the same `person_id`. Visitor email model: ONE invite at series creation + per-occurrence day-before reminder + change-only emails. No 26-emails-on-day-zero spam.
9. **Visitor passes (physical, pool-based).** Tenants manage a pool of numbered visitor passes anchored at site or building level (most-specific-wins inheritance). Reception assigns at check-in; service desk pre-assigns optionally. At checkout: confirm return or mark missing. EOD sweep flags unreturned passes for next-shift reconciliation.
10. **Reception workspace as a peer top-level surface.** New `/reception/*` workspace, sibling of `/desk/*` and `/portal/*`. Real user auth, real permissions, real location scope. Optimized for the reception desk's actual workflow (peak-hour rush, batch backdating, fast quick-add). Service desk also has access via a focused `/desk/visitors` lens.
11. **Kiosk-lite at `/kiosk/:buildingId`.** Anonymous building-bound token auth. QR scan + name-typed fallback + host-ping + simple confirmation screen. No photo capture, no NDA on screen, no ID scan, no Bluetooth printer. Reception still handles physical badge + pass.
12. **Host notification (v1, no MS Graph).** Email + in-app inbox + browser Notification API (when host has portal tab open). No PWA push (no PWA wiring exists). No SMS. Teams DM lights up automatically when MS Graph integration ships.
13. **GDPR retention** flows through the existing baseline pipeline. No parallel anonymization for visitors.
14. **Three new permission keys** registered via the catalog SoT.
15. **Daglijst-style daily list print** at reception (workflow research: receptions sometimes prefer paper, especially when batch-processing).

### Non-goals (v2 or later)

- **Photo capture, NDA on screen, ID scan, Bluetooth label printer** — Tier 2 with kiosk depth.
- **Watchlist** (tenant-wide deny list) — deferred; documented in v2 backlog.
- **Per-building soft block** (lighter watchlist) — deferred with watchlist.
- **Outlook detection of external attendees via MS Graph** — deferred; v1 ships Prequest-first portal only.
- **Standalone recurring visitor invitations** (visitor-first recurrence without an attached booking) — deferred; recurring is only inherited from recurring bookings.
- **Visitor self-checkout via email link** — explicitly rejected on security grounds (visitor or hostile actor flips status to `checked_out` while still on premises).
- **Fire roll-call / BHV evacuation export** — deferred. Compliance burden is on the tenant; risk acknowledged.
- **VIP / "do not announce" privacy flag** — deferred.
- **Allergy / access-needs notes on visitor record** — deferred.
- **Emergency contact for visitor** — deferred.
- **Pre-arrival NDA via email** — deferred (couples to kiosk).
- **Building access control hardware integration** (door locks, turnstiles, RFID) — Tier 3.
- **Facial recognition** — Tier 3.
- **Visitor mobile app** — out of scope; web-based QR only.
- **Cross-tenant visitor identity** — Tier 3.
- **Real-time GPS tracking** — out of scope.

### Languages

**English-only on every surface in v1, by user direction.** Reasoning: translating before the surface stabilizes throws work away when iterations happen. Visitor-facing strings flow through proper i18n primitives (key-based, not hardcoded) so the eventual platform-wide translation pass is mechanical. Documented risk: wave-1 NL/BE customers may push back on English-only visitor emails; mitigation is customer-expectation management at sales/migration time.

---

## 2. Architecture overview

### Backend module

`apps/api/src/modules/visitors/` — new NestJS module:

```
VisitorsModule
├─ VisitorService              — visit record lifecycle (state machine routes ALL writes)
├─ InvitationService           — invite + email + token gen + cancel link
├─ HostNotificationService     — fan-out (email + in-app + Notification API)
├─ VisitorPassPoolService      — pool CRUD + assign/return/missing + inheritance lookup
├─ ReceptionService            — today-view aggregations, fast quick-add, batch entry
├─ KioskService                — kiosk auth (building-bound token), QR validation, host-ping
├─ EodSweepWorker              — building-local 18:00 sweep (lease + idempotent)
├─ BundleCascadeAdapter        — subscriber on BundleService events
└─ VisitorMailDeliveryAdapter  — wraps mail_delivery_events for visitor invites
```

Consumes from: `PersonsModule` (visitor-as-person), `BookingBundlesModule` (cascade events), `ApprovalModule` (target dispatcher branch), `NotificationModule`, `PrivacyComplianceModule` (already wired), `SpacesModule` (closure walk).

Exports: `VisitorService` (read), `InvitationService.create()`, `VisitorPassPoolService.passPoolForSpace()`.

### Frontend surfaces

| Path | Audience | Auth | Purpose |
|---|---|---|---|
| `/portal/visitors/invite` | Hosts (employees) | Real user | Visitor-first invite form |
| `/portal/visitors/expected` | Hosts | Real user | Host's "my upcoming visitors" list |
| Booking composer · "Visitor" line | Hosts | Real user | Booking-first invite (existing composer extended) |
| `/reception/*` | Reception staff | Real user + `visitors:reception` permission | Reception workspace shell |
| `/reception/today` | Reception staff | Same | Today's visitors today-view (the 9am rush surface) |
| `/reception/passes` | Reception staff | Same | Pass pool management at reception's location |
| `/reception/yesterday` | Reception staff | Same | "Yesterday's loose ends" reconciliation |
| `/reception/daglijst` | Reception staff | Same | Printable daily list |
| `/desk/visitors` | Service desk | Real user + `visitors:reception` | Focused lens — visitors tied to active tickets, plus today's escalations. Reception is full view; desk lens is the subset relevant to ticket workflows |
| `/admin/visitors/types` | Admin | Real user + tenant admin role | Visitor type config (per-type approval / walk-up / requirements) |
| `/admin/visitors/passes` | Admin | Real user + tenant admin role | Pool management (CRUD across all locations) |
| `/kiosk/:buildingId` | Public (visitor) | Anonymous building-bound token | Kiosk-lite |
| `/visit/cancel/:token` | Public (visitor) | Token via `validate_invitation_token()` SECURITY DEFINER | Visitor self-cancel landing page |

### Data flow (happy path)

```
Host invites visitor (portal OR composer)
   ↓
InvitationService.create()
   ├─ persons row created (type='visitor', is_external=true)
   ├─ visitors row created (status='expected' OR 'pending_approval')
   ├─ visitor_hosts rows (multi-host)
   ├─ visit_invitation_tokens row (cancel; future qr)
   ├─ if approval required → emit ApprovalRequest (existing module, target_type='visitor_invite')
   └─ else → enqueue InvitationEmailJob → mail_delivery_events captures lifecycle

Visitor receives email (status='expected')
   ↓
[gap]
   ↓
Visitor arrives at building
   ↓
EITHER kiosk path:
   /kiosk/:buildingId → QR scan OR type name → KioskService.checkIn()
      ├─ visitor.status='arrived', arrived_at=now
      ├─ HostNotificationService fan-out
      └─ display "Reception will be with you shortly" (or host-escort screen if unstaffed)
   ↓
OR reception path:
   Reception clicks "Marleen here" in /reception/today
      ├─ visitor.status='arrived', arrived_at=<reception input> (BACKDATABLE per UX research)
      └─ HostNotificationService fan-out
   ↓
Reception assigns physical pass + prints badge from office printer
   ↓
[meeting happens]
   ↓
Reception clicks "Marleen left"
   ├─ Pass return confirmed OR marked missing
   ├─ visitor.status='checked_out', auto_checked_out=false, checkout_source='reception'
   └─ pass returns to pool (or stays 'missing' if marked so)

EOD sweep (18:00 building-local, leased)
   ├─ status='expected'                 → no_show
   ├─ status='arrived' OR 'in_meeting'  → checked_out, auto_checked_out=true, checkout_source='eod_sweep'
   └─ unreturned passes flagged for tomorrow's reconciliation
```

---

## 3. Identity model — persons-as-truth

### The decision

Visitors are `persons` rows with `type='visitor'`, `is_external=true`. The `visitors` table holds visit events; PII lives on `persons`.

### Why

- One anonymization pipeline (already wired via `apps/api/src/modules/privacy-compliance/adapters/visitor-records.adapter.ts`).
- One identity surface: same Marleen across multiple visits has one person record (when dedup is enabled per V5).
- Consistent with how the platform already models humans.
- The shipped DB (`00015_visitors.sql`) already chose this; the older spec's flat-PII model was the divergence.

### Persons row at invite

```
persons row created at InvitationService.create():
  tenant_id = current tenant
  type = 'visitor'
  is_external = true
  org_node_id = NULL                  (visitors aren't in requester org tree)
  default_location_id = NULL          (don't pollute portal scoping)
  first_name, last_name, email, phone, company  (PII lives here, NOT on visitors)
  -- GDPR fields inherited per baseline (anonymized_at, last_seen_in_active_booking_at, left_at)
```

### Dedup (V5 — already resolved)

- Default off: every invite creates a new persons row.
- Tenants opt in via `tenant_settings.visitor_dedup_by_email = true`. When on, `InvitationService.create()` looks up an existing `persons` row matching `(tenant_id, type='visitor', email)` before creating.

### Relationship to existing persons records

If the visitor's email matches an existing employee or contractor in the tenant: **do not merge**. Visitor invites always create a fresh visitor-typed persons row. Cross-type dedup is out of scope (the email match is rare and a same-email-different-type collision is an edge case better resolved by an admin manually).

---

## 4. Data model

### 4.1 `visitors` table — extend, not rebuild

```sql
alter table public.visitors
  -- align with booking-platform time semantics
  add column expected_at      timestamptz,
  add column expected_until   timestamptz,
  add column building_id      uuid references public.spaces(id),
  -- v1 lifecycle additions
  add column auto_checked_out boolean not null default false,
  add column visitor_pass_id  uuid references public.visitor_pass_pool(id),
  add column primary_host_person_id uuid references public.persons(id),
  add column visitor_type_id  uuid references public.visitor_types(id),
  add column booking_bundle_id uuid references public.booking_bundles(id),
  add column reservation_id   uuid references public.reservations(id),
  add column checkout_source  text check (checkout_source in ('reception','host','eod_sweep')),
  add column logged_at        timestamptz;  -- when reception entered the record (vs arrived_at = actual arrival)

-- backdated arrival audit constraint
alter table public.visitors
  add constraint visitors_logged_after_arrived
    check (logged_at is null or arrived_at is null or logged_at >= arrived_at);

-- status enum — backfill BEFORE swapping the check
update public.visitors set status = case
  when status = 'pre_registered' then 'expected'
  when status = 'approved'       then 'expected'
  when status = 'checked_in'     then 'arrived'
  else status
end;

alter table public.visitors
  drop constraint visitors_status_check,
  add constraint visitors_status_check
    check (status in ('pending_approval','expected','arrived','in_meeting','checked_out','no_show','cancelled','denied'));

-- checkout_source must be set when status='checked_out'
alter table public.visitors
  add constraint visitors_checkout_source_required
    check (status != 'checked_out' or checkout_source is not null);

-- existing host_person_id stays populated (denormalized = visitors.primary_host_person_id) so the GDPR adapter at apps/api/src/modules/privacy-compliance/adapters/visitor-records.adapter.ts:43 keeps working without rewrite. Either column points to the same person.

-- visit_date stays as a column for backwards compatibility but consumers migrate to expected_at.
-- Drop visit_date in a follow-up migration once usage is gone.
```

**Backfill audit:** the spec must include an explicit `update visitors` statement before the new check constraint. Without it, existing rows with `pre_registered` / `approved` / `checked_in` fail the new constraint. (Critical finding B5.)

### 4.2 `visitor_types` — tenant-configurable lookup

```sql
create table public.visitor_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  type_key text not null,                                          -- guest | contractor | interview | delivery | vendor | other | <custom>
  display_name text not null,
  description text,
  -- per-type config matrix
  requires_approval boolean not null default false,
  allow_walk_up boolean not null default true,
  -- v2 fields, present-but-unused
  requires_id_scan boolean not null default false,
  requires_nda boolean not null default false,
  requires_photo boolean not null default false,
  default_expected_until_offset_minutes int default 240,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, type_key)
);

alter table public.visitor_types enable row level security;
create policy tenant_isolation on public.visitor_types using (tenant_id = public.current_tenant_id());
revoke all on public.visitor_types from anon, authenticated;
grant select, insert, update, delete on public.visitor_types to service_role;

create index idx_visitor_types_tenant_active on public.visitor_types (tenant_id) where active = true;
```

Six default types seeded per tenant on creation (guest/contractor/interview/delivery/vendor/other). Admin can add/edit/disable. Reviewer's nit N4 resolved: tenant-configurable from day one is cheaper than migrating later.

### 4.3 `visitor_hosts` — multi-host junction

```sql
create table public.visitor_hosts (
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  person_id  uuid not null references public.persons(id),
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  notified_at      timestamptz,
  acknowledged_at  timestamptz,
  primary key (visitor_id, person_id)
);

-- defense-in-depth: tenant_id must match visitor's tenant
create or replace function public.assert_visitor_host_tenant() returns trigger
  language plpgsql as $$
begin
  if new.tenant_id != (select tenant_id from public.visitors where id = new.visitor_id) then
    raise exception 'visitor_hosts.tenant_id mismatch with visitors.tenant_id';
  end if;
  return new;
end;
$$;
create trigger trg_visitor_hosts_tenant_check
  before insert or update on public.visitor_hosts
  for each row execute function public.assert_visitor_host_tenant();

alter table public.visitor_hosts enable row level security;

drop policy if exists tenant_isolation on public.visitor_hosts;
create policy tenant_select on public.visitor_hosts for select using (tenant_id = public.current_tenant_id());
create policy tenant_insert on public.visitor_hosts for insert with check (tenant_id = public.current_tenant_id());
create policy tenant_update on public.visitor_hosts for update using (tenant_id = public.current_tenant_id());
create policy tenant_delete on public.visitor_hosts for delete using (tenant_id = public.current_tenant_id());

revoke all on public.visitor_hosts from anon, authenticated;
grant select, insert, update, delete on public.visitor_hosts to service_role;

create index idx_vh_person on public.visitor_hosts (tenant_id, person_id, acknowledged_at);
```

**Single source of truth on primary host:** `visitors.primary_host_person_id` is the canonical primary; the `visitor_hosts` junction holds *additional* hosts (and the primary, for fan-out simplicity). No `is_primary` flag in the junction. Reviewer C5 resolved.

### 4.4 `visitor_pass_pool` — physical pass tracking

```sql
create table public.visitor_pass_pool (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  space_id  uuid not null references public.spaces(id),
  space_kind text not null,                                          -- denormalized for CHECK + indexed lookups
  pass_number text not null,
  pass_type   text not null default 'standard',
  status text not null default 'available' check (status in ('available','reserved','in_use','lost','retired')),
  current_visitor_id      uuid,
  reserved_for_visitor_id uuid,
  last_assigned_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- pool anchor must be site or building, never floor/desk/parking
  constraint pool_space_kind check (space_kind in ('site','building')),
  unique (tenant_id, space_id, pass_number)
);

-- composite FK to visitors enforces tenant alignment (B1)
alter table public.visitors add constraint visitors_pkey_tenant unique (tenant_id, id);
alter table public.visitor_pass_pool
  add constraint pool_current_visitor_fk
    foreign key (tenant_id, current_visitor_id) references public.visitors(tenant_id, id),
  add constraint pool_reserved_visitor_fk
    foreign key (tenant_id, reserved_for_visitor_id) references public.visitors(tenant_id, id);

-- in-use = current_visitor_id required; reserved = reserved_for_visitor_id required
alter table public.visitor_pass_pool
  add constraint pool_state_consistency check (
    (status = 'in_use'    and current_visitor_id is not null) or
    (status = 'reserved'  and reserved_for_visitor_id is not null) or
    (status not in ('in_use','reserved'))
  );

-- denormalized space_kind kept in sync via trigger
create or replace function public.sync_pool_space_kind() returns trigger
  language plpgsql as $$
begin
  new.space_kind := (select kind from public.spaces where id = new.space_id);
  if new.space_kind not in ('site','building') then
    raise exception 'visitor_pass_pool.space_id must reference a site or building, got %', new.space_kind;
  end if;
  return new;
end;
$$;
create trigger trg_pool_space_kind
  before insert or update of space_id on public.visitor_pass_pool
  for each row execute function public.sync_pool_space_kind();

alter table public.visitor_pass_pool enable row level security;
create policy tenant_select on public.visitor_pass_pool for select using (tenant_id = public.current_tenant_id());
create policy tenant_insert on public.visitor_pass_pool for insert with check (tenant_id = public.current_tenant_id());
create policy tenant_update on public.visitor_pass_pool for update using (tenant_id = public.current_tenant_id());
create policy tenant_delete on public.visitor_pass_pool for delete using (tenant_id = public.current_tenant_id());
revoke all on public.visitor_pass_pool from anon, authenticated;
grant select, insert, update, delete on public.visitor_pass_pool to service_role;

create index idx_pool_space on public.visitor_pass_pool (tenant_id, space_id, status);
create index idx_pool_current_visitor on public.visitor_pass_pool (tenant_id, current_visitor_id) where current_visitor_id is not null;
```

### 4.5 Pool inheritance — `pass_pool_for_space()`

The locked decision (most-specific-wins inheritance) requires walking up the spaces tree. There's no existing helper for ancestor walks (`expand_space_closure` walks descendants; reviewer C7 / B7).

```sql
create or replace function public.pass_pool_for_space(p_space_id uuid)
  returns setof public.visitor_pass_pool
  language sql stable security invoker
as $$
  with recursive ancestors as (
    select id, parent_id, 0 as depth from public.spaces where id = p_space_id
    union all
    select s.id, s.parent_id, a.depth + 1
      from public.spaces s join ancestors a on s.id = a.parent_id
  ),
  -- explicit opt-out: if any ancestor has uses_visitor_passes=false, no pool
  opt_out_check as (
    select bool_or(s.uses_visitor_passes = false) as opted_out
    from ancestors a join public.spaces s on s.id = a.id
  )
  select pool.*
  from public.visitor_pass_pool pool
  join ancestors a on pool.space_id = a.id
  where pool.tenant_id = public.current_tenant_id()
    and not (select opted_out from opt_out_check)
  order by a.depth asc
  limit 1;  -- most-specific (smallest depth) wins
$$;
```

`spaces.uses_visitor_passes boolean` (nullable) added by this migration. Null = inherit; explicit `false` blocks inheritance for that subtree.

### 4.6 `visit_invitation_tokens` — cancel link + future QR

```sql
create table public.visit_invitation_tokens (
  id uuid primary key default gen_random_uuid(),
  visitor_id uuid not null references public.visitors(id) on delete cascade,
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  token_hash text not null unique,                                  -- sha256 of token, never store plaintext
  purpose    text not null check (purpose in ('cancel','qr')),
  expires_at timestamptz not null,
  used_at    timestamptz,                                            -- single-use enforcement
  created_at timestamptz not null default now()
);

-- composite FK with tenant alignment (B1)
alter table public.visit_invitation_tokens
  add constraint vit_visitor_fk
    foreign key (tenant_id, visitor_id) references public.visitors(tenant_id, id);

alter table public.visit_invitation_tokens enable row level security;
-- service_role only — anonymous lookups go through SECURITY DEFINER function below
revoke all on public.visit_invitation_tokens from anon, authenticated;
grant select, insert, update on public.visit_invitation_tokens to service_role;

create index idx_vit_token on public.visit_invitation_tokens (token_hash);
create index idx_vit_expiry on public.visit_invitation_tokens (expires_at) where used_at is null;
create index idx_vit_visitor on public.visit_invitation_tokens (tenant_id, visitor_id);
```

### 4.7 `validate_invitation_token()` — anonymous lookup, security definer

The visitor cancel link is clicked from an email by an unauthenticated user. RLS via `current_tenant_id()` is unusable — the function bypasses RLS but enforces:

```sql
create or replace function public.validate_invitation_token(p_token text, p_purpose text)
  returns table (visitor_id uuid, tenant_id uuid)
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_token_hash text := encode(digest(p_token, 'sha256'), 'hex');
  v_record public.visit_invitation_tokens;
begin
  -- single-use: lock the row, fail if already used
  select * into v_record from public.visit_invitation_tokens
    where token_hash = v_token_hash
      and purpose = p_purpose
    for update;

  if not found then
    raise exception 'invalid_token';
  end if;
  if v_record.used_at is not null then
    raise exception 'token_already_used';
  end if;
  if v_record.expires_at < now() then
    raise exception 'token_expired';
  end if;

  -- consume
  update public.visit_invitation_tokens set used_at = now() where id = v_record.id;

  -- rate-limit logging (optional v1 hardening; per-token + per-IP in app layer)
  return query select v_record.visitor_id, v_record.tenant_id;
end;
$$;

revoke all on function public.validate_invitation_token(text, text) from public;
-- grant execute to anon for the cancel-link path
grant execute on function public.validate_invitation_token(text, text) to anon, authenticated;
```

The Nest API endpoint that handles `/visit/cancel/:token` calls this function in a transaction; on success, transitions the visitor's status to `cancelled`. Per-token single-use means refresh-the-page re-cancel attacks are blocked.

### 4.8 `buildings.timezone` for EOD sweep

```sql
-- spaces table is the building registry; add per-building timezone
alter table public.spaces add column if not exists timezone text default 'Europe/Amsterdam';
-- only meaningful for kind='building'; null on smaller scopes
```

Defaults to `Europe/Amsterdam` (Benelux primary market). Admin can override per building.

### 4.9 `visitor_visibility_ids()` — visibility predicate function

Per the platform's 3-tier visibility pattern (`docs/visibility.md`, exemplified by `00187_tickets_visible_for_actor.sql`):

```sql
create or replace function public.visitor_visibility_ids(p_user_id uuid, p_tenant_id uuid)
  returns table (visitor_id uuid)
  language sql stable security invoker
as $$
  -- Tier 1: Hosts see their own visits (primary or co-host)
  select v.id from public.visitors v
    where v.tenant_id = p_tenant_id
      and (v.primary_host_person_id = (select person_id from public.users where id = p_user_id)
           or exists (
             select 1 from public.visitor_hosts vh
               where vh.visitor_id = v.id
                 and vh.person_id = (select person_id from public.users where id = p_user_id)
           ))
  union
  -- Tier 2: Operators with visitors:reception in their location scope
  select v.id from public.visitors v
    where v.tenant_id = p_tenant_id
      and public.user_has_permission(p_user_id, p_tenant_id, 'visitors:reception')
      and v.building_id in (
        select space_id from public.org_node_location_grants ognlg
          join public.user_role_assignments ura on ura.user_id = p_user_id
          join public.roles r on r.id = ura.role_id
        where ognlg.org_node_id = ura.org_node_id  -- existing scope plumbing
      )
  union
  -- Tier 3: Override — visitors:read_all
  select v.id from public.visitors v
    where v.tenant_id = p_tenant_id
      and public.user_has_permission(p_user_id, p_tenant_id, 'visitors:read_all');
$$;
```

Used by `VisitorService.list()` and the reception today-view endpoint as a JOIN filter.

### 4.10 mail delivery events (no `email_bounced_at` column)

Per reviewer N5: existing pattern in `00183_mail_delivery_events.sql`. Visitor invite emails write events to `mail_delivery_events` keyed by `(entity_type='visitor_invite', entity_id=visitors.id)`. Reception's today-view JOINs to surface bounce status. No new column on visitors.

### 4.11 Audit events

Visitor lifecycle emits events to `audit_events` (the existing audit pipeline):

- `visitor.invited` / `visitor.invitation_approved` / `visitor.invitation_denied`
- `visitor.cancelled` (by host / by visitor / by bundle cascade — `actor_kind` distinguishes)
- `visitor.arrived` / `visitor.checked_out` / `visitor.no_show`
- `visitor.host_notified` / `visitor.host_acknowledged`
- `visitor.pass_assigned` / `visitor.pass_returned` / `visitor.pass_marked_missing`
- `visitor.eod_swept` (auto checkout)
- `visitor.anonymized` (via GDPR pipeline)
- `kiosk.checkin_attempted` / `kiosk.checkin_succeeded` / `kiosk.unknown_visitor`

`audit_events.actor_id` distinguishes reception, host, system (EOD), kiosk (anonymous), visitor (token).

---

## 5. Lifecycle + status machine

### Transitions

```
                   ┌──────────────────┐
                   │ pending_approval │ (only if visitor type requires approval)
                   └─────────┬────────┘
                             │
                  approve    │    deny
                             ↓
                   ┌──────────────────┐         ┌────────────┐
       invite ───→ │     expected     │ ──────→ │ cancelled  │
                   └─────────┬────────┘ visitor └────────────┘
                             │ arrives
                             ↓
                   ┌──────────────────┐         ┌────────────┐
                   │     arrived      │ ──────→ │  no_show   │ (eod sweep, only from `expected`)
                   └─────────┬────────┘
                             │
                             ↓ (optional) host meets visitor
                   ┌──────────────────┐
                   │   in_meeting     │
                   └─────────┬────────┘
                             │ checkout (reception/host/eod)
                             ↓
                   ┌──────────────────┐
                   │   checked_out    │
                   └──────────────────┘
                             ↓
                   denied (terminal; only from expected/pending_approval if walked into a deny path)
```

### Enforcement

`VisitorService.transitionStatus(visitor_id, to_status, actor)` is the **only** function that writes `status`. All other code paths route through it. It:

1. Loads visitor row (locked).
2. Validates the transition matrix (e.g., `cancelled` is unreachable from `checked_out`).
3. Sets `status`, `arrived_at`/`checked_out_at` per transition, `checkout_source` if applicable.
4. Emits audit event.
5. Triggers downstream effects (host notification on `arrived`; cascade on `cancelled`; pass return on `checked_out`).

A DB trigger enforces the same matrix as defense-in-depth (catches bypasses):

```sql
create or replace function public.assert_visitor_status_transition() returns trigger
  language plpgsql as $$
begin
  if old.status = new.status then return new; end if;
  if not exists (
    select 1 from (values
      ('pending_approval','expected'),
      ('pending_approval','denied'),
      ('pending_approval','cancelled'),
      ('expected','arrived'),
      ('expected','no_show'),
      ('expected','cancelled'),
      ('expected','denied'),
      ('arrived','in_meeting'),
      ('arrived','checked_out'),
      ('in_meeting','checked_out')
    ) as t(from_s, to_s)
    where t.from_s = old.status and t.to_s = new.status
  ) then
    raise exception 'invalid visitor status transition: % -> %', old.status, new.status;
  end if;
  return new;
end;
$$;
create trigger trg_visitor_status_transition
  before update of status on public.visitors
  for each row execute function public.assert_visitor_status_transition();
```

---

## 6. Invite flow

### 6.1 Visitor-first — `/portal/visitors/invite`

Form composition uses the mandatory `<Field>` primitives per `CLAUDE.md` Form composition rule. Fields:

- Visitor first name (required)
- Visitor last name (optional)
- Visitor email (required for now — visitor receives invite by email; future kiosk-only walk-up can drop this)
- Visitor company (optional)
- Visitor phone (optional)
- Visitor type (select; defaults to "Guest"; tenant types from `visitor_types`)
- Expected at (datetime; defaults to next round 30 minutes from now + 1 hour)
- Expected until (datetime; defaults to expected_at + per-type `default_expected_until_offset_minutes`)
- Building (select; **scoped to inviter's location grants**, see §10 visibility)
- Meeting room (optional; reservations the inviter has at the chosen building)
- Bundle (optional; if set, this becomes a booking-first invite under the hood)
- Other hosts (multi-add; persons picker scoped to the inviter's tenant)
- Notes for visitor (free text; goes into the email)
- Notes for reception (free text; reception-only visibility)

On submit:
1. Validate inviter has cross-building scope to invite at the selected building (cross-building leak fix per reviewer C3).
2. `InvitationService.create()` runs the full create flow.
3. Toast: `toastCreated('visitor invitation', { onView: '/portal/visitors/expected' })` per `CLAUDE.md` toast conventions.

### 6.2 Booking-first — composer line item

The existing booking composer adds a "Visitors" section alongside Catering/AV/Cleaning. UX:

- "Add visitor" button opens a smaller version of the visitor-first form (visitor type + first name + email + company + other hosts).
- Visitor inherits the booking's `expected_at` / `expected_until` / `building_id` / `meeting_room_id` / `booking_bundle_id`.
- One bundle can have N visitors.
- Cancellation cascade behavior per §8.

The "Visitor" composer section is hidden in tenants where the inviter lacks `visitors:invite`.

### 6.3 Cross-building invite scope check

`InvitationService.create()` validates that `inviter.location_grants` covers the requested `building_id`. If not, returns 403 with a clear message: "You don't have access to invite visitors at HQ Rotterdam. Contact your admin." (Reviewer C3.)

### 6.4 Hidden walk-up handling

Walk-ups don't go through this form — they go through reception or the kiosk's "I don't have an invitation" path (§7.4 and §8.5). Reception/kiosk walk-up flow internally calls `InvitationService.create()` with `arrived_at = expected_at = now`.

---

## 7. Reception workspace (`/reception/*`)

### 7.1 Why a new workspace

Service desk is at `/desk/*`; portal at `/portal/*`; admin at `/admin/*`. Reception has its own job — reception-shift workflows differ from desk/admin. Putting reception inside admin compromises both. The workspace is a new top-level peer, accessed by `visitors:reception`-permission users.

### 7.2 The 9am rush UX (reviewer A5)

The single hardest UX problem in v1: 8 visitors arrive at the same desk at 09:00. Reception must resolve any one of them in under 3 seconds. Design specifics:

- **Single search input** at top of `/reception/today` is autofocused on page load. Type-ahead matches visitor first name OR last name OR company OR primary host name — fuzzy + case-insensitive + accent-insensitive. Filter results to today's expected and arrived.
- **Inline keyboard navigation** — arrow keys move between matches; Enter to select; Escape to clear. Reception staff with experience can complete a check-in without touching the mouse.
- **Result rows show:** visitor first name (large), company (smaller), primary host first name, expected_at, status, pass status if assigned. One-tap to check in.
- **Quick-add affordance** is permanently visible (top-right "Add walk-up"). One click opens an inline minimal form (first name + host picker + visitor type) — no modal, no navigation. Submit defaults `arrived_at = now` but offers a "Backdated to" picker. Form clears + refocuses on submit (batch-entry mode per UX research).

### 7.3 Today-view layout

```
┌─ Reception · HQ Amsterdam · Apr 30 ───────────────────────────────────┐
│  [Search visitors / hosts / companies _________________ ]  [+ Walk-up] │
│                                                                          │
│  ─── Currently arriving ──────────────────────────────────────────       │
│   09:02  Marleen V. (ABC Bank)         Host: Jan B.   pending   ⌛       │
│   09:05  Pieter K. (Contractor·ABC)    Host: Anne L.  arrived  ✓         │
│                                                                          │
│  ─── Expected next 30 min ──────────────────────────────────────────     │
│   09:30  Sarah V. (Interview · 1 of 3)  Host: HR Team                    │
│   09:45  Hans P. (Vendor · ISS)         Host: Peter K.                   │
│                                                                          │
│  ─── On site ─────────────────────────────────────────────────────       │
│   3 visitors currently in meetings  [Show details]                       │
│                                                                          │
│  ─── Yesterday's loose ends ──────────────────────────────────────       │
│   12 visitors auto-checked-out  ·  3 passes unreturned                   │
│   [Reconcile]                                                            │
└──────────────────────────────────────────────────────────────────────────┘
```

### 7.4 Walk-up flow

When reception clicks "+ Walk-up" or a visitor walks up without being expected:

1. Inline form: first name (required), last name (optional), company (optional), email (optional), visitor type (select), host (picker, scoped to tenant employees).
2. **Visitor type's `allow_walk_up` flag** is checked — if false, form shows a blocking message: "Walk-ups disabled for [contractor]. Please ask the host to pre-invite this visitor."
3. **If type's `requires_approval` = true**, walk-up is denied (per Q3 lock D — walk-ups disabled when approval is required).
4. On submit: visitor is created with `status='arrived'`, `arrived_at = <reception input or now>`, `logged_at = now`. Host is pinged immediately. The visitor goes through the full lifecycle from there.

### 7.5 Backdated arrival entry

Reception's "Mark arrived" action defaults `arrived_at = now()` but exposes a time picker labeled "Actually arrived at" so reception can correct: "Marleen actually walked in at 09:15; I'm only entering it now at 09:42." The audit captures both `arrived_at` (truth) and `logged_at` (record time). Reviewer-flagged backdated logging requirement.

### 7.6 Pass actions inline with visitor row

When a pass pool covers this building (per `pass_pool_for_space()`):

- "Assign pass" affordance → quick-pick from available passes. Pre-reserved passes (set by service desk) appear as "✓ Pass #042 (reserved)" with one-tap confirm.
- "Return pass" affordance at checkout → confirms `current_visitor_id` clears and pass returns to `available`. If reception clicks "Checked out" without returning the pass: confirmation modal → "Mark missing or skip?".

### 7.7 Yesterday's loose ends tile

Reception's start-of-shift view surfaces:

- Yesterday's visitors swept to `auto_checked_out=true` (count + click-through to list).
- Unreturned passes from the last 24h (count + list with "Mark recovered" / "Mark lost" actions).
- Visitors whose `email_bounced` event is recent (so reception knows to call ahead today).

Reviewer C2 resolved.

### 7.8 Daglijst-style printable daily list

`/reception/daglijst` — on-demand print of today's expected visitors in a paper-friendly layout. Browser-print, A4, multiple visitors per page, reception phone + signature column for paper checkmarks during peak rush. Reviewer 8a in v1 (per UX research finding).

### 7.9 Service desk lens at `/desk/visitors`

A *focused* surface inside the desk shell, NOT a duplicate of `/reception/*`. Shows:

- Visitors whose `visitor_type` is `contractor` AND who have an active service ticket (e.g., contractor visiting to fix the broken AC — both a ticket and a visitor).
- All visitors currently in `pending_approval` state (so desk can chase the approver).
- Today's visitor escalations: `email_bounced`, `host_not_yet_acknowledged > 5min`, `unreturned_passes`.

Read + check-in actions; pass actions; full visitor record drill-down. Same data as reception, narrower presentation. Reviewer C14 resolved.

---

## 8. Kiosk-lite (`/kiosk/:buildingId`)

### 8.1 Form factor + auth

- Tablet (iPad / Android), landscape, mounted in lobby.
- Tenant-brandable home screen.
- Auto-locks after 30s idle.
- **Auth:** anonymous building-bound token. Admin provisions a token via `/admin/visitors/passes` → "Provision kiosk for HQ Amsterdam" → generates a long-lived rotating token (90-day rotation) bound to `tenant_id + building_id`. Token is embedded in the kiosk URL via a one-time setup flow at provisioning time. Same auth pattern as Vendor portal Phase B (referenced spec) for consistency.

### 8.2 Idle screen

```
┌─ Welcome to [HQ Amsterdam] ───────────────────────┐
│                                                     │
│      [Tenant logo + welcome text]                   │
│                                                     │
│   ───────────────────────────────────────           │
│                                                     │
│   ◉ Have an invitation? Scan your QR code.         │
│                                                     │
│         [QR scan area — camera]                     │
│                                                     │
│   ◯ No invitation? Tap to type your name.          │
│                                                     │
└─────────────────────────────────────────────────────┘
```

### 8.3 QR scan path

1. Visitor holds invite-email QR up to camera.
2. `KioskService.checkInWithToken(qrToken)` validates via `validate_invitation_token(qrToken, 'qr')`.
3. **Note:** in v1, the invite email does NOT contain a QR code (per Q15 — QR generation deferred). Adding QR generation to invite email is a 1-day item; ship in v1 alongside kiosk so the QR path actually works. Spec assumes QR is generated and delivered in invite email starting with v1.
4. On match: visitor.status flips to `arrived` via `VisitorService.transitionStatus`, host fan-out fires, kiosk shows "Welcome — Reception will be with you shortly" (or "Your host will meet you in the lobby" if building has no reception).

### 8.4 Name-typed fallback

1. Visitor taps "No invitation".
2. Kiosk shows large name search field with on-screen keyboard.
3. Visitor types first letters of first OR last name.
4. Fuzzy-match against today's `expected` visitors at this building only. Match results show first name + company (no host name — privacy).
5. Visitor taps their entry → kiosk asks for confirmation: "I'm here to see [host first initial + last name]?" → tap confirm.
6. Same `arrived` flow as QR path.

### 8.5 Walk-up at kiosk (no invitation)

If the name doesn't match any expected visitor:

1. Kiosk asks "Are you here as a [Guest/Contractor/Interview/Delivery/Vendor]?" (filtered to types where `allow_walk_up=true` and `requires_approval=false`).
2. If at least one type qualifies: visitor selects → kiosk asks for first name + host picker (search by name) + (optional) email/company → KioskService creates a walk-up record + pings host.
3. If no types qualify: kiosk shows "Please see reception. They'll help you check in." (Reception is now in the loop for the deny path.)

### 8.6 Offline behavior

If the kiosk loses network:
- Recently-cached today's expected list is used for name-typed fallback (shorter horizon: today only).
- New check-ins are queued in IndexedDB; flushed when network returns.
- Visitor sees: "Reception will be with you shortly" — same as online walk-up path. Reception's today-view shows the offline-pending entries with a small "queued" badge until the kiosk syncs.

### 8.7 What kiosk does NOT do in v1

- **No photo capture.** Front camera is used for QR only.
- **No NDA on screen.** No HTML render, no signature.
- **No ID scan.** No upload, no encryption-at-rest.
- **No badge print.** Reception still prints the paper badge from their office printer when visitor walks over (or host-escort mode skips the badge entirely).
- **No watchlist check.** Watchlist is deferred entirely.

---

## 9. Multi-host + notifications

### 9.1 Data model recap

- `visitors.primary_host_person_id` is the canonical primary host (used by GDPR adapter, indexes, single-host display paths).
- `visitor_hosts` junction has all hosts (primary included) for fan-out.

### 9.2 Notification fan-out

When `visitor.status` transitions to `arrived`:

```
HostNotificationService.notifyArrival(visitor_id):
  for each host in (visitors.primary_host_person_id ∪ visitor_hosts.person_id):
    parallel:
      enqueue email job (always — floor)
      append to host's in-app inbox
      if host's portal tab is open: emit Notification API event via SSE or websocket
    record notified_at on visitor_hosts row
```

The first host whose acknowledgment endpoint fires (`/api/visitors/:id/acknowledge`) becomes the *active host* — the others see "Acknowledged by [Anne]" in their inbox; no further pings.

### 9.3 No PWA push, no SMS, no Teams DM (v1)

- No PWA wiring exists (verified). PWA/push is its own multi-week sub-project across the platform; not bolted onto visitors.
- SMS via third-party provider out of scope (vendor + cost; overkill for visitor arrival).
- Teams DM lights up automatically once MS Graph integration ships (sibling spec); no visitor-specific work needed at that time.

### 9.4 Browser Notification API

When the host's portal tab is open and they've granted Notification permission: a desktop notification fires on arrival. Single-line API call (`Notification.requestPermission()`); no service worker. Limitation: only works while the tab is open. This is acceptable for v1.

---

## 10. Bundle cascade

### 10.1 Hook design

`BundleCascadeService` does not currently have an extension mechanism (reviewer C8). v1 adds:

- Domain events emitted from `BundleCascadeService.editLine`, `cancelLine`, `cancelBundle`. Event types:
  - `bundle.line.moved` (when expected_at changes; payload includes old + new times)
  - `bundle.line.room_changed`
  - `bundle.line.cancelled`
  - `bundle.cancelled`
- `BundleCascadeAdapter` (in `VisitorsModule`) subscribes via the existing event-bus pattern (consistent with how SLA timers, notifications, and existing modules subscribe).

### 10.2 Cascade matrix (status-aware per reviewer C1)

| Bundle change | Visitor `status='expected'` | Visitor `status='arrived'/'in_meeting'` | Visitor `status='cancelled'/'no_show'/'checked_out'` |
|---|---|---|---|
| Move time | Auto-update `expected_at`/`expected_until`; send "your visit moved" email | Alert host; do NOT email visitor (visitor is in lobby) | No-op |
| Move room | Auto-update; send "your room changed" email | Alert host; reception sees update in today-view | No-op |
| Visitor's bundle cancelled | Visitor invite cancelled; cancellation email sent; pass reservation released | Alert host; visitor's status held; reception confirms in person | No-op |
| Whole bundle cancelled | All visitors cancelled; emails sent | Alert hosts; visitors stay until meeting actually doesn't happen | No-op |

**Why status-aware:** sending "your visit on May 1 moved to 10:00" to a visitor standing at reception is broken UX. Send to host instead. Reviewer C1 resolved.

### 10.3 Recurring booking + recurring visitors

Recurring bookings in this platform materialize lazily (per migration 00150 pattern). Visitors follow:

- At series creation, **one** `visitors` row created for the *series* (linked to the series-level reservation, OR to the first occurrence with a `series_id` field — pick whichever the reservations module already does for catering lines).
- One invitation email sent at series creation with .ics recurrence pattern.
- On each occurrence's day-before tick, a per-occurrence reminder email is generated only for that next occurrence.
- On per-occurrence change (move time/room/cancel-this-occurrence): emit per-occurrence email per the cascade matrix.
- On series cancel: one consolidated cancellation email.

Reviewer C9: this resolves the eager-vs-lazy contradiction by following the existing reservation pattern (lazy materialization with a series-level entity).

---

## 11. Approval routing (reuse existing module)

### 11.1 Wiring

The approvals module currently hardcodes target types in `ApprovalService.respond()` (approval.service.ts:310-340). v1 adds:

```typescript
// approval.service.ts
case 'visitor_invite':
  await this.visitorService.onApprovalDecided(approval.target_id, approval.outcome);
  break;
```

`VisitorsModule` provides `VisitorService` to `ApprovalModule` via `forwardRef` (existing pattern at approval.module.ts:33-38). Reviewer B6 resolved.

### 11.2 Routing rules

The existing approval routing rule engine decides who approves. For `visitor_invite`:

- Tenant admin configures rules: per visitor type, per cost-center, per building.
- Default rule: visitor type's `requires_approval` flag. If true, route to a configurable role (default: "Security" or "Facilities Lead", depending on the type).
- The approver is **NOT necessarily a host**. Hosts are recipients; approvers are gatekeepers. Confirmed in Q4 (reopened).

### 11.3 Approval lifecycle

```
InvitationService.create():
  visitor.status = 'pending_approval'
  ApprovalService.create({ target_type: 'visitor_invite', target_id: visitor.id, ... })
  -- email NOT sent yet

ApprovalService.respond(approval_id, 'approved'):
  -- existing dispatcher
  → VisitorService.onApprovalDecided(visitor.id, 'approved')
       visitor.status = 'expected'
       enqueue InvitationEmailJob

ApprovalService.respond(approval_id, 'denied'):
  → VisitorService.onApprovalDecided(visitor.id, 'denied')
       visitor.status = 'denied'
       host receives "your invitation was declined" notification
       visitor receives nothing
```

### 11.4 Walk-up + approval

Walk-ups for approval-required visitor types are denied (per Q3 lock D). The walk-up flow at reception/kiosk checks `visitor_types.allow_walk_up AND not visitor_types.requires_approval` before allowing the walk-up. If denied: "Please ask your host to pre-invite you so the approval can be processed."

### 11.5 Multi-host + approval (orthogonal — Q4 reopened)

The approvals module decides who approves. Multi-host status doesn't change that. If a tenant configures "primary host approves contractor invites", the rule resolves to `primary_host_person_id`. If they configure "any host approves", the rule resolves to "OR over visitor_hosts". If they configure "facilities lead approves", neither matters. Reviewer concern resolved by routing through existing rules.

---

## 12. EOD sweep

### 12.1 Cron + lease

```
EodSweepWorker runs at every 15 minutes from 17:30 to 19:00 building-local.
For each building b in this tenant where now() >= b.timezone-resolved 18:00 and now() < 19:00:
  acquire lease key 'visitor.eod.b.YYYY-MM-DD' (one tenant, one building, one date)
  if not acquired: skip (another worker has it OR already done today)

  for each v in visitors where v.building_id = b.id and v.tenant_id = b.tenant_id and v.status in ('expected','arrived','in_meeting'):
    if v.status = 'expected' and v.expected_until < now():
      transitionStatus(v, 'no_show', actor='eod_sweep')
    elif v.status in ('arrived','in_meeting') and v.expected_until < now():
      transitionStatus(v, 'checked_out', actor='eod_sweep')
        with auto_checked_out=true, checkout_source='eod_sweep'
        if v.visitor_pass_id: pass marked 'unreturned' (status='lost', notes='unreturned via eod sweep')
    -- visitors whose expected_until is still in the future are NOT swept (legitimate long meetings)

  release lease
```

Reviewer C7 resolved (lease + idempotency + timezone-aware + status-conditional).

### 12.2 Lease implementation

Borrow `00177_daglijst_lease_fence.sql` pattern. One row per `(tenant_id, building_id, sweep_date)`; `acquired_at` + `acquired_by` + `released_at`. Re-runs are no-ops.

### 12.3 Unreturned pass handling

Marked passes appear in reception's "Yesterday's loose ends" tile. Reception can:
- "Mark recovered" — pass returns to `available`.
- "Mark lost" — pass stays in `lost`; admin can retire from pool.

---

## 13. Permissions + visibility

### 13.1 Three new permission keys (registered via catalog SoT)

| Key | Default | Purpose |
|---|---|---|
| `visitors:invite` | true (employee role) | Create invitations + use composer line |
| `visitors:reception` | **false** (opt-in via role admin) | Access `/reception/*` workspace + `/desk/visitors` lens + check-in actions |
| `visitors:read_all` | false (admin role only) | Override: see every visitor in tenant regardless of building scope |

Reviewer C10 resolved: `visitors:reception` defaults OFF, requires explicit grant via tenant role admin. Tenants opt in by granting to a role they already have ("Service Desk", "Reception", whatever they call it).

### 13.2 Visibility rules (3-tier model)

`visitor_visibility_ids(user_id, tenant_id)` SQL function:

- **Tier 1 — Hosts** (always): see visits where they're primary or in `visitor_hosts`.
- **Tier 2 — Operators**: with `visitors:reception` permission AND building in their location scope (existing `org_node_location_grants`).
- **Tier 3 — Override**: with `visitors:read_all`, see everything.

`VisitorService.list()` JOINs against this function. The function is used as the authoritative predicate; no hand-rolled visibility queries.

### 13.3 Cross-building invite scope

`InvitationService.create()` enforces inviter's location grants cover the target building (reviewer C3). Otherwise 403.

---

## 14. GDPR integration

### 14.1 Inherits from baseline

Visitor PII is a `persons` row → flows through the existing GDPR pipeline (`PrivacyComplianceModule`, `visitor-records.adapter.ts`).

### 14.2 Adapter alignment (reviewer B4)

The adapter at lines 43, 121, 139 reads `host_person_id` (legacy column). Two paths:

- **(a)** Keep `host_person_id` populated to match `visitors.primary_host_person_id`. Backfill in the same migration: `update visitors set host_person_id = primary_host_person_id where host_person_id is null and primary_host_person_id is not null`. Going forward, `VisitorService.transitionStatus` and create/update flows write both columns.
- **(b)** Rewrite the adapter to JOIN through `visitor_hosts`. Cleaner long-term but riskier for v1.

**v1 ships (a)** — keep both columns synchronized. Mark the adapter rewrite as a v2 cleanup when the rest of the codebase has migrated off `host_person_id`.

### 14.3 Retention defaults

Per GDPR baseline §3:
- Visit records: 180 days default, max 365 days with LIA.
- Visitor PII (in persons): 180 days default.
- Photos / ID scans: not stored in v1 (kiosk-lite excludes them).

### 14.4 Right of erasure

A visitor (or their employer) can request erasure via `privacy@tenant.com`. Admin invokes per-person erasure flow → cascade clears their persons row → all linked visitors records' PII is anonymized via the existing pipeline. Aggregate stats preserved.

---

## 15. Slice/phasing — Approach 1, single coherent v1 ship

Per locked decision: everything in this spec ships as one release.

### Sequence within the v1 build

The work splits into roughly 7 sub-tracks. They have dependencies; this is the implementation order:

1. **Migrations** (foundation; nothing else builds without it).
   - Visitors table extensions + status backfill + new check.
   - `visitor_types` (with default seeds via per-tenant trigger) + `visitor_hosts` + `visitor_pass_pool` + `visit_invitation_tokens`.
   - Composite FKs + unique on `visitors(tenant_id, id)`.
   - RLS policies + grants on every new table.
   - Functions: `pass_pool_for_space`, `visitor_visibility_ids`, `validate_invitation_token`, status transition trigger, pool space-kind trigger.
   - `spaces.uses_visitor_passes`, `spaces.timezone`.
   - `host_person_id` backfill from `primary_host_person_id`.
2. **VisitorsModule backend** — services, controllers, DTOs.
3. **Approval module dispatcher edit** — add `visitor_invite` branch + `forwardRef` wiring.
4. **Bundle cascade events + adapter** — emit events from `BundleCascadeService`; subscribe in `VisitorsModule`.
5. **Email infrastructure** — invite email template + cancel link generation + day-before reminder cron + `mail_delivery_events` integration.
6. **Frontend surfaces** — portal invite + composer line + reception workspace shell + reception today-view + admin pages + kiosk-lite + visitor cancel landing.
7. **EOD sweep worker** — cron, lease, idempotent.

### Test coverage (qa-engineer pattern)

- Per acceptance criterion (§16), one happy-path test minimum.
- State machine: every transition + every invalid transition.
- Cross-tenant: every new table tested for cross-tenant leak (`assertCrossTenantBlocked`).
- Pass pool inheritance: every layer (building only, site only, both, neither, opt-out).
- Bundle cascade matrix: every cell.
- Walk-up + approval: per visitor type config combinations.
- Kiosk QR + name-typed paths.
- EOD sweep: idempotent re-run; lease conflict; partial sweep on crash.

---

## 16. Acceptance criteria

1. Host invites visitor via `/portal/visitors/invite` → visitor receives English email with cancel link + meeting details + map link.
2. Host invites visitor via booking composer "Visitor" line → visitor record links to bundle; cancellation cascades correctly per matrix.
3. Visitor arrives → kiosk QR scan flow completes in <30 seconds → host gets email + in-app + Notification API event.
4. Visitor arrives → kiosk name-typed fallback resolves visitor in <60 seconds.
5. Visitor walks up at kiosk for an `allow_walk_up=true` type with no `requires_approval` → check-in completes.
6. Visitor walks up at kiosk for `requires_approval=true` type → "Please see reception" deny screen.
7. Reception's `/reception/today` resolves a visitor by first-name search in <3 seconds.
8. Reception backdates Marleen's arrival to 10:15 when entering at 11:30 → audit captures both `arrived_at` and `logged_at`.
9. Reception adds walk-up via quick-add → visitor record created with `arrived_at = now`, host pinged.
10. Reception assigns physical pass at check-in → pass status='in_use', current_visitor_id linked.
11. Reception checks out visitor → pass return confirmed → pass status='available'.
12. Reception checks out without returning pass → modal prompts → "Mark missing" → pass status='lost', logged in audit.
13. EOD sweep at 18:00 building-local → expected → no_show; arrived → checked_out + auto_checked_out=true.
14. Multi-host: 3 hosts on a visitor → all notified on arrival → first to acknowledge owns visit.
15. Approval required: visitor invite created → status='pending_approval' → approver decides → email goes (if approved) or visitor's status moves to denied.
16. Bundle moves: visitor's `expected_at` updates if status='expected'; host alerted (no visitor email) if status='arrived'.
17. Visitor cancels via email link → confirmation interstitial → status='cancelled' → host notified.
18. Pool inheritance: building-level pool overrides site-level; building with `uses_visitor_passes=false` opts out entirely.
19. Cross-building: employee at HQ Amsterdam cannot invite visitor at HQ Rotterdam (no scope) → 403.
20. GDPR retention: visitor at 180 days → anonymization runs → persons row PII replaced; visitor records preserved with anonymized refs.
21. Reception "Yesterday's loose ends" tile: shows 12 auto-checked-out + 3 unreturned passes; reconciliation actions work.
22. Cross-tenant: every new table blocks cross-tenant access via RLS + composite FK guard.
23. Reception can print the daily list (`/reception/daglijst`) on A4.

---

## 17. Risks + mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| English-only visitor email rejected by NL/BE customers | Medium | High | Customer-expectation set at sales/migration time. Platform-wide translation pass remains the path. Proper i18n primitives mean rapid translation when stable |
| Kiosk-lite minus photo/NDA still doesn't fully replace Envoy | Medium | High | v1 covers the 80% case (QR + check-in + host-notify + paper badge from reception). Photo/NDA/ID scan land in v2 with full kiosk |
| Cross-tenant FK gap regressed | Low | Critical | Composite FKs enforced at DB; per-table RLS-per-verb; cross-tenant test required for every new table |
| GDPR adapter break from multi-host migration | Medium | High | Keep `host_person_id` populated via backfill + write-both pattern; adapter rewrite deferred to v2 cleanup |
| Status enum cutover loses data | Low | Critical | Backfill BEFORE check swap; rollback path documented (see §18) |
| EOD sweep crashes mid-run leaving partial state | Low | Medium | Lease + idempotent re-runs (00177 pattern); cron retries every 15 min from 17:30-19:00 |
| Reception 9am rush bottleneck | Medium | Medium | Search is autofocused + fuzzy + keyboard-driven. Kiosk parallelizes. Quick-add covers walk-ups |
| Pass pool inheritance walk is N+1 across spaces tree | Low | Medium | `pass_pool_for_space()` is a single recursive CTE call. Indexed on `(tenant_id, space_id)` |
| Visitor cancel link leaks via email forward | Low | Medium | Token is single-use (used_at enforced); confirmation interstitial; cancel only valid while status='expected' |
| Anonymous kiosk token compromised | Low | High | 90-day rotation; bound to (tenant_id + building_id); scope is checkin only — token cannot read or modify outside its tenant + building |
| Bundle cascade adapter misses an event type | Medium | Medium | Spec lists exact events emitted (§10.1); test coverage per matrix cell (§15) |

---

## 18. Rollback path

For the destructive parts of the migration (status enum widening + composite FKs):

1. **Status enum widening is one-way safe** — the new enum is a superset. Old rows with `pre_registered`/`approved`/`checked_in` are backfilled to `expected`/`arrived` BEFORE the constraint swap.
2. **If we must roll back within 24h of deployment:**
   - Re-add the old check constraint with the wider union (both old + new values) so existing rows pass.
   - Roll back the API layer to the v0 module.
   - Future: schedule a separate "narrow the constraint" migration once API is stable.
3. **After 24h with new visitor records created using new statuses (`pending_approval`/`denied`), rollback is no longer safe.** Decision-partner before push.

The migrations explicitly state in their headers: "no rollback after Day 2 — design partner before push".

---

## 19. v2 backlog (consolidated)

What's deliberately deferred from v1, with rationale:

- **Kiosk depth** — photo capture, NDA on screen, ID scan, Bluetooth label printer.
- **Watchlist + per-building soft block** — bundle and ship together when security-conscious customers materialize.
- **MS Graph / Outlook detection** — depends on the foundational MS Graph integration spec landing first.
- **Fire roll-call / BHV evacuation export** — legal compliance is on tenants in v1; sales risk acknowledged.
- **VIP / "do not announce" privacy flag.**
- **Allergy / access-needs notes.**
- **Emergency contact for visitor.**
- **Pre-arrival NDA via email** (couples with kiosk).
- **Standalone recurring visitor invitations** (no attached booking).
- **Visitor self-checkout via email link** — explicitly rejected on security grounds; not a v2 candidate either.
- **Lobby panel** (separate wall-mounted display) — single-purpose UX worth building once reception workspace tells us what reception teams actually need to display.
- **Arrival confirmation email post-checkin** (V1 from open-questions resolution — proof of attendance).
- **`host_person_id` adapter rewrite** — drop the legacy column once the GDPR adapter is rewritten to JOIN through `visitor_hosts`.
- **NL + FR translation** — part of the platform-wide translation pass.
- **PWA push notifications for hosts** — platform-level project; visitors gets it free when it lands.
- **SMS notifications for hosts.**
- **Building access control hardware integration.**
- **Facial recognition.**
- **Visitor mobile app.**

---

## 20. References

- [`docs/booking-platform-roadmap.md`](../../booking-platform-roadmap.md) §E.
- [`docs/competitive-benchmark.md`](../../competitive-benchmark.md).
- [`docs/visibility.md`](../../visibility.md) — 3-tier visibility model.
- [`docs/users.md`](../../users.md) — visitor + receptionist personas.
- [`docs/open-questions-resolution-2026-04-28.md`](../../open-questions-resolution-2026-04-28.md) — V1-V8 visitor pre-resolved questions.
- Sibling specs:
  - [GDPR baseline](2026-04-27-gdpr-baseline-design.md).
  - [MS Graph integration](2026-04-27-microsoft-graph-integration-design.md) — deferred upstream of v1.
  - [Vendor portal Phase B](2026-04-27-vendor-portal-phase-b-design.md) — token auth pattern reused.
- Existing migrations:
  - `00015_visitors.sql` — original visitors table.
  - `00159_reservation_visitors.sql` — reservation junction (still used).
  - `00160_reservation_visitors_rls_hardening.sql` — RLS pattern reference.
  - `00164_gdpr_persons_visitors_anonymization.sql` — anonymization columns.
  - `00177_daglijst_lease_fence.sql` — lease pattern reference.
  - `00183_mail_delivery_events.sql` — mail delivery pattern reference.
  - `00187_tickets_visible_for_actor.sql` — visibility function pattern reference.
- Memory:
  - `project_visitors_track_split_off.md` — parallel backend workstream.
  - `project_legacy_replacement.md` — v1 must support migration from Envoy/Proxyclick.
  - `feedback_no_friction_for_data.md` — visitors are external; minimize what we ask.
  - `feedback_quality_bar_comprehensive.md` — best-in-class scope.
  - `project_market_benelux.md` — NL primary; FR for BE (deferred).
  - `project_industry_mix.md` — corporate HQ-led visitor patterns.
  - `feedback_evaluate_infra_for_endgame.md` — kiosk re-scoping driven by this rule.
  - `feedback_tenant_id_ultimate_rule.md` — cross-tenant guards are P0.

---

**Maintenance rule:** when implementation diverges from this spec, update the spec first. When adding a new visitor type, extend the `visitor_types` lookup; never duplicate architecture. Touch any of `apps/api/src/modules/visitors/**`, `visitors` table, `visitor_hosts`, `visitor_pass_pool`, or `visit_invitation_tokens` migration → update this doc in the same PR.
