/**
 * NotificationTemplateService — unit tests.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step G.
 *
 * Coverage:
 *   1. list() returns rows for the current tenant only.
 *   2. list() applies optional eventKind / locale filters.
 *   3. getByEventKind() returns both EN + NL slots (null when missing).
 *   4. getByEventKind() rejects unknown event_kind with validation error.
 *   5. upsert() inserts a new row + emits `created` audit event.
 *   6. upsert() updates an existing row + emits `updated` audit event.
 *   7. upsert() normalizes empty / whitespace strings to null.
 *   8. upsert() rejects unknown event_kind / locale.
 *   9. Audit failure does NOT block the mutation (best-effort write).
 *  10. Tenant isolation — list() in tenant A doesn't see tenant B rows.
 */

import { TenantContext } from '../../common/tenant-context';
import { AppError } from '../../common/errors';
import { NotificationTemplateService } from './template-overrides.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface OverrideRow {
  id: string;
  tenant_id: string;
  event_kind: string;
  locale: 'en' | 'nl';
  subject_override: string | null;
  cta_text_override: string | null;
  body_intro_override: string | null;
  updated_at: string;
  updated_by_user_id: string | null;
}

interface AuditRow {
  tenant_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown>;
}

interface FakeStore {
  overrides: OverrideRow[];
  audits: AuditRow[];
  /** When true, the next audit insert returns an error; cleared after. */
  failNextAudit: boolean;
}

function makeStore(initial: OverrideRow[] = []): FakeStore {
  return { overrides: [...initial], audits: [], failNextAudit: false };
}

/**
 * Tiny chainable supabase fake. Only models the shapes the service uses:
 *   - .from(table).select(cols).eq(col, val).eq(...).order(...) → resolves to {data, error}
 *   - .from(table).upsert(row, { onConflict }).select(...).single()
 *   - .from('audit_events').insert(row) → resolves to {error}
 */
function buildSupabaseFake(store: FakeStore) {
  function tableRows(table: string): Array<Record<string, unknown>> {
    if (table === 'notification_template_overrides') {
      return store.overrides as unknown as Array<Record<string, unknown>>;
    }
    if (table === 'audit_events') {
      return store.audits as unknown as Array<Record<string, unknown>>;
    }
    throw new Error(`unexpected table in fake: ${table}`);
  }

  const builderFor = (table: string) => {
    const predicates: Array<(rows: Array<Record<string, unknown>>) => Array<Record<string, unknown>>> = [];
    let ordering: { col: string; ascending: boolean } | null = null;

    const apply = () => {
      let rows = tableRows(table);
      for (const p of predicates) rows = p(rows);
      if (ordering) {
        rows = [...rows].sort((a, b) => {
          const av = a[ordering!.col];
          const bv = b[ordering!.col];
          if (av === bv) return 0;
          if (av == null) return ordering!.ascending ? -1 : 1;
          if (bv == null) return ordering!.ascending ? 1 : -1;
          if ((av as string | number) < (bv as string | number)) return ordering!.ascending ? -1 : 1;
          return ordering!.ascending ? 1 : -1;
        });
      }
      return rows;
    };

    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      then: (onFulfilled: (v: unknown) => unknown) =>
        Promise.resolve({ data: apply(), error: null }).then(onFulfilled),
      select: (_cols: string) => builder,
      eq: (col: string, val: unknown) => {
        predicates.push((rows) => rows.filter((r) => r[col] === val));
        return builder;
      },
      order: (col: string, opts?: { ascending?: boolean }) => {
        ordering = { col, ascending: opts?.ascending ?? true };
        return builder;
      },
      // INSERT (audit only)
      insert: (row: Record<string, unknown>) => {
        if (table === 'audit_events') {
          if (store.failNextAudit) {
            store.failNextAudit = false;
            return Promise.resolve({ error: { message: 'audit insert failed (fake)' } });
          }
          store.audits.push(row as unknown as AuditRow);
          return Promise.resolve({ error: null });
        }
        store.overrides.push(row as unknown as OverrideRow);
        return Promise.resolve({ error: null });
      },
      // UPSERT (.upsert(row, { onConflict }).select(...).single())
      upsert: (row: Record<string, unknown>, opts: { onConflict: string }) => {
        const onConflict = opts.onConflict.split(',').map((s) => s.trim());
        const existingIdx = store.overrides.findIndex((r) =>
          onConflict.every((col) => (r as unknown as Record<string, unknown>)[col] === row[col]),
        );
        let writtenRow: OverrideRow;
        if (existingIdx >= 0) {
          writtenRow = {
            ...store.overrides[existingIdx],
            ...row,
            id: store.overrides[existingIdx].id,
            updated_at: new Date().toISOString(),
          } as OverrideRow;
          store.overrides[existingIdx] = writtenRow;
        } else {
          writtenRow = {
            id: `override-${store.overrides.length + 1}`,
            updated_at: new Date().toISOString(),
            ...(row as unknown as OverrideRow),
          };
          store.overrides.push(writtenRow);
        }
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: (_cols: string) => chain,
          single: () => Promise.resolve({ data: writtenRow, error: null }),
        });
        return chain;
      },
    });
    return builder;
  };

  return {
    admin: {
      from: jest.fn((table: string) => builderFor(table)),
    },
  } as unknown as ConstructorParameters<typeof NotificationTemplateService>[0];
}

