import {
  RequestIdMiddleware,
  type RequestWithTraceId,
} from './request-id.middleware';

/**
 * RequestIdMiddleware — Phase 7.A.1 self-review fix.
 *
 * Spec: docs/superpowers/specs/2026-05-02-error-handling-system-design.md §6.1
 *
 * Acceptance:
 *   (a) valid X-Request-Id pass-through preserved verbatim.
 *   (b) missing header → server-generated `req_<no-dash-uuid>`.
 *   (c) response header always echoes the trace id.
 *   (d) malformed/oversize/empty → server-generated id.
 *   (e) `req.id` and alias `req.traceId` always equal.
 */

const NO_DASH_UUID = /^req_[0-9a-f]{32}$/i;

function makeReq(headerValue: string | undefined) {
  return {
    header: jest.fn((name: string) => {
      if (name.toLowerCase() === 'x-request-id') return headerValue;
      return undefined;
    }),
  } as unknown as RequestWithTraceId;
}

function makeRes() {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: jest.fn((k: string, v: string) => {
      headers[k] = v;
    }),
  };
}

describe('RequestIdMiddleware', () => {
  let mw: RequestIdMiddleware;

  beforeEach(() => {
    mw = new RequestIdMiddleware();
  });

  it('accepts a client-supplied X-Request-Id and reuses it as req.id', () => {
    const req = makeReq('req_abc123_clientsupplied');
    const res = makeRes();
    const next = jest.fn();
    mw.use(req, res as never, next);
    expect(req.id).toBe('req_abc123_clientsupplied');
    expect(req.traceId).toBe('req_abc123_clientsupplied');
    expect(res.headers['X-Request-Id']).toBe('req_abc123_clientsupplied');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('also accepts a non-prefixed UUID-like id from upstream proxies', () => {
    const proxyId = '550e8400-e29b-41d4-a716-446655440000';
    const req = makeReq(proxyId);
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(req.id).toBe(proxyId);
    expect(res.headers['X-Request-Id']).toBe(proxyId);
  });

  it('generates a new id when header is missing', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(req.id).toMatch(NO_DASH_UUID);
    expect(req.traceId).toBe(req.id);
  });

  it('always echoes X-Request-Id on the response', () => {
    const req = makeReq(undefined);
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(res.headers['X-Request-Id']).toBe(req.id);
  });

  it('falls back to a generated id when header is empty string', () => {
    const req = makeReq('');
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(req.id).toMatch(NO_DASH_UUID);
  });

  it('falls back when header is whitespace-only', () => {
    const req = makeReq('   ');
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(req.id).toMatch(NO_DASH_UUID);
  });

  it('falls back when header is oversize (> 80 chars)', () => {
    const oversize = 'x'.repeat(81);
    const req = makeReq(oversize);
    const res = makeRes();
    mw.use(req, res as never, jest.fn());
    expect(req.id).toMatch(NO_DASH_UUID);
    expect(req.id).not.toBe(oversize);
  });

  it('produces a different id per call when header is missing', () => {
    const a = makeReq(undefined);
    const b = makeReq(undefined);
    mw.use(a, makeRes() as never, jest.fn());
    mw.use(b, makeRes() as never, jest.fn());
    expect(a.id).not.toBe(b.id);
  });

  it('keeps req.id and req.traceId in sync', () => {
    const req = makeReq('req_xyz');
    mw.use(req, makeRes() as never, jest.fn());
    expect(req.id).toBe(req.traceId);
  });
});
