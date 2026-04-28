import {
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { VendorAuthService } from './vendor-auth.service';
import { VendorOrderService } from './vendor-order.service';
import { VendorPortalGuard } from './vendor-portal.guard';

const TENANT = 'a1b2c3d4-e5f6-4789-9abc-def012345678';
const VENDOR = 'b2c3d4e5-f6a7-4b89-8cde-f0123456789a';
const VENDOR_USER = 'd4e5f6a7-b8c9-4d0e-8f01-23456789abcd';
const ORDER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

// =====================================================================
// VendorPortalGuard
// =====================================================================

function makeCtx(cookieHeader: string | undefined): { ctx: ExecutionContext; req: { vendorSession?: unknown } } {
  const req: { headers: { cookie?: string }; vendorSession?: unknown } = {
    headers: cookieHeader ? { cookie: cookieHeader } : {},
  };
  const ctx = {
    switchToHttp: () => ({
      getRequest: <T>() => req as unknown as T,
    }),
  } as unknown as ExecutionContext;
  return { ctx, req };
}

function makeAuth(validateReturns: unknown = null) {
  return {
    validate: jest.fn(async () => validateReturns),
    touch: jest.fn(async () => {}),
  } as unknown as VendorAuthService;
}

describe('VendorPortalGuard', () => {
  it('rejects when the session cookie is missing', async () => {
    const guard = new VendorPortalGuard(makeAuth());
    const { ctx } = makeCtx(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects when validate returns null', async () => {
    const guard = new VendorPortalGuard(makeAuth(null));
    const { ctx } = makeCtx(`prequest_vendor_session=invalid-token`);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches vendorSession + fires sliding-TTL touch on success', async () => {
    const session = {
      id: 'sess-1', vendor_user_id: VENDOR_USER,
      tenant_id: TENANT, vendor_id: VENDOR,
      expires_at: '2026-12-01T00:00:00Z',
      email: 'v@x', display_name: 'V', role: 'fulfiller', active: true,
    };
    const auth = makeAuth(session);
    const guard = new VendorPortalGuard(auth);
    const { ctx, req } = makeCtx(`prequest_vendor_session=raw-token-value`);

    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);
    expect(req.vendorSession).toEqual(session);

    expect((auth.validate as jest.Mock).mock.calls[0][0]).toBe('raw-token-value');
    // touch is fire-and-forget — it should be invoked but not awaited.
    expect((auth.touch as jest.Mock)).toHaveBeenCalledWith('raw-token-value');
  });

  it('parses the right cookie when multiple cookies are present', async () => {
    const auth = makeAuth({ id: 's', vendor_user_id: VENDOR_USER, tenant_id: TENANT, vendor_id: VENDOR, expires_at: '...', email: 'x', display_name: null, role: 'fulfiller', active: true });
    const guard = new VendorPortalGuard(auth);
    const { ctx } = makeCtx('other=foo; prequest_vendor_session=the-real-token; another=bar');
    await guard.canActivate(ctx);
    expect((auth.validate as jest.Mock).mock.calls[0][0]).toBe('the-real-token');
  });
});

// =====================================================================
// VendorOrderService — projection shape (PII minimization)
// =====================================================================

interface FakeRow {
  id: string;
  external_ref: string;
  delivery_at: string;
  delivery_location: string;
  headcount: number;
  service_type: string;
  fulfillment_status: string;
  requires_phone_followup: boolean;
  lines_summary: string;
}

function makeFakeDb() {
  return {
    query: jest.fn(),
    queryOne: jest.fn(),
    queryMany: jest.fn(),
    rpc: jest.fn(),
    tx: jest.fn(),
  };
}

describe('VendorOrderService.listForVendor', () => {
  it('scopes by tenant + vendor + delivery date window', async () => {
    const db = makeFakeDb();
    db.queryMany = jest.fn(async () => [] as FakeRow[]);
    const svc = new VendorOrderService(db as never);

    await svc.listForVendor({
      tenantId: TENANT, vendorId: VENDOR,
      fromDate: '2026-04-28', toDate: '2026-05-12',
    });

    const call = (db.queryMany as jest.Mock).mock.calls[0];
    const sql = call[0] as string;
    const params = call[1] as unknown[];

    expect(sql).toContain('ord.tenant_id = $1');
    expect(sql).toContain('oli.vendor_id = $2');
    expect(sql).toContain('ord.delivery_date between $3::date and $4::date');
    expect(params).toEqual([TENANT, VENDOR, '2026-04-28', '2026-05-12']);

    // Critical: must NOT select any of: requester full name, email, phone,
    // total_estimated_cost, attendees.
    expect(sql).not.toMatch(/p\.last_name|p\.email|p\.phone/);
    expect(sql).not.toMatch(/total_estimated_cost/);
  });
});

describe('VendorOrderService.getDetailForVendor', () => {
  it('selects requester FIRST NAME ONLY; never last name / email / phone', async () => {
    const db = makeFakeDb();
    db.queryOne = jest.fn(async () => ({
      id: ORDER_ID,
      external_ref: ORDER_ID,
      delivery_at: '2026-04-30T11:30:00+02:00',
      headcount: 12,
      requester_first_name: 'Marleen',
      room_name: 'Boardroom 4A',
      floor_label: '4th floor',
      building_name: 'HQ Amsterdam',
      service_window_start_at: null,
      service_window_end_at: null,
      policy_snapshot: { desk_contact: { phone: '+31', email: 'fac@x' }, navigation_hint: 'Reception' },
      tenant_name: 'Acme',
    }));
    db.queryMany = jest.fn(async () => []);

    const svc = new VendorOrderService(db as never);
    const detail = await svc.getDetailForVendor({ tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID });

    const sql = (db.queryOne as jest.Mock).mock.calls[0][0] as string;
    expect(sql).toContain('p.first_name');
    expect(sql).not.toMatch(/p\.last_name|p\.email\b|p\.phone/);
    expect(sql).not.toMatch(/total_estimated_cost/);

    // Detail shape: only the safe fields surface.
    expect(detail.requester_first_name).toBe('Marleen');
    expect(detail).not.toHaveProperty('requester_last_name');
    expect(detail).not.toHaveProperty('requester_email');
    expect(detail.delivery_location.navigation_hint).toBe('Reception');
    expect(detail.desk_contact.phone).toBe('+31');
  });

  it('throws 404 (not 403) when the order is not visible to this vendor', async () => {
    const db = makeFakeDb();
    db.queryOne = jest.fn(async () => null);
    const svc = new VendorOrderService(db as never);
    await expect(
      svc.getDetailForVendor({ tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID }),
    ).rejects.toThrow(/Order not found/);
  });

  it('strips desk_contact / navigation_hint when policy_snapshot is missing those fields', async () => {
    const db = makeFakeDb();
    db.queryOne = jest.fn(async () => ({
      id: ORDER_ID, external_ref: ORDER_ID, delivery_at: '2026-04-30',
      headcount: 1, requester_first_name: 'X',
      room_name: 'R', floor_label: 'F', building_name: 'B',
      service_window_start_at: null, service_window_end_at: null,
      policy_snapshot: { internal_pricing: 999, secret_field: 'no-leak' },
      tenant_name: 'T',
    }));
    db.queryMany = jest.fn(async () => []);
    const svc = new VendorOrderService(db as never);
    const detail = await svc.getDetailForVendor({ tenantId: TENANT, vendorId: VENDOR, orderId: ORDER_ID });

    expect(detail.desk_contact.phone).toBeNull();
    expect(detail.desk_contact.email).toBeNull();
    expect(detail.delivery_location.navigation_hint).toBeNull();
    // policy_snapshot internal fields must not leak.
    expect(JSON.stringify(detail)).not.toContain('internal_pricing');
    expect(JSON.stringify(detail)).not.toContain('secret_field');
  });
});
