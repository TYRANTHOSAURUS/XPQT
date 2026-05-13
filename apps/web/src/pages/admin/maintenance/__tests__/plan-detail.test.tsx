import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: null } })),
    },
  },
}));

import { MaintenancePlanDetailPage } from '../plan-detail';

const SAMPLE_PLAN = {
  id: 'plan-1',
  tenant_id: 'tenant-1',
  name: 'Monthly HVAC filter swap',
  description: null,
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

interface MockState {
  plan: typeof SAMPLE_PLAN;
  patches: Array<Record<string, unknown>>;
}

function installFetchMock(state: MockState) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'PATCH' && url.includes('/admin/maintenance/plans/plan-1')) {
      const patch = init?.body ? JSON.parse(String(init.body)) : {};
      state.patches.push(patch);
      state.plan = { ...state.plan, ...patch };
      return new Response(JSON.stringify(state.plan), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    let body: unknown = null;
    if (url.includes('/admin/maintenance/plans/plan-1')) body = state.plan;
    else if (url.includes('/asset-types'))
      body = [{ id: 'type-hvac', name: 'HVAC' }];
    else if (url.includes('/assets'))
      body = [{ id: 'asset-1', name: 'Boiler 1' }];
    else if (url.includes('/request-types'))
      body = [{ id: 'rt-maint', name: 'Maintenance' }];
    else body = [];

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return { fetchMock, restore: () => (globalThis.fetch = original) };
}

function renderDetail() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/maintenance/plans/plan-1']}>
        <Routes>
          <Route
            path="/admin/maintenance/plans/:id"
            element={<MaintenancePlanDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MaintenancePlanDetailPage', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
    vi.restoreAllMocks();
  });

  it('renders the plan name in the header', async () => {
    const state: MockState = { plan: SAMPLE_PLAN, patches: [] };
    ({ restore } = installFetchMock(state));

    renderDetail();

    await waitFor(() =>
      expect(
        screen.getByRole('heading', { name: 'Monthly HVAC filter swap' }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('active')).toBeInTheDocument();
  });

  it('renders the schedule preview using the saved recurrence', async () => {
    const state: MockState = { plan: SAMPLE_PLAN, patches: [] };
    ({ restore } = installFetchMock(state));

    renderDetail();

    await waitFor(() =>
      expect(screen.getByText(/Every 1 month, 7 days ahead/i)).toBeInTheDocument(),
    );
  });

  it('opens the asset picker dialog when the Specific asset row is clicked', async () => {
    const state: MockState = { plan: SAMPLE_PLAN, patches: [] };
    ({ restore } = installFetchMock(state));

    renderDetail();

    await waitFor(() =>
      expect(screen.getByText('Specific asset')).toBeInTheDocument(),
    );

    const specificAssetRow = screen.getByRole('button', { name: /Specific asset/i });
    await userEvent.click(specificAssetRow);

    await waitFor(() =>
      expect(screen.getByText('Pick asset')).toBeInTheDocument(),
    );

    // The dialog's Save button is initially disabled because the current
    // plan has no asset_id selected — the mutex switch hasn't happened yet.
    const saveBtn = screen.getByRole('button', { name: /^Save$/i });
    expect(saveBtn).toBeDisabled();
  });

  it('toggles active via the Identity row switch', async () => {
    const state: MockState = { plan: SAMPLE_PLAN, patches: [] };
    ({ restore } = installFetchMock(state));

    renderDetail();

    await waitFor(() =>
      expect(screen.getByText(/When off, the generator skips/i)).toBeInTheDocument(),
    );

    const activeSwitch = screen.getByRole('switch');
    await userEvent.click(activeSwitch);

    await waitFor(() => expect(state.patches.length).toBeGreaterThan(0));
    expect(state.patches.at(-1)).toEqual({ active: false });
  });
});