function rowFor(over: Partial<OverrideRow>): OverrideRow {
  return {
    id: 'row-id',
    tenant_id: TENANT_A,
    event_kind: 'booking.approval_required',
    locale: 'en',
    subject_override: null,
    cta_text_override: null,
    body_intro_override: null,
    updated_at: '2026-05-12T10:00:00.000Z',
    updated_by_user_id: null,
    ...over,
  };
}

function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return TenantContext.run({ id: tenantId, slug: 'fake', tier: 'standard' }, fn);
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('NotificationTemplateService', () => {
  describe('list()', () => {
    it('returns only rows for the current tenant', async () => {
      const store = makeStore([
        rowFor({ id: 'a-en', locale: 'en', tenant_id: TENANT_A }),
        rowFor({ id: 'a-nl', locale: 'nl', tenant_id: TENANT_A }),
        rowFor({ id: 'b-en', locale: 'en', tenant_id: TENANT_B }),
      ]);
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const rows = await withTenant(TENANT_A, () => svc.list());
      expect(rows.map((r) => r.id).sort()).toEqual(['a-en', 'a-nl']);
    });

    it('applies optional eventKind and locale filters', async () => {
      const store = makeStore([
        rowFor({ id: 'r1', locale: 'en' }),
        rowFor({ id: 'r2', locale: 'nl' }),
      ]);
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const rows = await withTenant(TENANT_A, () =>
        svc.list({ eventKind: 'booking.approval_required', locale: 'nl' }),
      );
      expect(rows.map((r) => r.id)).toEqual(['r2']);
    });
  });

  describe('getByEventKind()', () => {
    it('returns en + nl slots; missing locale is null', async () => {
      const store = makeStore([rowFor({ id: 'en-row', locale: 'en' })]);
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const out = await withTenant(TENANT_A, () =>
        svc.getByEventKind('booking.approval_required'),
      );
      expect(out.eventKind).toBe('booking.approval_required');
      expect(out.en?.id).toBe('en-row');
      expect(out.nl).toBeNull();
    });

    it('rejects unknown event_kind', async () => {
      const svc = new NotificationTemplateService(buildSupabaseFake(makeStore()));
      await expect(
        withTenant(TENANT_A, () => svc.getByEventKind('unknown.kind')),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('upsert()', () => {
    it('inserts a new row and emits a created audit event', async () => {
      const store = makeStore();
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const row = await withTenant(TENANT_A, () =>
        svc.upsert(
          'booking.approval_required',
          'en',
          { subject_override: 'Custom subject' },
          { userId: USER_A },
        ),
      );
      expect(row.subject_override).toBe('Custom subject');
      expect(row.tenant_id).toBe(TENANT_A);
      expect(store.audits).toHaveLength(1);
      expect(store.audits[0].event_type).toBe(
        'notification_template_override.created',
      );
      expect(store.audits[0].entity_type).toBe('notification_template_override');
      expect(store.audits[0].entity_id).toBe(row.id);
      const details = store.audits[0].details as { before: unknown; after: { subject_override: string } };
      expect(details.before).toBeNull();
      expect(details.after.subject_override).toBe('Custom subject');
    });

    it('updates an existing row and emits an updated audit event', async () => {
      const store = makeStore([
        rowFor({
          id: 'existing',
          locale: 'en',
          subject_override: 'Old subject',
        }),
      ]);
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const row = await withTenant(TENANT_A, () =>
        svc.upsert(
          'booking.approval_required',
          'en',
          { subject_override: 'New subject' },
          { userId: USER_A },
        ),
      );
      expect(row.subject_override).toBe('New subject');
      expect(store.audits).toHaveLength(1);
      expect(store.audits[0].event_type).toBe(
        'notification_template_override.updated',
      );
      const details = store.audits[0].details as {
        before: { subject_override: string } | null;
        after: { subject_override: string };
      };
      expect(details.before?.subject_override).toBe('Old subject');
      expect(details.after.subject_override).toBe('New subject');
    });

    it('normalizes empty / whitespace strings to null', async () => {
      const store = makeStore();
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      const row = await withTenant(TENANT_A, () =>
        svc.upsert(
          'booking.approval_required',
          'en',
          {
            subject_override: '   ',
            cta_text_override: '',
            body_intro_override: 'real value',
          },
          { userId: USER_A },
        ),
      );
      expect(row.subject_override).toBeNull();
      expect(row.cta_text_override).toBeNull();
      expect(row.body_intro_override).toBe('real value');
    });

    it('rejects unknown event_kind', async () => {
      const svc = new NotificationTemplateService(buildSupabaseFake(makeStore()));
      await expect(
        withTenant(TENANT_A, () =>
          svc.upsert(
            'something.else',
            'en',
            { subject_override: 'x' },
            { userId: USER_A },
          ),
        ),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('rejects unknown locale', async () => {
      const svc = new NotificationTemplateService(buildSupabaseFake(makeStore()));
      await expect(
        withTenant(TENANT_A, () =>
          svc.upsert(
            'booking.approval_required',
            'fr' as 'en',
            { subject_override: 'x' },
            { userId: USER_A },
          ),
        ),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('does NOT block mutation when audit insert fails', async () => {
      const store = makeStore();
      store.failNextAudit = true;
      const svc = new NotificationTemplateService(buildSupabaseFake(store));
      // Should resolve, not throw, even with audit failure.
      const row = await withTenant(TENANT_A, () =>
        svc.upsert(
          'booking.approval_required',
          'en',
          { subject_override: 'Persist anyway' },
          { userId: USER_A },
        ),
      );
      expect(row.subject_override).toBe('Persist anyway');
      // Audit row was NOT written (the fake rejected).
      expect(store.audits).toHaveLength(0);
    });
  });
});
