import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '@/lib/api';
import {
  handleMutationError,
  handleQueryError,
  withErrorHandling,
} from '../handlers';

const toastErrorMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({
  toastError: toastErrorMock,
  // re-export passthrough so the module is still importable elsewhere
  toast: { message: vi.fn(), warning: vi.fn() },
}));

beforeEach(() => {
  toastErrorMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withErrorHandling', () => {
  it('returns an onError function that toasts on server error', () => {
    const opts = withErrorHandling({ actionTitle: "Couldn't save webhook" });
    const e = new ApiError({ status: 500, message: 'x', body: {}, traceId: 'req_1' });
    opts.onError(e);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0][0]).toBe("Couldn't save webhook");
  });

  it('passes retry to the toast', () => {
    const retry = vi.fn();
    const opts = withErrorHandling({ actionTitle: "Couldn't save", retry });
    opts.onError(new ApiError({ status: 500, message: 'x', body: {} }));
    expect(toastErrorMock.mock.calls[0][1]?.retry).toBe(retry);
  });
});

describe('handleMutationError — surface routing', () => {
  it('toasts on conflict (409)', () => {
    handleMutationError(
      new ApiError({ status: 409, message: 'x', body: {} }),
      { actionTitle: "Couldn't save" },
    );
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('toasts on rate_limit (429)', () => {
    handleMutationError(
      new ApiError({ status: 429, message: 'x', body: {} }),
      { actionTitle: "Couldn't save" },
    );
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it('toasts on server (5xx) and uses code-resolved detail', () => {
    handleMutationError(
      new ApiError({ status: 500, message: 'x', body: { code: 'unknown.server_error' } }),
      { actionTitle: "Couldn't save webhook" },
    );
    const args = toastErrorMock.mock.calls[0];
    expect(args[0]).toBe("Couldn't save webhook");
    expect(args[1]?.description).toBeDefined();
  });

  it('does not toast on auth (401) — silent', () => {
    handleMutationError(
      new ApiError({ status: 401, message: 'x', body: {} }),
      { actionTitle: "Couldn't save" },
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('routes validation field errors to setFormError when provided', () => {
    const setFormError = vi.fn();
    handleMutationError(
      new ApiError({
        status: 422,
        message: 'x',
        body: {
          fields: [{ field: 'name', code: 'required', message: 'Required.' }],
        },
      }),
      { actionTitle: "Couldn't save", setFormError },
    );
    expect(setFormError).toHaveBeenCalledWith('name', { type: 'required', message: 'Required.' });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('falls back to a toast on validation when no setFormError given', () => {
    handleMutationError(
      new ApiError({ status: 422, message: 'x', body: { fields: [] } }),
      { actionTitle: "Couldn't save" },
    );
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleQueryError', () => {
  it('toasts on transport with the action title', () => {
    handleQueryError(new ApiError({ status: 0, message: 'net', isNetworkError: true }), {
      callSite: 'query',
      actionTitle: "Couldn't load workflows",
    });
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0][0]).toBe("Couldn't load workflows");
  });

  it('falls back to a generic title when actionTitle is omitted', () => {
    handleQueryError(new ApiError({ status: 500, message: 'x', body: {} }), {
      callSite: 'query',
    });
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock.mock.calls[0][0]).toBe("Couldn't load that");
  });

  it('does not toast for a cancelled request', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    handleQueryError(e, { callSite: 'query' });
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('throws to boundary on route_load + not_found', () => {
    const e = new ApiError({ status: 404, message: 'x', body: {} });
    expect(() => handleQueryError(e, { callSite: 'route_load' })).toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it('throws to boundary on route_load + permission', () => {
    const e = new ApiError({ status: 403, message: 'x', body: {} });
    expect(() => handleQueryError(e, { callSite: 'route_load' })).toThrow();
  });

  it('throws to boundary on route_load + server', () => {
    const e = new ApiError({ status: 500, message: 'x', body: {} });
    expect(() => handleQueryError(e, { callSite: 'route_load' })).toThrow();
  });
});
