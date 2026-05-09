import { describe, expect, it, vi, beforeEach } from 'vitest';
import { Component, type ReactNode } from 'react';
import { render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from '@/lib/api';
import { usePageQuery } from '../use-page-query';

interface BoundaryState {
  caught: unknown;
}

class TestBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { caught: null };
  static getDerivedStateFromError(error: unknown) {
    return { caught: error };
  }
  componentDidCatch() {
    /* swallow for the test */
  }
  render() {
    if (this.state.caught) {
      const e = this.state.caught;
      const msg = e instanceof Error ? e.message : 'caught';
      return <div data-testid="boundary">{msg}</div>;
    }
    return this.props.children;
  }
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
}

let probeCounter = 0;
function Probe({
  queryFn,
  testKey,
}: {
  queryFn: () => Promise<unknown>;
  testKey: string;
}) {
  const result = usePageQuery({ queryKey: ['probe', testKey], queryFn });
  if (result.isLoading) return <div data-testid="loading">loading</div>;
  if (result.isError) return <div data-testid="rendered-error">{(result.error as Error).message}</div>;
  return <div data-testid="data">{String(result.data)}</div>;
}

beforeEach(() => {
  // Silence React's "componentDidCatch" log noise during the boundary test
  vi.spyOn(console, 'error').mockImplementation(() => {});
  probeCounter += 1;
});

describe('usePageQuery', () => {
  it('throws to boundary on a 404 (not_found)', async () => {
    const queryFn = () =>
      Promise.reject(new ApiError({ status: 404, message: 'gone', body: {} }));
    const { findByTestId } = render(
      <QueryClientProvider client={makeClient()}>
        <TestBoundary>
          <Probe queryFn={queryFn} testKey={`k-404-${probeCounter}`} />
        </TestBoundary>
      </QueryClientProvider>,
    );
    await findByTestId('boundary');
  });

  it('throws to boundary on a 500 (server)', async () => {
    const queryFn = () =>
      Promise.reject(new ApiError({ status: 500, message: 'boom', body: {} }));
    const { findByTestId } = render(
      <QueryClientProvider client={makeClient()}>
        <TestBoundary>
          <Probe queryFn={queryFn} testKey={`k-500-${probeCounter}`} />
        </TestBoundary>
      </QueryClientProvider>,
    );
    await findByTestId('boundary');
  });

  it('throws to boundary on a 403 (permission)', async () => {
    const queryFn = () =>
      Promise.reject(new ApiError({ status: 403, message: 'no', body: {} }));
    const { findByTestId } = render(
      <QueryClientProvider client={makeClient()}>
        <TestBoundary>
          <Probe queryFn={queryFn} testKey={`k-403-${probeCounter}`} />
        </TestBoundary>
      </QueryClientProvider>,
    );
    await findByTestId('boundary');
  });

  it('does NOT throw to boundary on a transient transport error', async () => {
    const queryFn = () =>
      Promise.reject(new ApiError({ status: 0, message: 'net', isNetworkError: true }));
    const { findByTestId, queryByTestId } = render(
      <QueryClientProvider client={makeClient()}>
        <TestBoundary>
          <Probe queryFn={queryFn} testKey={`k-net-${probeCounter}`} />
        </TestBoundary>
      </QueryClientProvider>,
    );
    await findByTestId('rendered-error');
    expect(queryByTestId('boundary')).toBeNull();
  });

  it('renders the data when the query resolves', async () => {
    const { findByTestId } = render(
      <QueryClientProvider client={makeClient()}>
        <TestBoundary>
          <Probe
            queryFn={() => Promise.resolve('ok')}
            testKey={`k-ok-${probeCounter}`}
          />
        </TestBoundary>
      </QueryClientProvider>,
    );
    await waitFor(async () => {
      const node = await findByTestId('data');
      expect(node.textContent).toBe('ok');
    });
  });
});
