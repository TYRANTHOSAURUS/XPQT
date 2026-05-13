/**
 * Render tests for the InboxBell.
 *
 * Spec: /tmp/b4a5-plan-v2.md sub-step F. Three scenarios:
 *   1. unread > 0 → badge visible with the right count
 *   2. unread === 0 → no badge (icon only)
 *   3. clicking the trigger opens the popover with the latest items
 *
 * apiFetch is mocked at the module boundary so we don't make HTTP and the
 * fixture is the only source of data. Auth context is faked via a vi.mock
 * on the auth provider so the component renders unconditionally.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { InboxBell } from '../inbox-bell';

// Auth — always return a logged-in actor so the bell mounts its inner.
vi.mock('@/providers/auth-provider', () => ({
  useAuth: () => ({
    appUser: { id: 'u1', person_id: 'p1', tenant_id: 't1', roles: [] },
  }),
}));

// supabase — apiFetch's getAuthHeaders calls supabase.auth.getSession().
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: null } })) },
  },
}));

// apiFetch — script per-test responses.
const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetchMock(path, opts),
  ApiError: class ApiError extends Error {
    status = 0;
    body: unknown;
  },
}));

function renderBell() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <InboxBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('InboxBell', () => {
  it('shows the unread badge when count > 0', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/me/inbox/count') return Promise.resolve({ unread: 7, total: 12 });
      if (path === '/me/inbox') return Promise.resolve({ items: [], nextCursor: null });
      throw new Error(`Unexpected fetch ${path}`);
    });
    renderBell();
    // Trigger label reflects the unread count for screen readers.
    await waitFor(() => {
      expect(screen.getByLabelText(/Inbox — 7 unread notifications/i)).toBeInTheDocument();
    });
    // Badge visible with 7.
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('hides the unread badge when count === 0', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/me/inbox/count') return Promise.resolve({ unread: 0, total: 0 });
      if (path === '/me/inbox') return Promise.resolve({ items: [], nextCursor: null });
      throw new Error(`Unexpected fetch ${path}`);
    });
    renderBell();
    await waitFor(() => {
      expect(screen.getByLabelText(/^Inbox$/i)).toBeInTheDocument();
    });
    // No "0" badge — the unread count of 0 should not paint a badge.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('opens a popover with the latest items on click', async () => {
    apiFetchMock.mockImplementation((path: string) => {
      if (path === '/me/inbox/count') return Promise.resolve({ unread: 1, total: 1 });
      if (path === '/me/inbox') {
        return Promise.resolve({
          items: [
            {
              id: 'n1',
              eventKind: 'booking.approval_required',
              payload: {},
              readAt: null,
              createdAt: new Date().toISOString(),
              summary: 'Approval needed for Friday team lunch',
            },
          ],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected fetch ${path}`);
    });
    renderBell();

    // Wait for the trigger to be ready, then click.
    const trigger = await screen.findByLabelText(/Inbox — 1 unread/i);
    await userEvent.click(trigger);

    // Popover content (item summary) becomes visible.
    expect(
      await screen.findByText('Approval needed for Friday team lunch'),
    ).toBeInTheDocument();
    // View all link present in the footer.
    expect(screen.getByRole('link', { name: 'View all' })).toBeInTheDocument();
  });
});
