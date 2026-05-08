import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppErrors } from './app-error';

type MockRes = {
  status: jest.Mock<MockRes, [number]>;
  json: jest.Mock<MockRes, [unknown]>;
  setHeader: jest.Mock<MockRes, [string, string]>;
  end: jest.Mock<MockRes, []>;
  headersSent?: boolean;
  __status?: number;
  __body?: Record<string, unknown>;
  __headers: Record<string, string>;
  __ended?: boolean;
};

function makeRes(opts?: { headersSent?: boolean }): MockRes {
  const res: Partial<MockRes> = { __headers: {}, headersSent: opts?.headersSent ?? false };
  res.status = jest.fn((code: number) => {
    (res as MockRes).__status = code;
    return res as MockRes;
  });
  res.json = jest.fn((body: unknown) => {
    (res as MockRes).__body = body as Record<string, unknown>;
    return res as MockRes;
  });
  res.setHeader = jest.fn((key: string, val: string) => {
    (res as MockRes).__headers[key] = val;
    return res as MockRes;
  });
  res.end = jest.fn(() => {
    (res as MockRes).__ended = true;
    return res as MockRes;
  });
  return res as MockRes;
}

function makeHost(
  req: Record<string, unknown>,
  res: MockRes,
  opts?: { contextType?: 'http' | 'rpc' | 'ws' },
): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => () => undefined,
    }),
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => ({}) as never,
    switchToWs: () => ({}) as never,
    getType: () => opts?.contextType ?? 'http',
  } as unknown as ArgumentsHost;
}

describe('AllExceptionsFilter', () => {
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('writes the wire body and status from normalize()', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_abc' }, res);

    filter.catch(AppErrors.notFound('ticket', '123'), host);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.__body).toMatchObject({
      code: 'ticket.not_found',
      status: 404,
      traceId: 'req_abc',
    });
  });

  it('preserves req.id as traceId when present', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_supplied' }, res);
    filter.catch(new Error('boom'), host);
    expect(res.__body!.traceId).toBe('req_supplied');
  });

  it('falls back to req.traceId when req.id is missing (Fix 1.3)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ traceId: 'req_alias' }, res);
    filter.catch(new Error('boom'), host);
    expect(res.__body!.traceId).toBe('req_alias');
  });

  it('generates a new trace id when neither req.id nor req.traceId is set', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({}, res);
    filter.catch(new Error('boom'), host);
    expect(typeof res.__body!.traceId).toBe('string');
    expect((res.__body!.traceId as string).startsWith('req_')).toBe(true);
  });

  it('echoes the trace id on the X-Request-Id response header', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_xyz' }, res);
    filter.catch(new Error('boom'), host);
    expect(res.__headers['X-Request-Id']).toBe('req_xyz');
  });

  it('logs at error for 5xx status', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_500' }, res);
    filter.catch(new Error('boom'), host);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('logs at warn for 4xx status', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_400' }, res);
    filter.catch(new BadRequestException('bad'), host);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does NOT log for AbortError / request.cancelled', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_499' }, res);
    const aborted = new Error('aborted');
    aborted.name = 'AbortError';
    filter.catch(aborted, host);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(res.__body!.code).toBe('request.cancelled');
  });

  it('returns a wire shape that includes title and traceId for legacy throws (string detail dropped)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_legacy' }, res);
    filter.catch(new BadRequestException('Title is required'), host);
    expect(res.__body).toMatchObject({
      code: 'generic.bad_request',
      status: 400,
      title: expect.any(String),
      traceId: 'req_legacy',
    });
    // Fix 3: original string MUST NOT appear on the wire.
    expect(JSON.stringify(res.__body)).not.toContain('Title is required');
    // Fix 6: legacy `message` field is synthesised from messages.en detail.
    expect(typeof (res.__body as { message?: unknown }).message).toBe('string');
    expect((res.__body as { message: string }).message.length).toBeGreaterThan(0);
  });

  it('rethrows when host.getType() is not http (Fix 7)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_rpc' }, res, { contextType: 'rpc' });
    const original = new Error('rpc-only');
    expect(() => filter.catch(original, host)).toThrow('rpc-only');
    // Filter must not have written to the http response.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('rethrows when host.getType() is ws (Fix 7)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_ws' }, res, { contextType: 'ws' });
    expect(() => filter.catch(new Error('ws-only'), host)).toThrow('ws-only');
  });

  it('does not call res.status / res.json when headersSent is true (Fix 8)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes({ headersSent: true });
    const host = makeHost({ id: 'req_partial' }, res);
    filter.catch(new Error('boom'), host);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    // res.end must be called to terminate the stream.
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.__ended).toBe(true);
  });

  it('serialises a chained Error cause without [object Object] (Fix 9)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_cause' }, res);
    const inner = new Error('root cause');
    const outer = new Error('outer fail');
    (outer as Error & { cause?: unknown }).cause = inner;
    filter.catch(outer, host);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const args = errorSpy.mock.calls[0];
    // Second arg is an Error wrapper whose `.stack` walks both frames
    // joined by 'caused by:'. The original message is preserved.
    const causeArg = args[1] as Error;
    expect(causeArg).toBeInstanceOf(Error);
    expect(causeArg.message).toBe('outer fail');
    expect(causeArg.stack).toContain('outer fail');
    expect(causeArg.stack).toContain('root cause');
    expect(causeArg.stack).toContain('caused by:');
    // And NOT contain "[object Object]".
    expect(String(causeArg.stack)).not.toContain('[object Object]');
  });

  it('serialises a structured (non-Error) cause via JSON (Fix 9)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_pgrst_cause' }, res);
    // Wrap a plain-object cause so the 5xx logger receives it.
    const wrapped = new Error('wrapper');
    (wrapped as Error & { cause?: unknown }).cause = {
      code: 'INTERNAL',
      message: 'inner',
    };
    filter.catch(wrapped, host);
    const causeArg = errorSpy.mock.calls[0][1] as Error;
    expect(causeArg).toBeInstanceOf(Error);
    // Stack carries the JSON-serialised structured cause.
    expect(causeArg.stack).toContain('"code":"INTERNAL"');
    expect(causeArg.stack).toContain('"message":"inner"');
    expect(causeArg.stack).not.toContain('[object Object]');
  });

  it('passes a single Error through to the logger as-is (no needless wrapping)', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_simple' }, res);
    const single = new Error('single fail');
    filter.catch(single, host);
    const args = errorSpy.mock.calls[0];
    const causeArg = args[1] as Error;
    // Single-frame chain: filter forwards the original Error directly.
    expect(causeArg).toBe(single);
  });
});
