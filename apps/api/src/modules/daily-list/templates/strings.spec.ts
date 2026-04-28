import { getStrings, type DailyListLocale } from './strings';

describe('daily-list strings bundles', () => {
  const LOCALES: DailyListLocale[] = ['nl', 'fr', 'en', 'de'];

  it('every locale has the same set of keys (no orphans, no holes)', () => {
    /* Sentinel: NL is the canonical bundle; if FR/EN/DE diverge, the
       template will silently render `undefined` for the missing key. */
    const expected = new Set(Object.keys(getStrings('nl')));
    for (const locale of LOCALES) {
      const actual = new Set(Object.keys(getStrings(locale)));
      expect(actual).toEqual(expected);
    }
  });

  it('falls back to NL on null / unknown locale', () => {
    expect(getStrings(null).header).toBe('Daglijst catering');
    expect(getStrings(undefined).header).toBe('Daglijst catering');
    expect(getStrings('zh-CN').header).toBe('Daglijst catering');
  });

  it('formatDate produces locale-natural long-form dates', () => {
    expect(getStrings('nl').formatDate('2026-05-01')).toBe('1 mei 2026');
    expect(getStrings('fr').formatDate('2026-05-01')).toBe('1 mai 2026');
    expect(getStrings('en').formatDate('2026-05-01')).toBe('1 May 2026');
    expect(getStrings('de').formatDate('2026-05-01')).toBe('1 Mai 2026');
  });

  it('headcountSuffix handles singular vs plural per language', () => {
    expect(getStrings('nl').headcountSuffix(1)).toContain('persoon');
    expect(getStrings('nl').headcountSuffix(5)).toContain('personen');
    expect(getStrings('fr').headcountSuffix(1)).toContain('personne');
    expect(getStrings('fr').headcountSuffix(5)).toContain('personnes');
    expect(getStrings('en').headcountSuffix(1)).toContain('person');
    expect(getStrings('en').headcountSuffix(5)).toContain('people');
    expect(getStrings('de').headcountSuffix(1)).toContain('Person');
    expect(getStrings('de').headcountSuffix(5)).toContain('Personen');
  });

  it('document title + header are different per locale (sanity)', () => {
    const titles = LOCALES.map((l) => getStrings(l).header);
    /* All four bundles must produce distinct headers — if two are the
       same, a translator probably copy-pasted. */
    expect(new Set(titles).size).toBe(4);
  });
});
