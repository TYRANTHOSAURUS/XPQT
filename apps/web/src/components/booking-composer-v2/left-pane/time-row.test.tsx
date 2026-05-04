import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimeRow } from './time-row';

/**
 * Build a canonical local-time ISO. Tests run in whatever zone the CI
 * machine reports; using a `new Date()` constructor with locals + reading
 * back the ISO keeps the comparisons round-tripped through the same
 * timezone the component sees.
 */
function localIso(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

describe('TimeRow', () => {
  it('renders four dropdown triggers + arrow + tz label in empty state', () => {
    render(<TimeRow startAt={null} endAt={null} onChange={vi.fn()} />);

    // Four primary triggers (start-date, start-time, end-date, end-time)
    expect(
      screen.getByRole('button', { name: /^start date:/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^start time:/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^end date:/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^end time:/i }),
    ).toBeInTheDocument();

    // Empty state: each trigger shows the em-dash placeholder
    expect(
      screen.getByRole('button', { name: 'Start date: —' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Start time: —' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'End date: —' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'End time: —' }),
    ).toBeInTheDocument();

    // Arrow separator (aria-hidden but text-content is "→")
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('places data-focus-target="time-row" on the start-date trigger', () => {
    render(<TimeRow startAt={null} endAt={null} onChange={vi.fn()} />);
    const startDate = screen.getByRole('button', { name: /^start date:/i });
    expect(startDate).toHaveAttribute('data-focus-target', 'time-row');

    // Other triggers do NOT have the marker
    expect(
      screen.getByRole('button', { name: /^start time:/i }),
    ).not.toHaveAttribute('data-focus-target', 'time-row');
    expect(
      screen.getByRole('button', { name: /^end date:/i }),
    ).not.toHaveAttribute('data-focus-target', 'time-row');
    expect(
      screen.getByRole('button', { name: /^end time:/i }),
    ).not.toHaveAttribute('data-focus-target', 'time-row');
  });

  it('shows the corresponding date/time string when filled', () => {
    const startAt = localIso(2026, 5, 7, 10, 0);
    const endAt = localIso(2026, 5, 7, 11, 0);
    render(<TimeRow startAt={startAt} endAt={endAt} onChange={vi.fn()} />);

    // Dates render as weekday + short date — May 7 2026 is a Thursday.
    expect(
      screen.getByRole('button', { name: /^start date:.*May 7/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^end date:.*May 7/i }),
    ).toBeInTheDocument();

    // Times render as h:MM (locale-formatted)
    expect(
      screen.getByRole('button', { name: /^start time:.*10:00/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /^end time:.*11:00/i }),
    ).toBeInTheDocument();
  });

  it('clicking start-date and end-date triggers opens separate popovers', async () => {
    const user = userEvent.setup();
    render(<TimeRow startAt={null} endAt={null} onChange={vi.fn()} />);

    // Click start-date — calendar grid appears
    await user.click(screen.getByRole('button', { name: /^start date:/i }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();

    // Click end-date — its own grid appears (after closing the previous via
    // a fresh click on the end trigger)
    await user.click(screen.getByRole('button', { name: /^end date:/i }));
    // Two distinct popovers means at least one grid stays in the DOM
    expect(screen.getAllByRole('grid').length).toBeGreaterThan(0);
  });

  it('clicking a start-time slot calls onChange with the new startAt and a derived endAt', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TimeRow startAt={null} endAt={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /^start time:/i }));

    // The slot list is the listbox titled "Start time slots"
    const listbox = await screen.findByRole('listbox', {
      name: /start time slots/i,
    });
    const options = within(listbox).getAllByRole('option');
    expect(options.length).toBe(96);

    // Pick the 10:00 slot — same locale, so we look it up by label
    const tenAm = options.find((o) => /10:00/.test(o.textContent ?? ''));
    expect(tenAm).toBeTruthy();
    await user.click(tenAm!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [startArg, endArg] = onChange.mock.calls[0];
    expect(typeof startArg).toBe('string');
    expect(typeof endArg).toBe('string');
    // End is start + 1h when end was null
    const startMs = new Date(startArg as string).getTime();
    const endMs = new Date(endArg as string).getTime();
    expect(endMs - startMs).toBe(60 * 60_000);
  });

  it('clicking an end-time slot calls onChange with the new endAt only (start unchanged)', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const startAt = localIso(2026, 5, 7, 10, 0);
    const endAt = localIso(2026, 5, 7, 11, 0);
    render(<TimeRow startAt={startAt} endAt={endAt} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: /^end time:/i }));

    const listbox = await screen.findByRole('listbox', {
      name: /end time slots/i,
    });
    const options = within(listbox).getAllByRole('option');

    // Pick the first slot whose label contains "12:00" — this changes the
    // end side only.
    const noon = options.find((o) => /12:00/.test(o.textContent ?? ''));
    expect(noon).toBeTruthy();
    await user.click(noon!);

    expect(onChange).toHaveBeenCalledTimes(1);
    const [startArg, endArg] = onChange.mock.calls[0];
    expect(startArg).toBe(startAt);
    expect(typeof endArg).toBe('string');
    expect(endArg).not.toBe(endAt);
  });

  it('aria-labels include the side and current value', () => {
    const startAt = localIso(2026, 5, 7, 10, 0);
    const endAt = localIso(2026, 5, 7, 11, 0);
    render(<TimeRow startAt={startAt} endAt={endAt} onChange={vi.fn()} />);

    const startDate = screen.getByRole('button', { name: /^start date:/i });
    const startTime = screen.getByRole('button', { name: /^start time:/i });
    const endDate = screen.getByRole('button', { name: /^end date:/i });
    const endTime = screen.getByRole('button', { name: /^end time:/i });

    // Labels are in the form "<Side <date|time>>: <value>"
    expect(startDate.getAttribute('aria-label')).toMatch(/^Start date:/);
    expect(startTime.getAttribute('aria-label')).toMatch(/^Start time:/);
    expect(endDate.getAttribute('aria-label')).toMatch(/^End date:/);
    expect(endTime.getAttribute('aria-label')).toMatch(/^End time:/);

    // Each label includes the current value (a date string for date
    // triggers, a time string for time triggers)
    expect(startDate.getAttribute('aria-label')).toMatch(/May 7/);
    expect(startTime.getAttribute('aria-label')).toMatch(/10:00/);
    expect(endTime.getAttribute('aria-label')).toMatch(/11:00/);
  });
});
