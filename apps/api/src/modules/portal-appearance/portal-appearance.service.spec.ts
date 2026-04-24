// apps/api/src/modules/portal-appearance/portal-appearance.service.spec.ts
import { resolveAppearance } from './portal-appearance.service';

describe('resolveAppearance (pure walk-up)', () => {
  // Walk-up: start at location_id, walk up spaces.parent_id until we find a
  // row in portal_appearance, else fall back to tenant root, else null.
  it('returns the row for the exact location when present', () => {
    const rows = [
      { location_id: 'floor-4', hero_image_url: 'a.jpg', welcome_headline: null, supporting_line: null, greeting_enabled: true },
    ];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: 'site' },
      { id: 'site', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows, spaces)?.hero_image_url).toBe('a.jpg');
  });

  it('walks up to an ancestor when the exact location has no row', () => {
    const rows = [
      { location_id: 'building', hero_image_url: 'b.jpg', welcome_headline: null, supporting_line: null, greeting_enabled: true },
    ];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: 'site' },
      { id: 'site', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows, spaces)?.hero_image_url).toBe('b.jpg');
  });

  it('returns null when no ancestor has a row', () => {
    const rows: unknown[] = [];
    const spaces = [
      { id: 'floor-4', parent_id: 'building' },
      { id: 'building', parent_id: null },
    ];
    expect(resolveAppearance('floor-4', rows as any, spaces)).toBeNull();
  });

  it('stops at cycles (defensive)', () => {
    const rows: unknown[] = [];
    const spaces = [
      { id: 'a', parent_id: 'b' },
      { id: 'b', parent_id: 'a' },
    ];
    expect(resolveAppearance('a', rows as any, spaces)).toBeNull();
  });
});
