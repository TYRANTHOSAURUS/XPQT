# Portal Redesign — Wave 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the catalog detail page, the request submission form, and the My Requests + request detail pages — completing the visible portal experience for v1.

**Architecture:** Three rewrites + one new page + a new shared primitive. Catalog detail and form use the new portal shell + `PortalPage` wrapper from Wave 1. The form gains semantic groupings + `FieldChips` for small-enum fields + a sticky SLA-aware footer. My Requests gets the unified list shape (rows w/ icon + status badge + tabs). A new request-detail page (`/portal/requests/:id`) renders the conversation thread + metadata sidebar + SLA ring.

**Tech Stack:** React 19 + Vite + Tailwind v4 + shadcn/ui (frontend), NestJS (backend ticket activity already exists).

**Spec:** [`docs/superpowers/specs/2026-04-24-portal-visual-redesign-design.md`](../specs/2026-04-24-portal-visual-redesign-design.md) — Slices 4 + 5.

**Wave 1 baseline (already shipped on `feat/portal-redesign`):**
- New top-nav shell + bottom tabs.
- `portal_appearance` + `portal_announcements` data + admin surfaces.
- Category cover columns + `CategoryCoverPicker` admin UI.
- Redesigned home page (hero + cards + activity panel + announcement).
- Routes already wired: `/portal/requests`, `/portal/catalog/:id`, `/portal/submit/:id?`.

---

## File structure

### Frontend — create

- `apps/web/src/components/ui/field-chips.tsx` — new primitive: chip-style multi/single-select for small enum fields, used inside `<Field>` per the form rules.
- `apps/web/src/components/portal/portal-category-banner.tsx` — banner for catalog detail (cover image + breadcrumb + title + description).
- `apps/web/src/components/portal/portal-services-grid.tsx` — wide service tiles with icon + name + description + "Other" tile.
- `apps/web/src/components/portal/portal-subcategory-rail.tsx` — compact subcategory cards (icon + name + count).
- `apps/web/src/components/portal/portal-form-header.tsx` — focused header for the request form (icon + title + "what happens next" line).
- `apps/web/src/components/portal/portal-form-footer.tsx` — sticky bottom actions row (SLA hint + Save draft + Submit).
- `apps/web/src/components/portal/portal-request-row.tsx` — unified row in My Requests list.
- `apps/web/src/components/portal/portal-sla-ring.tsx` — conic-gradient progress ring.
- `apps/web/src/components/portal/portal-request-thread.tsx` — conversation thread renderer for request detail.
- `apps/web/src/components/portal/portal-request-sidebar.tsx` — metadata sidebar (status, assignee, location, fields).
- `apps/web/src/pages/portal/request-detail.tsx` — new page mounted at `/portal/requests/:id`.

### Frontend — modify

- `apps/web/src/pages/portal/catalog-category.tsx` — full rewrite using new components.
- `apps/web/src/pages/portal/submit-request.tsx` — full rewrite using new components.
- `apps/web/src/pages/portal/my-requests.tsx` — refactor to unified list shape.
- `apps/web/src/App.tsx` — add `/portal/requests/:id` route.

### Backend

No new endpoints required for Wave 2. The existing endpoints suffice:
- `GET /tickets?requester_person_id=…` — already used by the Wave 1 home activity panel.
- `GET /tickets/:id` — fetches a single ticket with its activity feed.
- `POST /tickets/:id/activities` — already exists for adding messages.

(A future Wave would build `/portal/my-feed` to merge tickets + bookings + visitors + orders. Out of scope here — bookings/visitors/orders are Phase 2.)

---

## Phases

- **Phase E — Shared primitives** (Tasks 1–2): `FieldChips`, `PortalSlaRing`.
- **Phase F — Catalog detail + Form rewrite** (Tasks 3–6): banner, services grid, subcategory rail, form header/footer, page rewrites.
- **Phase G — My Requests + Request detail** (Tasks 7–11): unified list, row component, request thread, metadata sidebar, detail page, route.

---

## Phase E — Shared primitives

### Task 1: `FieldChips` primitive

**Files:**
- Create: `apps/web/src/components/ui/field-chips.tsx`

A chip-style replacement for a `Select` when an enum has ≤6 options. Lives next to other shadcn primitives (`field.tsx`, `radio-group.tsx`).

- [ ] **Step 1: Implementation**

```tsx
// apps/web/src/components/ui/field-chips.tsx
import { cn } from '@/lib/utils';

export interface FieldChipsOption<T extends string = string> {
  value: T;
  label: string;
}

interface SingleProps<T extends string> {
  options: FieldChipsOption<T>[];
  value: T | null;
  onChange: (next: T) => void;
  multi?: false;
  className?: string;
}

interface MultiProps<T extends string> {
  options: FieldChipsOption<T>[];
  value: T[];
  onChange: (next: T[]) => void;
  multi: true;
  className?: string;
}

export function FieldChips<T extends string>(props: SingleProps<T> | MultiProps<T>) {
  const { options, className } = props;
  const isSelected = (v: T) =>
    props.multi ? props.value.includes(v) : props.value === v;

  const onClick = (v: T) => {
    if (props.multi) {
      const next = props.value.includes(v)
        ? props.value.filter((x) => x !== v)
        : [...props.value, v];
      props.onChange(next);
    } else {
      props.onChange(v);
    }
  };

  return (
    <div className={cn('flex flex-wrap gap-1.5', className)} role={props.multi ? 'group' : 'radiogroup'}>
      {options.map((opt) => {
        const selected = isSelected(opt.value);
        return (
          <button
            key={opt.value}
            type="button"
            role={props.multi ? 'checkbox' : 'radio'}
            aria-checked={selected}
            onClick={() => onClick(opt.value)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50',
              selected
                ? 'bg-foreground text-background border-foreground'
                : 'bg-transparent text-muted-foreground border-border hover:text-foreground hover:bg-muted/40',
            )}
            style={{ transitionTimingFunction: 'var(--ease-snap)', transitionDuration: '120ms' }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/ui/field-chips.tsx
git commit -m "feat(ui): add FieldChips primitive for small-enum fields"
```

