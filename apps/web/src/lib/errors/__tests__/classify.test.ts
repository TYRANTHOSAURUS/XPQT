import { describe, expect, it, vi, afterEach } from 'vitest';
import { ApiError } from '@/lib/api';
import { classify, type Recovery } from '../classify';

function recoveryKinds(rs: Recovery[]): string[] {
  return rs.map((r) => r.kind);
}

describe('classify — invariants', () => {
  it('always emits at least one recovery', () => {
    const cases: unknown[] = [
      new ApiError({ status: 401, message: 'unauth', body: {} }),
      new ApiError({ status: 403, message: 'forbidden', body: {} }),
      new ApiError({ status: 404, message: 'nope', body: {} }),
      new ApiError({ status: 410, message: 'gone', body: {} }),
      new ApiError({ status: 422, message: 'invalid', body: {} }),
      new ApiError({ status: 409, message: 'conflict', body: {} }),
      new ApiError({ status: 429, message: 'limited', body: {} }),
      new ApiError({ status: 500, message: 'boom', body: {} }),
      new ApiError({ status: 502, message: 'gw', body: {} }),
      new ApiError({ status: 0, message: 'net', isNetworkError: true }),
      new Error('plain'),
      'string error',
      null,
      undefined,
    ];
    for (const e of cases) {
      const c = classify(e);
      expect(c.recoveries.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('preserves traceId from ApiError', () => {
    const e = new ApiError({ status: 500, message: 'x', body: {}, traceId: 'req_abc' });
    const c = classify(e);
    expect(c.traceId).toBe('req_abc');
  });

  it('preserves raw error reference', () => {
    const e = new ApiError({ status: 500, message: 'x', body: {} });
    const c = classify(e);
    expect(c.raw).toBe(e);
  });
});

describe('classify — AbortError / cancellation', () => {
  it('classifies AbortError as transport / request.cancelled', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    const c = classify(e);
    expect(c.class).toBe('transport');
    expect(c.code).toBe('request.cancelled');
    expect(recoveryKinds(c.recoveries)).toContain('dismiss');
  });

  it('classifies signal.aborted=true objects as request.cancelled', () => {
    const e = Object.assign(new Error('cancelled'), { aborted: true });
    const c = classify(e);
    expect(c.code).toBe('request.cancelled');
  });
});

describe('classify — transport (network)', () => {
  it('isNetworkError() ApiError → transport', () => {
    const e = new ApiError({ status: 0, message: 'net', isNetworkError: true });
    const c = classify(e);
    expect(c.class).toBe('transport');
    // navigator.onLine defaults to true in jsdom
    expect(['network.offline', 'network.timeout']).toContain(c.code);
  });

  it('offline → network.offline', () => {
    const onLineSpy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      const e = new ApiError({ status: 0, message: 'net', isNetworkError: true });
      const c = classify(e);
      expect(c.code).toBe('network.offline');
    } finally {
      onLineSpy.mockRestore();
    }
  });

  it('includes retry recovery when ctx.retry provided', () => {
    const retry = vi.fn();
    const e = new ApiError({ status: 0, message: 'net', isNetworkError: true });
    const c = classify(e, { retry });
    expect(recoveryKinds(c.recoveries)).toContain('retry');
  });
});

describe('classify — auth (401)', () => {
  it('classifies 401 → auth', () => {
    const e = new ApiError({ status: 401, message: 'x', body: { code: 'auth.expired' } });
    const c = classify(e);
    expect(c.class).toBe('auth');
    expect(c.code).toBe('auth.expired');
  });

  it('default code is auth.unauthorized when body has none', () => {
    const e = new ApiError({ status: 401, message: 'x', body: {} });
    expect(classify(e).code).toBe('auth.unauthorized');
  });

  it('emits signIn recovery with current path as next', () => {
    const e = new ApiError({ status: 401, message: 'x', body: {} });
    const c = classify(e);
    const signIn = c.recoveries.find((r) => r.kind === 'signIn');
    expect(signIn).toBeDefined();
    if (signIn?.kind === 'signIn') {
      expect(signIn.next.length).toBeGreaterThan(0);
    }
  });
});

describe('classify — permission (403)', () => {
  it('classifies 403 → permission', () => {
    const e = new ApiError({
      status: 403,
      message: 'x',
      body: { code: 'permission.denied' },
    });
    const c = classify(e);
    expect(c.class).toBe('permission');
    expect(c.code).toBe('permission.denied');
    expect(recoveryKinds(c.recoveries)).toEqual(
      expect.arrayContaining(['askAdmin', 'goBack', 'dismiss']),
    );
  });
});

describe('classify — not_found (404 / 410)', () => {
  it('classifies 404 → not_found', () => {
    const e = new ApiError({ status: 404, message: 'x', body: { code: 'ticket.not_found' } });
    const c = classify(e);
    expect(c.class).toBe('not_found');
    expect(c.code).toBe('ticket.not_found');
  });

  it('classifies 410 → not_found', () => {
    const e = new ApiError({ status: 410, message: 'gone', body: {} });
    expect(classify(e).class).toBe('not_found');
  });
});

describe('classify — validation (422)', () => {
  it('classifies 422 → validation with fields[]', () => {
    const e = new ApiError({
      status: 422,
      message: 'invalid',
      body: {
        code: 'validation.failed',
        fields: [
          { field: 'name', code: 'required', message: 'Required.' },
          { field: 'email', code: 'invalid', message: 'Must be an email.' },
        ],
      },
    });
    const c = classify(e);
    expect(c.class).toBe('validation');
    expect(c.fields).toHaveLength(2);
    expect(c.fields?.[0].field).toBe('name');
  });

  it('drops malformed field entries defensively', () => {
    const e = new ApiError({
      status: 422,
      message: 'x',
      body: {
        fields: [
          { field: 'name', code: 'required', message: 'Required.' },
          { field: 42 }, // garbage
          null,
        ],
      },
    });
    const c = classify(e);
    expect(c.fields).toHaveLength(1);
  });
});

describe('classify — conflict (409)', () => {
  it('classifies 409 → conflict', () => {
    const e = new ApiError({
      status: 409,
      message: 'x',
      body: { code: 'reservation.version_conflict', serverVersion: 'v2', clientVersion: 'v1' },
    });
    const c = classify(e);
    expect(c.class).toBe('conflict');
    expect(c.serverVersion).toBe('v2');
    expect(c.clientVersion).toBe('v1');
  });
});

describe('classify — rate_limit (429)', () => {
  it('classifies 429 with retryAfter', () => {
    const e = new ApiError({
      status: 429,
      message: 'x',
      body: { code: 'rate_limit.exceeded', retryAfter: 60 },
    });
    const c = classify(e);
    expect(c.class).toBe('rate_limit');
    expect(c.retryAfter).toBe(60);
    const wait = c.recoveries.find((r) => r.kind === 'wait');
    expect(wait).toBeDefined();
    if (wait?.kind === 'wait') {
      expect(wait.until).toBeGreaterThan(Date.now());
    }
  });

  it('falls back to retryAfter=30 when missing', () => {
    const e = new ApiError({ status: 429, message: 'x', body: {} });
    expect(classify(e).retryAfter).toBe(30);
  });
});

describe('classify — server (5xx)', () => {
  it('classifies 500 → server', () => {
    const e = new ApiError({ status: 500, message: 'x', body: {}, traceId: 'req_xyz' });
    const c = classify(e);
    expect(c.class).toBe('server');
    expect(c.code).toBe('unknown.server_error');
    const cs = c.recoveries.find((r) => r.kind === 'contactSupport');
    expect(cs).toBeDefined();
    if (cs?.kind === 'contactSupport') {
      expect(cs.traceId).toBe('req_xyz');
    }
  });

  it('classifies 502/503/504 → server', () => {
    for (const status of [502, 503, 504]) {
      const e = new ApiError({ status, message: 'x', body: {} });
      expect(classify(e).class).toBe('server');
    }
  });

  it('passes ctx.supportEmail through to contactSupport recovery', () => {
    const e = new ApiError({ status: 500, message: 'x', body: {} });
    const c = classify(e, { supportEmail: 'help@example.test' });
    const cs = c.recoveries.find((r) => r.kind === 'contactSupport');
    if (cs?.kind === 'contactSupport') {
      expect(cs.supportEmail).toBe('help@example.test');
    }
  });
});

describe('classify — unknown', () => {
  it('classifies plain Error → unknown with reload + contactSupport', () => {
    const c = classify(new Error('boom'));
    expect(c.class).toBe('unknown');
    expect(recoveryKinds(c.recoveries)).toEqual(
      expect.arrayContaining(['reload', 'contactSupport']),
    );
  });

  it('classifies non-Error → unknown', () => {
    const c = classify('string error');
    expect(c.class).toBe('unknown');
  });

  it('classifies null → unknown', () => {
    const c = classify(null);
    expect(c.class).toBe('unknown');
    expect(c.recoveries.length).toBeGreaterThan(0);
  });
});

describe('classify — other 4xx fallback', () => {
  it('classifies 400 → validation (generic.bad_request)', () => {
    const e = new ApiError({ status: 400, message: 'bad', body: {} });
    const c = classify(e);
    expect(c.class).toBe('validation');
    expect(c.code).toBe('generic.bad_request');
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
