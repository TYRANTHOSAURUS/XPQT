import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

import { MaintenancePlansPage } from '../plans';

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/maintenance/plans']}>
        <MaintenancePlansPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFetch(handler: (url: string) => unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const body = handler(url);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return { fetchMock, restore: () => (globalThis.fetch = original) };
}

const SAMPLE_PLAN = {
  id: 'plan-1',
  tenant_id: 'tenant-1',
  name: 'Monthly HVAC filter swap',
  description: 'Building A',
  active: true,
  asset_id: null,
  asset_type_id: 'type-hvac',
  request_type_id: 'rt-maint',
  location_id: null,
  title_template: '{{asset.name}} filter swap',
  description_template: null,
  priority: 'medium' as const,
  planned_duration_minutes: 60,
  recurrence_interval: 1,
  recurrence_unit: 'month' as const,
  anchor_date: '2026-06-01',
  lead_days: 7,
  next_run_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
  last_completed_at: null,
  last_generated_at: null,
  created_at: '2026-05-12T00:00:00Z',
  updated_at: '2026-05-12T00:00:00Z',
  created_by: null,
  updated_by: null,
};

describe('MaintenancePlansPage', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  it('renders the empty state when no plans exist', async () => {
    ({ restore } = mockFetch((url) => {
      if (url.includes('/admin/maintenance/plans')) return { rows: [], total: 0 };
      if (url.includes('/assets')) return [];
      if (url.includes('/asset-types')) return [];
      if (url.includes('/request-types')) return [];
      return [];
    }));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('No maintenance plans yet')).toBeInTheDocument(),
    );
    expect(
      screen.getByRole('button', { name: /create your first plan/i }),
    ).toBeInTheDocument();
  });

  it('renders rows for a populated list with target + recurrence', async () => {
    ({ restore } = mockFetch((url) => {
      if (url.includes('/admin/maintenance/plans'))
        return { rows: [SAMPLE_PLAN], total: 1 };
      if (url.includes('/asset-types'))
        return [{ id: 'type-hvac', name: 'HVAC' }];
      if (url.includes('/assets')) return [];
      if (url.includes('/request-types'))
        return [{ id: 'rt-maint', name: 'Maintenance' }];
      return [];
    }));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('Monthly HVAC filter swap')).toBeInTheDocument(),
    );
    expect(screen.getByText('All HVAC')).toBeInTheDocument();
    expect(screen.getByText('Maintenance')).toBeInTheDocument();
    expect(screen.getByText('Every 1 month')).toBeInTheDocument();
  });

  it('opens the create dialog when the header CTA is clicked', async () => {
    ({ restore } = mockFetch((url) => {
      if (url.includes('/admin/maintenance/plans')) return { rows: [], total: 0 };
      if (url.includes('/assets')) return [];
      if (url.includes('/asset-types')) return [];
      if (url.includes('/request-types')) return [];
      return [];
    }));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText('No maintenance plans yet')).toBeInTheDocument(),
    );
    const ctas = screen.getAllByRole('button', { name: /new plan|create your first plan/i });
    ctas[0].click();
    await waitFor(() =>
      expect(screen.getByText('New maintenance plan')).toBeInTheDocument(),
    );
  });
});
