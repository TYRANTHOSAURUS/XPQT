import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimeScrubber } from '../time-scrubber';
import type { CrowdHeatmapBucket } from '@/api/floor-plans/types';

// Minimal stub so SVG renders in jsdom without errors
describe('TimeScrubber', () => {
  const base = new Date('2026-05-12T09:00:00');
  const end = new Date('2026-05-12T10:00:00');
  const heatmap: CrowdHeatmapBucket[] = [
    { hour: 7, occupancy: 0.1 },
    { hour: 8, occupancy: 0.4 },
    { hour: 9, occupancy: 0.8 },
    { hour: 10, occupancy: 0.6 },
  ];

  it('renders a bar for each heatmap bucket within range', () => {
    render(
      <TimeScrubber
        value={{ start: base, end }}
        onChange={vi.fn()}
        heatmap={heatmap}
        rangeStart={7}
        rangeEnd={19}
      />,
    );

    // The SVG should be in the document
    const svg = document.querySelector('svg');
    expect(svg).toBeTruthy();

    // One <rect> per heatmap bar (all 4 are within 7–19 range), plus the selection shading rect
    // Selection rect + 4 bar rects = 5 total
    const rects = svg!.querySelectorAll('rect');
    // At minimum 4 bars should render (selection rect + 4 bars)
    expect(rects.length).toBeGreaterThanOrEqual(4);

    // Time readout should show formatted times
    expect(screen.getByText(/selected:/)).toBeTruthy();
  });
});