### Task 2: `PortalSlaRing`

**Files:**
- Create: `apps/web/src/components/portal/portal-sla-ring.tsx`

- [ ] **Step 1: Implementation**

```tsx
// apps/web/src/components/portal/portal-sla-ring.tsx
import { cn } from '@/lib/utils';

interface Props {
  /** Progress 0-1 (0 = not started, 1 = SLA fully consumed). */
  progress: number;
  /** When true, shows a red ring (SLA breached). */
  breached?: boolean;
  size?: number;
  className?: string;
}

/**
 * Compact conic-gradient progress ring for SLA visibility.
 * Green → amber when >0.66 → red when >0.85 or breached.
 */
export function PortalSlaRing({ progress, breached, size = 32, className }: Props) {
  const clamped = Math.max(0, Math.min(1, progress));
  const pct = Math.round(clamped * 100);
  const color = breached || clamped > 0.85
    ? 'rgb(239 68 68)'   // red-500
    : clamped > 0.66
      ? 'rgb(234 179 8)'  // yellow-500
      : 'rgb(34 197 94)'; // emerald-500

  return (
    <div
      className={cn('relative shrink-0 rounded-full', className)}
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${pct}%, rgb(229 231 235 / 0.3) 0)`,
      }}
      aria-label={`SLA ${pct}% used`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="absolute inset-1 rounded-full bg-background" />
    </div>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-sla-ring.tsx
git commit -m "feat(portal): add PortalSlaRing (conic-gradient progress)"
```

---

## Phase F — Catalog detail + Form rewrite

### Task 3: `PortalCategoryBanner` + `PortalSubcategoryRail` + `PortalServicesGrid`

**Files:**
- Create: `apps/web/src/components/portal/portal-category-banner.tsx`
- Create: `apps/web/src/components/portal/portal-subcategory-rail.tsx`
- Create: `apps/web/src/components/portal/portal-services-grid.tsx`

- [ ] **Step 1: `PortalCategoryBanner`**

```tsx
// apps/web/src/components/portal/portal-category-banner.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

const PLATFORM_COVERS: Record<string, string> = {
  'platform:cover-1': 'bg-gradient-to-br from-blue-500/70 to-indigo-700',
  'platform:cover-2': 'bg-gradient-to-br from-purple-500/70 to-violet-700',
  'platform:cover-3': 'bg-gradient-to-br from-emerald-500/70 to-teal-700',
  'platform:cover-4': 'bg-gradient-to-br from-orange-500/70 to-amber-700',
};

interface Props {
  name: string;
  description?: string | null;
  parentName?: string | null;
  parentId?: string | null;
  iconName?: string | null;
  cover_source?: 'image' | 'icon';
  cover_image_url?: string | null;
}

export function PortalCategoryBanner({ name, description, parentName, parentId, iconName, cover_source, cover_image_url }: Props) {
  const platformClass = cover_image_url ? PLATFORM_COVERS[cover_image_url] : null;
  const useImage = cover_source === 'image' && cover_image_url;
  const Icon = iconName && (Icons as Record<string, unknown>)[iconName] as React.ComponentType<{ className?: string }> | undefined;

  return (
    <section className="relative -mx-4 md:-mx-6 lg:-mx-8 overflow-hidden" style={{ minHeight: 'clamp(140px, 22vw, 220px)' }}>
      <div className="absolute inset-0" aria-hidden>
        {useImage && platformClass ? (
          <div className={cn(platformClass, 'h-full w-full')} />
        ) : useImage ? (
          <img src={cover_image_url ?? undefined} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-gradient-to-br from-primary/30 via-primary/10 to-background" />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/15 via-black/35 to-black/65" />
      </div>

      <div className="relative mx-auto max-w-[1600px] px-4 md:px-6 lg:px-8 py-7 md:py-10">
        <nav className="text-xs text-white/70 mb-2 flex items-center gap-1.5" aria-label="Breadcrumb">
          <Link to="/portal" className="hover:text-white/90 underline-offset-2 hover:underline">Home</Link>
          <span aria-hidden>›</span>
          {parentId && parentName ? (
            <>
              <Link to={`/portal/catalog/${parentId}`} className="hover:text-white/90 underline-offset-2 hover:underline">{parentName}</Link>
              <span aria-hidden>›</span>
            </>
          ) : null}
          <span>{name}</span>
        </nav>
        <h1 className="text-2xl md:text-4xl font-semibold tracking-tight text-white text-balance">{name}</h1>
        {description && (
          <p className="mt-2 max-w-prose text-sm md:text-base text-white/80 text-pretty">{description}</p>
        )}
        {!useImage && Icon && (
          <Icon className="absolute right-6 top-6 size-10 md:size-14 text-white/40 hidden sm:block" aria-hidden />
        )}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: `PortalSubcategoryRail`**

```tsx
// apps/web/src/components/portal/portal-subcategory-rail.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

interface SubItem {
  id: string;
  name: string;
  iconName?: string | null;
  count?: number;
}

interface Props {
  items: SubItem[];
  className?: string;
}

export function PortalSubcategoryRail({ items, className }: Props) {
  if (items.length === 0) return null;
  return (
    <section className={cn('space-y-3', className)}>
      <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Subcategories</div>
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-3">
        {items.map((s) => {
          const Icon = s.iconName && (Icons as Record<string, unknown>)[s.iconName] as React.ComponentType<{ className?: string }> | undefined;
          return (
            <Link
              key={s.id}
              to={`/portal/catalog/${s.id}`}
              className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-sm transition-colors hover:bg-accent/40"
              style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '160ms' }}
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                {Icon ? <Icon className="size-3.5" /> : <Icons.FolderOpen className="size-3.5" />}
              </span>
              <span className="flex-1 truncate font-medium">{s.name}</span>
              {typeof s.count === 'number' && (
                <span className="text-xs text-muted-foreground tabular-nums">{s.count}</span>
              )}
            </Link>
          );
        })}
      </div>
    </section>
  );
}
```

- [ ] **Step 3: `PortalServicesGrid`**

```tsx
// apps/web/src/components/portal/portal-services-grid.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';

interface ServiceItem {
  id: string;
  name: string;
  description?: string | null;
  iconName?: string | null;
}

interface Props {
  services: ServiceItem[];
  /** Optional category id used to deep-link the "Other" tile to a generic submit prefilled with the category. */
  categoryIdForOther?: string | null;
  className?: string;
}

export function PortalServicesGrid({ services, categoryIdForOther, className }: Props) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="text-xs uppercase tracking-widest text-muted-foreground font-semibold">Services</div>
      <div className="grid gap-3 sm:grid-cols-2">
        {services.map((s) => {
          const Icon = s.iconName && (Icons as Record<string, unknown>)[s.iconName] as React.ComponentType<{ className?: string }> | undefined;
          return (
            <Link
              key={s.id}
              to={`/portal/submit?type=${encodeURIComponent(s.id)}`}
              className="flex items-start gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-accent/40"
              style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '180ms' }}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {Icon ? <Icon className="size-4" /> : <Icons.HelpCircle className="size-4" />}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold tracking-tight">{s.name}</span>
                {s.description && (
                  <span className="mt-1 block text-xs text-muted-foreground line-clamp-2">{s.description}</span>
                )}
              </span>
            </Link>
          );
        })}
        <Link
          to={categoryIdForOther
            ? `/portal/submit/${encodeURIComponent(categoryIdForOther)}`
            : '/portal/submit'}
          className={cn(
            'flex items-start gap-3 rounded-xl border border-dashed bg-transparent p-4 transition-colors hover:bg-muted/40',
          )}
          style={{ transitionTimingFunction: 'var(--ease-smooth)', transitionDuration: '180ms' }}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <Icons.Plus className="size-4" />
          </span>
          <span className="flex-1">
            <span className="block text-sm font-semibold tracking-tight">Other</span>
            <span className="mt-1 block text-xs text-muted-foreground">Can't find what you need? Submit a general request.</span>
          </span>
        </Link>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-category-banner.tsx apps/web/src/components/portal/portal-subcategory-rail.tsx apps/web/src/components/portal/portal-services-grid.tsx
git commit -m "feat(portal): add catalog detail components (banner + subcategory rail + services grid)"
```

### Task 4: Rewrite `catalog-category.tsx`

**Files:**
- Modify: `apps/web/src/pages/portal/catalog-category.tsx` (full rewrite)

- [ ] **Step 1: Rewrite the page**

```tsx
// apps/web/src/pages/portal/catalog-category.tsx
import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Spinner } from '@/components/ui/spinner';
import { apiFetch } from '@/lib/api';
import { usePortal } from '@/providers/portal-provider';
import { useCatalogCategories } from '@/api/catalog';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalCategoryBanner } from '@/components/portal/portal-category-banner';
import { PortalSubcategoryRail } from '@/components/portal/portal-subcategory-rail';
import { PortalServicesGrid } from '@/components/portal/portal-services-grid';

interface CatalogRequestType {
  id: string;
  name: string;
  description: string | null;
  icon?: string | null;
}

interface PortalCatalogCategoryRow {
  id: string;
  name: string;
  icon: string | null;
  parent_category_id: string | null;
  request_types: CatalogRequestType[];
}

interface PortalCatalogResponse {
  selected_location: { id: string; name: string; type: string };
  categories: PortalCatalogCategoryRow[];
}

interface DbCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  parent_category_id: string | null;
  cover_image_url: string | null;
  cover_source: 'image' | 'icon';
}

export function CatalogCategoryPage() {
  const { categoryId } = useParams();
  const { data: portal } = usePortal();
  const { data: dbCategories } = useCatalogCategories() as { data: DbCategory[] | undefined };

  const currentLocation = portal?.current_location ?? null;
  const [catalog, setCatalog] = useState<PortalCatalogResponse | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!currentLocation) return;
    setLoading(true);
    apiFetch<PortalCatalogResponse>(`/portal/catalog?location_id=${encodeURIComponent(currentLocation.id)}`)
      .then(setCatalog)
      .catch(() => setCatalog(null))
      .finally(() => setLoading(false));
  }, [currentLocation?.id]);

  const { categoryRow, dbCategory, services, subcategories } = useMemo(() => {
    if (!catalog || !categoryId || !dbCategories) {
      return { categoryRow: null, dbCategory: null, services: [], subcategories: [] };
    }
    const visibleIds = new Set(catalog.categories.map((c) => c.id));
    const cat = catalog.categories.find((c) => c.id === categoryId) ?? null;
    const meta = dbCategories.find((c) => c.id === categoryId) ?? null;
    const subs = dbCategories
      .filter((c) => c.parent_category_id === categoryId && visibleIds.has(c.id))
      .map((c) => ({
        id: c.id,
        name: c.name,
        iconName: c.icon,
        count: catalog.categories.find((x) => x.id === c.id)?.request_types.length ?? 0,
      }));
    return {
      categoryRow: cat,
      dbCategory: meta,
      services: cat?.request_types ?? [],
      subcategories: subs,
    };
  }, [catalog, dbCategories, categoryId]);

  const parent = useMemo(() => {
    if (!dbCategory?.parent_category_id || !dbCategories) return null;
    return dbCategories.find((c) => c.id === dbCategory.parent_category_id) ?? null;
  }, [dbCategory, dbCategories]);

  const empty = !loading && subcategories.length === 0 && services.length === 0;

  return (
    <PortalPage bleed>
      <PortalCategoryBanner
        name={dbCategory?.name ?? categoryRow?.name ?? 'Services'}
        description={dbCategory?.description}
        parentName={parent?.name}
        parentId={parent?.id}
        iconName={dbCategory?.icon}
        cover_source={dbCategory?.cover_source ?? 'icon'}
        cover_image_url={dbCategory?.cover_image_url ?? null}
      />

      <div className="px-4 md:px-6 lg:px-8 mt-8 md:mt-10 space-y-10">
        {/* KB slot — Phase 4. Hidden until articles backend exists. */}
        {/* <PortalCategoryAnswers categoryId={categoryId} /> */}

        {loading && (
          <div className="flex items-center justify-center py-12">
            <Spinner className="size-6 text-muted-foreground" />
          </div>
        )}

        {subcategories.length > 0 && <PortalSubcategoryRail items={subcategories} />}
        {services.length > 0 && (
          <PortalServicesGrid
            services={services.map((s) => ({ id: s.id, name: s.name, description: s.description, iconName: s.icon ?? null }))}
            categoryIdForOther={categoryId ?? null}
          />
        )}

        {empty && (
          <div className="rounded-xl border bg-card px-6 py-12 text-center">
            <p className="text-sm text-muted-foreground">
              No services available in this category at your selected location.
            </p>
          </div>
        )}
      </div>
    </PortalPage>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/portal/catalog-category.tsx
git commit -m "feat(portal): redesign catalog detail page (banner + subcategories + services grid)"
```

### Task 5: `PortalFormHeader` + `PortalFormFooter`

**Files:**
- Create: `apps/web/src/components/portal/portal-form-header.tsx`
- Create: `apps/web/src/components/portal/portal-form-footer.tsx`

- [ ] **Step 1: `PortalFormHeader`**

```tsx
// apps/web/src/components/portal/portal-form-header.tsx
import * as Icons from 'lucide-react';
import { Link } from 'react-router-dom';

interface Props {
  iconName?: string | null;
  name: string;
  whatHappensNext?: string | null;
  backTo?: string;
  backLabel?: string;
}

export function PortalFormHeader({ iconName, name, whatHappensNext, backTo, backLabel }: Props) {
  const Icon = iconName && (Icons as Record<string, unknown>)[iconName] as React.ComponentType<{ className?: string }> | undefined;
  return (
    <header className="space-y-4">
      {backTo && (
        <Link to={backTo} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
          <Icons.ArrowLeft className="size-3.5" />
          {backLabel ?? 'Back'}
        </Link>
      )}
      <div className="flex items-start gap-4 pb-5 border-b">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          {Icon ? <Icon className="size-5" /> : <Icons.HelpCircle className="size-5" />}
        </span>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">{name}</h1>
          {whatHappensNext && (
            <p className="mt-1.5 max-w-prose text-sm text-muted-foreground text-pretty">{whatHappensNext}</p>
          )}
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: `PortalFormFooter`**

```tsx
// apps/web/src/components/portal/portal-form-footer.tsx
import { Button } from '@/components/ui/button';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  slaHint?: string | null;
  onCancel?: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  submitting?: boolean;
  disabled?: boolean;
  className?: string;
}

export function PortalFormFooter({ slaHint, onCancel, onSubmit, submitLabel, cancelLabel, submitting, disabled, className }: Props) {
  return (
    <footer className={cn('sticky bottom-0 -mx-4 md:-mx-6 lg:-mx-8 mt-10 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/85', className)}>
      <div className="mx-auto max-w-[920px] px-4 md:px-6 lg:px-8 py-3 flex items-center justify-between gap-3">
        {slaHint ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="size-3.5" />
            <span>{slaHint}</span>
          </div>
        ) : <span aria-hidden />}
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
              {cancelLabel ?? 'Cancel'}
            </Button>
          )}
          {onSubmit && (
            <Button size="sm" onClick={onSubmit} disabled={submitting || disabled}>
              {submitting ? 'Submitting…' : (submitLabel ?? 'Submit request')}
            </Button>
          )}
        </div>
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-form-header.tsx apps/web/src/components/portal/portal-form-footer.tsx
git commit -m "feat(portal): add PortalFormHeader + PortalFormFooter (sticky SLA-aware actions)"
```

### Task 6: Rewrite `submit-request.tsx`

**Files:**
- Modify: `apps/web/src/pages/portal/submit-request.tsx`

- [ ] **Step 1: Read the existing file** (`wc -l` shows 465 lines). Identify the data-fetch + submit logic (it uses `apiFetch` for `/portal/catalog`, `/config-entities/<form_schema_id>`, and `/portal/tickets`). Preserve all of that. The rewrite is purely visual.

- [ ] **Step 2: Replace the rendered JSX** to use:
  - `PortalPage` wrapper.
  - `PortalFormHeader` at top with: `iconName={selectedRT.icon}`, `name={selectedRT.name}`, `whatHappensNext={"Usually resolved within 4 hours"}` (when SLA policy known) or just the request-type description, and `backTo={parentCategoryId ? "/portal/catalog/" + parentCategoryId : "/portal"}`.
  - Form body wrapped in `<FieldGroup>` (per CLAUDE.md form composition rule). Each field a `<Field>` with `<FieldLabel>` + control + optional `<FieldDescription>`.
  - For dynamic form-schema fields:
    - If field type is `enum` and `options.length <= 6` → render with `<FieldChips>` (multi-select if `multiple: true`, otherwise single).
    - Else fall back to existing rendering (Input, Textarea, Select).
  - `PortalFormFooter` at the bottom with `slaHint` derived from the request-type's SLA policy if present (e.g. "Usually resolved within 4 hours" — keep simple), `onSubmit` wired to existing submission handler, `submitting` state mirrored.
- [ ] **Step 3: Drop the old success card** (the "Your request has been submitted" full-page state). Replace with:
  - On submit success, navigate to `/portal/requests/:newId` (the request-detail page from Task 11).
  - Until Task 11 lands, navigate to `/portal/requests` (the list).
- [ ] **Step 4: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/portal/submit-request.tsx
git commit -m "feat(portal): redesign request submission form (focused header + chips + sticky footer)"
```

The task is "match the established Wave 1 visual language for forms inside the portal." Keep all functional behavior (form-schema-driven fields, validation, location/asset prerequisites, on-behalf-of) intact.

---

## Phase G — My Requests + Request detail

### Task 7: `PortalRequestRow`

**Files:**
- Create: `apps/web/src/components/portal/portal-request-row.tsx`

- [ ] **Step 1: Implementation**

```tsx
// apps/web/src/components/portal/portal-request-row.tsx
import { Link } from 'react-router-dom';
import * as Icons from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';

export type RequestKind = 'ticket' | 'booking' | 'visitor' | 'order';

interface Props {
  href: string;
  kind: RequestKind;
  title: string;
  subtitle?: string | null;
  timestamp: string;
  assigneeName?: string | null;
  status: { label: string; tone: 'inprog' | 'waiting' | 'scheduled' | 'done' | 'breached' };
}

const KIND_STYLES: Record<RequestKind, { Icon: React.ComponentType<{ className?: string }>; tile: string }> = {
  ticket:  { Icon: Icons.FileText,     tile: 'bg-blue-500/15 text-blue-500' },
  booking: { Icon: Icons.CalendarDays, tile: 'bg-purple-500/15 text-purple-500' },
  visitor: { Icon: Icons.UserPlus,     tile: 'bg-pink-500/15 text-pink-500' },
  order:   { Icon: Icons.ShoppingCart, tile: 'bg-emerald-500/15 text-emerald-500' },
};

const STATUS_STYLES: Record<Props['status']['tone'], string> = {
  inprog:    'bg-emerald-500/15 text-emerald-500',
  waiting:   'bg-yellow-500/15 text-yellow-500',
  scheduled: 'bg-purple-500/15 text-purple-500',
  done:      'bg-muted text-muted-foreground',
  breached:  'bg-red-500/15 text-red-500',
};

export function PortalRequestRow({ href, kind, title, subtitle, timestamp, assigneeName, status }: Props) {
  const { Icon, tile } = KIND_STYLES[kind];
  return (
    <Link
      to={href}
      className="flex items-center gap-4 border-b px-4 py-3.5 transition-colors hover:bg-accent/30 last:border-b-0"
    >
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', tile)}>
        <Icon className="size-4" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block truncate text-sm font-medium">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{subtitle}</span>}
      </span>
      <time className="hidden md:inline shrink-0 text-xs text-muted-foreground tabular-nums" dateTime={timestamp} title={formatFullTimestamp(timestamp)}>
        {formatRelativeTime(timestamp)}
      </time>
      {assigneeName && (
        <span className="hidden md:inline shrink-0 text-xs text-muted-foreground truncate max-w-[140px]">{assigneeName}</span>
      )}
      <span className={cn('shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium tabular-nums', STATUS_STYLES[status.tone])}>
        {status.label}
      </span>
    </Link>
  );
}
```

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-request-row.tsx
git commit -m "feat(portal): add PortalRequestRow (unified row for tickets/bookings/visitors/orders)"
```

### Task 8: Refactor `my-requests.tsx`

**Files:**
- Modify: `apps/web/src/pages/portal/my-requests.tsx` (full rewrite — preserve `useTicketList` data hook)

- [ ] **Step 1: Read the file**, identify the existing `useTicketList` call + ticket shape. Preserve.

- [ ] **Step 2: Replace JSX** with:
  - `PortalPage` wrapper.
  - Page header: title "My Requests" + subtitle "Everything you've submitted, booked, or invited." + primary action button "New request" linking to `/portal`.
  - Tabs: All / Open / Scheduled / Closed using shadcn `Tabs` primitives. Filter the ticket list based on the selected tab.
  - List of `<PortalRequestRow>` rows wrapped in a single `rounded-xl border bg-card` container.
  - Empty state when filtered list is empty: "No requests in this view."

For each ticket, derive:
- `kind="ticket"` (Wave 2 only — bookings/visitors/orders empty until Phase 2)
- `title = ticket.title`
- `subtitle = ticket.assigned_team?.name + " · " + (request type name if present)`
- `timestamp = ticket.created_at`
- `assigneeName = ticket.assigned_user?.first_name + " " + ticket.assigned_user?.last_name` (or null)
- `status` derived from `status_category`:
  - `new` → `{ label: 'Submitted', tone: 'scheduled' }`
  - `in_progress` → `{ label: 'In progress', tone: 'inprog' }`
  - `waiting` → `{ label: 'Waiting', tone: 'waiting' }`
  - `resolved` → `{ label: 'Resolved', tone: 'done' }`
  - `closed` → `{ label: 'Closed', tone: 'done' }`
  - if `sla_resolution_breached_at` → override to `{ label: 'Delayed', tone: 'breached' }`

- [ ] **Step 3: Tab counts** show `tabular-nums` next to each tab label (only if useTicketList returns counts; otherwise compute client-side from the loaded tickets).

- [ ] **Step 4: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/portal/my-requests.tsx
git commit -m "feat(portal): redesign My Requests with unified row pattern + tabs"
```

### Task 9: `PortalRequestThread` + `PortalRequestSidebar`

**Files:**
- Create: `apps/web/src/components/portal/portal-request-thread.tsx`
- Create: `apps/web/src/components/portal/portal-request-sidebar.tsx`

- [ ] **Step 1: `PortalRequestThread`**

```tsx
// apps/web/src/components/portal/portal-request-thread.tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatRelativeTime, formatFullTimestamp } from '@/lib/format';
import { Paperclip } from 'lucide-react';

export interface ThreadEvent {
  id: string;
  kind: 'message' | 'system';
  authorName?: string | null;
  authorRole?: 'requester' | 'assignee' | 'system';
  authorAvatarUrl?: string | null;
  body: string;
  createdAt: string;
}

interface Props {
  events: ThreadEvent[];
  onReply?: (body: string) => Promise<void>;
}

export function PortalRequestThread({ events, onReply }: Props) {
  const [reply, setReply] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!reply.trim() || !onReply) return;
    setSubmitting(true);
    try {
      await onReply(reply.trim());
      setReply('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-1">
      <ol className="space-y-2">
        {events.map((evt) => (
          <li key={evt.id} className={evt.kind === 'system' ? 'pl-11 py-1.5 text-xs text-muted-foreground' : 'flex items-start gap-3'}>
            {evt.kind === 'message' ? (
              <>
                <Avatar className="size-8 mt-0.5">
                  <AvatarImage src={evt.authorAvatarUrl ?? undefined} alt="" />
                  <AvatarFallback className="bg-gradient-to-br from-blue-500 to-violet-600 text-white text-[10px] font-semibold">
                    {(evt.authorName ?? '?').slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="text-xs">
                    <span className="font-semibold">{evt.authorName ?? 'Unknown'}</span>
                    {evt.authorRole && <span className="ml-2 text-muted-foreground capitalize">{evt.authorRole}</span>}
                    <time className="ml-2 text-muted-foreground" dateTime={evt.createdAt} title={formatFullTimestamp(evt.createdAt)}>
                      {formatRelativeTime(evt.createdAt)}
                    </time>
                  </div>
                  <div className="mt-1.5 rounded-lg border bg-card px-3 py-2 text-sm whitespace-pre-wrap">
                    {evt.body}
                  </div>
                </div>
              </>
            ) : (
              <span>· {evt.body}<time className="ml-2 opacity-70" dateTime={evt.createdAt}>{formatRelativeTime(evt.createdAt)}</time></span>
            )}
          </li>
        ))}
      </ol>
      {onReply && (
        <div className="mt-4 rounded-lg border bg-card">
          <Textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            placeholder="Write a reply…"
            className="min-h-[72px] border-0 focus-visible:ring-0"
            disabled={submitting}
          />
          <div className="flex items-center justify-end gap-2 px-2 py-2 border-t">
            <Button variant="ghost" size="sm" disabled>
              <Paperclip className="size-3.5 mr-1" />
              Attach
            </Button>
            <Button size="sm" onClick={submit} disabled={!reply.trim() || submitting}>
              {submitting ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: `PortalRequestSidebar`**

```tsx
// apps/web/src/components/portal/portal-request-sidebar.tsx
import { ReactNode } from 'react';
import { PortalSlaRing } from './portal-sla-ring';
import { cn } from '@/lib/utils';

interface SlaProps {
  progress: number;
  remainingLabel: string;
  breached?: boolean;
}

interface Props {
  status: { label: string; sla?: SlaProps };
  blocks: Array<{ label: string; value: ReactNode; description?: string }>;
  className?: string;
}

export function PortalRequestSidebar({ status, blocks, className }: Props) {
  return (
    <aside className={cn('space-y-4', className)}>
      <section>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">Status</div>
        <div className={cn(
          'flex items-center gap-3 rounded-xl border px-3 py-2.5',
          status.sla?.breached ? 'border-red-500/30 bg-red-500/5' :
            status.sla && status.sla.progress > 0.66 ? 'border-yellow-500/30 bg-yellow-500/5' :
            'border-emerald-500/30 bg-emerald-500/5',
        )}>
          {status.sla && (
            <PortalSlaRing progress={status.sla.progress} breached={status.sla.breached} />
          )}
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate">{status.label}</div>
            {status.sla && (
              <div className="text-[11px] text-muted-foreground">{status.sla.remainingLabel}</div>
            )}
          </div>
        </div>
      </section>

      {blocks.map((b) => (
        <section key={b.label}>
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">{b.label}</div>
          <div className="text-sm">{b.value}</div>
          {b.description && <div className="text-xs text-muted-foreground mt-0.5">{b.description}</div>}
        </section>
      ))}
    </aside>
  );
}
```

- [ ] **Step 3: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/components/portal/portal-request-thread.tsx apps/web/src/components/portal/portal-request-sidebar.tsx
git commit -m "feat(portal): add PortalRequestThread + PortalRequestSidebar"
```

### Task 10: New `request-detail.tsx` page

**Files:**
- Create: `apps/web/src/pages/portal/request-detail.tsx`

- [ ] **Step 1: Implementation**

```tsx
// apps/web/src/pages/portal/request-detail.tsx
import { useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api';
import { PortalPage } from '@/components/portal/portal-page';
import { PortalFormHeader } from '@/components/portal/portal-form-header';
import { PortalRequestThread, type ThreadEvent } from '@/components/portal/portal-request-thread';
import { PortalRequestSidebar } from '@/components/portal/portal-request-sidebar';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';

interface Activity {
  id: string;
  type: string;
  body?: string | null;
  actor?: { id: string | null; first_name: string | null; last_name: string | null; role?: string | null } | null;
  created_at: string;
}

interface TicketDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  status_category: string;
  request_type?: { id: string; name: string; icon: string | null; description: string | null } | null;
  assigned_team?: { id: string; name: string } | null;
  assigned_user?: { id: string; first_name: string; last_name: string } | null;
  location?: { id: string; name: string; type: string } | null;
  created_at: string;
  sla_resolution_due_at: string | null;
  sla_resolution_breached_at: string | null;
  activities?: Activity[];
}

const ticketOptions = (id: string | undefined) =>
  queryOptions({
    queryKey: ['ticket', 'detail', id],
    queryFn: ({ signal }) => apiFetch<TicketDetail>(`/tickets/${id}`, { signal }),
    enabled: Boolean(id),
    staleTime: 10_000,
  });

function deriveSla(ticket: TicketDetail): { progress: number; remainingLabel: string; breached: boolean } | null {
  if (!ticket.sla_resolution_due_at) return null;
  const due = new Date(ticket.sla_resolution_due_at).getTime();
  const created = new Date(ticket.created_at).getTime();
  const now = Date.now();
  const total = Math.max(1, due - created);
  const used = Math.max(0, now - created);
  const progress = Math.min(1, used / total);
  if (ticket.sla_resolution_breached_at || now > due) {
    return { progress: 1, remainingLabel: 'Past due', breached: true };
  }
  const remaining = due - now;
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  const remainingLabel = hours > 0 ? `${hours}h ${minutes}m left` : `${minutes}m left`;
  return { progress, remainingLabel, breached: false };
}

function activitiesToEvents(act: Activity[] | undefined, requesterId: string | null | undefined): ThreadEvent[] {
  if (!act) return [];
  return act.map((a) => {
    if (a.type === 'comment') {
      const author = `${a.actor?.first_name ?? ''} ${a.actor?.last_name ?? ''}`.trim() || 'Unknown';
      const role = a.actor?.id === requesterId ? 'requester' : 'assignee';
      return {
        id: a.id,
        kind: 'message' as const,
        authorName: author,
        authorRole: role,
        body: a.body ?? '',
        createdAt: a.created_at,
      };
    }
    return {
      id: a.id,
      kind: 'system' as const,
      body: a.body ?? a.type.replaceAll('_', ' '),
      createdAt: a.created_at,
    };
  });
}

export function RequestDetailPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { data: ticket, isPending } = useQuery(ticketOptions(id));
  const reply = useMutation<unknown, Error, string>({
    mutationFn: (body) =>
      apiFetch(`/tickets/${id}/activities`, {
        method: 'POST',
        body: JSON.stringify({ type: 'comment', body }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ticket', 'detail', id] }),
  });

  const events = useMemo(
    () => activitiesToEvents(ticket?.activities, ticket && (ticket as unknown as { requester_user_id?: string }).requester_user_id),
    [ticket],
  );
  const sla = ticket ? deriveSla(ticket) : null;

  if (isPending) {
    return (
      <PortalPage>
        <div className="text-sm text-muted-foreground">Loading…</div>
      </PortalPage>
    );
  }
  if (!ticket) {
    return (
      <PortalPage>
        <div className="text-sm text-muted-foreground">Request not found.</div>
      </PortalPage>
    );
  }

  return (
    <PortalPage>
      <Link to="/portal/requests" className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3">
        <ArrowLeft className="size-3.5" /> All requests
      </Link>

      <div className="grid gap-8 md:grid-cols-[1fr_300px]">
        <div className="min-w-0">
          <PortalFormHeader
            iconName={ticket.request_type?.icon ?? null}
            name={ticket.title}
            whatHappensNext={ticket.request_type?.description ?? null}
          />
          <div className="mt-6">
            <PortalRequestThread
              events={[
                ...(ticket.description ? [{
                  id: 'desc',
                  kind: 'message' as const,
                  authorName: 'You',
                  authorRole: 'requester' as const,
                  body: ticket.description,
                  createdAt: ticket.created_at,
                }] : []),
                ...events,
              ]}
              onReply={async (body) => {
                try {
                  await reply.mutateAsync(body);
                  toast.success('Reply sent');
                } catch (e) {
                  toast.error(e instanceof Error ? e.message : 'Send failed');
                }
              }}
            />
          </div>
        </div>

        <PortalRequestSidebar
          status={{
            label: ticket.status_category.replaceAll('_', ' '),
            sla: sla ?? undefined,
          }}
          blocks={[
            {
              label: 'Assignee',
              value: ticket.assigned_user
                ? `${ticket.assigned_user.first_name} ${ticket.assigned_user.last_name}`
                : <span className="text-muted-foreground">Unassigned</span>,
              description: ticket.assigned_team?.name,
            },
            {
              label: 'Location',
              value: ticket.location?.name ?? <span className="text-muted-foreground">Unspecified</span>,
            },
            {
              label: 'Service',
              value: ticket.request_type?.name ?? '—',
            },
          ]}
        />
      </div>
    </PortalPage>
  );
}
```

The `/tickets/:id` payload may include or exclude some of these fields. Match the actual NestJS `getTicket` response shape — adapt the interface and the `deriveSla` / `activitiesToEvents` helpers as needed without changing the visual structure.

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/pages/portal/request-detail.tsx
git commit -m "feat(portal): add request detail page (conversation thread + SLA sidebar)"
```

### Task 11: Wire the route

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1:** Import `RequestDetailPage`. Add a route `<Route path="requests/:id" element={<RequestDetailPage />} />` immediately after the existing `requests` index route (before the catalog/submit routes).

- [ ] **Step 2: Build + commit**

```bash
pnpm --filter @prequest/web build
git add apps/web/src/App.tsx
git commit -m "feat(portal): wire /portal/requests/:id route to RequestDetailPage"
```

### Task 12: End-to-end browser smoke + visual polish pass

**Files:** none (manual verification)

- [ ] **Step 1:** `pnpm dev` from the worktree.
- [ ] **Step 2:** Walk all surfaces:
  - `/portal` — hero + categories + activity panel + announcements.
  - `/portal/catalog/:id` — banner with cover, subcategory rail (if any), services grid.
  - `/portal/submit?type=:id` — focused form with chips + sticky footer.
  - `/portal/requests` — unified list, tabs filter correctly.
  - `/portal/requests/:id` — thread + sidebar, reply works.
  - Mobile viewport at 375 (iPhone SE) — bottom tabs visible, layouts collapse cleanly.
  - Switch to Service Desk + Switch to Portal links — both work.
- [ ] **Step 3:** Apply small polish fixes (spacing, copy, colors) inline. Commit each visible fix individually so they're easy to review.
- [ ] **Step 4:** Final commit if any tweaks: `style(portal): polish pass after Wave 2 e2e walkthrough`.

---

## Self-review

After all tasks complete:

1. **Coverage:** Slice 4 (catalog detail + form) — Tasks 3-6. Slice 5 (My Requests + detail) — Tasks 7-11. Done.
2. **Routes consistency:** `/portal/requests`, `/portal/requests/:id`, `/portal/catalog/:id`, `/portal/submit/:id?` all present in App.tsx and reachable from the new shell.
3. **KB slot reservation:** Form page reserves a placeholder for KB sidebar (Phase 4). It's commented out / hidden until articles backend exists. Verify `<PortalCategoryAnswers />` slot is referenced in catalog-category.tsx as a stub comment.
4. **Mobile:** Each page tested at 375px width. Sticky footers don't overlap bottom tabs (the form footer should sit above the bottom tab bar — verify z-index ordering).
5. **No regressions:** `/admin/branding` and `/admin/catalog-hierarchy` still work — Wave 2 didn't touch them.

---

## Out of scope for Wave 2 / Wave 3

- Phase 2 flows (Book a Room, Order, Visitors) — designed in spec, not built. The top-nav links land on `/portal` redirects until those ship.
- KB articles + deflection (Phase 4) — slots reserved in this Wave; the actual article rendering and live re-rank live on Phase 4.
- `/portal/my-feed` unified backend endpoint — still uses `/tickets?requester_person_id=…` until bookings/visitors/orders exist.
