import { ArgumentsHost, BadRequestException, Logger } from '@nestjs/common';

import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppErrors } from './app-error';

type MockRes = {
  status: jest.Mock<MockRes, [number]>;
  json: jest.Mock<MockRes, [unknown]>;
  setHeader: jest.Mock<MockRes, [string, string]>;
  __status?: number;
  __body?: Record<string, unknown>;
  __headers: Record<string, string>;
};

function makeRes(): MockRes {
  const res: Partial<MockRes> = { __headers: {} };
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
  return res as MockRes;
}

function makeHost(req: Record<string, unknown>, res: MockRes): ArgumentsHost {
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
    getType: () => 'http',
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

  it('generates a new trace id when req.id is missing', () => {
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

  it('returns a wire shape that includes title and traceId for legacy throws', () => {
    const filter = new AllExceptionsFilter();
    const res = makeRes();
    const host = makeHost({ id: 'req_legacy' }, res);
    filter.catch(new BadRequestException('Title is required'), host);
    expect(res.__body).toMatchObject({
      code: 'generic.bad_request',
      status: 400,
      title: expect.any(String),
      traceId: 'req_legacy',
      detail: 'Title is required',
    });
  });
});
