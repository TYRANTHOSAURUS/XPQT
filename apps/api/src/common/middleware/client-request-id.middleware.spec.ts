import {
  ClientRequestIdMiddleware,
  type RequestWithClientId,
} from './client-request-id.middleware';

/**
 * B.0.D.1 — `ClientRequestIdMiddleware` reads `X-Client-Request-Id` and
 * stamps `req.clientRequestId` + `req.clientRequestIdSource`. Spec §3.3 of
 * docs/superpowers/specs/2026-05-04-domain-outbox-design.md.
 *
 * The four cases from §3.3:
 *   (a) client sends a valid UUID → req.clientRequestId === that uuid,
 *       source === 'client'
 *   (b) client omits the header → req.clientRequestId is a fresh UUID,
 *       source === 'server_default'
 *   (c) client sends a malformed string → middleware overrides with a
 *       fresh UUID, source === 'server_default'
 *   (d) header is uppercase → normalised to lowercase
 */

const VALID_LC = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UC = '550E8400-E29B-41D4-A716-446655440000';
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function makeReq(headerValue: string | undefined) {
  return {
    header: jest.fn((name: string) => {
      if (name.toLowerCase() === 'x-client-request-id') return headerValue;
      return undefined;
    }),
  } as unknown as RequestWithClientId;
}

describe('ClientRequestIdMiddleware (B.0.D.1)', () => {
  let mw: ClientRequestIdMiddleware;

  beforeEach(() => {
    mw = new ClientRequestIdMiddleware();
  });

  it('forwards a valid client-supplied UUID and tags source=client', () => {
    const req = makeReq(VALID_LC);
    const next = jest.fn();
    mw.use(req, {} as never, next);
    expect(req.clientRequestId).toBe(VALID_LC);
    expect(req.clientRequestIdSource).toBe('client');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('lowercases an uppercase UUID before stamping (header is case-insensitive in spec)', () => {
    const req = makeReq(VALID_UC);
    const next = jest.fn();
    mw.use(req, {} as never, next);
    expect(req.clientRequestId).toBe(VALID_LC);
    expect(req.clientRequestIdSource).toBe('client');
  });

  it('falls back to a server-generated UUID when header is missing', () => {
    const req = makeReq(undefined);
    const next = jest.fn();
    mw.use(req, {} as never, next);
    expect(req.clientRequestId).toMatch(UUID_SHAPE);
    expect(req.clientRequestIdSource).toBe('server_default');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('falls back to a server-generated UUID when header is malformed', () => {
    const req = makeReq('not-a-uuid');
    const next = jest.fn();
    mw.use(req, {} as never, next);
    expect(req.clientRequestId).toMatch(UUID_SHAPE);
    expect(req.clientRequestId).not.toBe('not-a-uuid');
    expect(req.clientRequestIdSource).toBe('server_default');
  });

  it('falls back to a server-generated UUID when header is an empty string', () => {
    const req = makeReq('');
    const next = jest.fn();
    mw.use(req, {} as never, next);
    expect(req.clientRequestId).toMatch(UUID_SHAPE);
    expect(req.clientRequestIdSource).toBe('server_default');
  });

  it('always invokes next exactly once (no short-circuit on missing/malformed)', () => {
    const next = jest.fn();
    mw.use(makeReq(undefined), {} as never, next);
    mw.use(makeReq('garbage'), {} as never, next);
    mw.use(makeReq(VALID_LC), {} as never, next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('generates a different UUID per call (no module-level caching)', () => {
    const a = makeReq(undefined);
    const b = makeReq(undefined);
    mw.use(a, {} as never, jest.fn());
    mw.use(b, {} as never, jest.fn());
    expect(a.clientRequestId).not.toBe(b.clientRequestId);
  });
});
