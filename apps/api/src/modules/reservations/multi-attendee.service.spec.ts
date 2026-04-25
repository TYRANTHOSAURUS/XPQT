import { mergeIntervals, subtractIntervals } from './multi-attendee.service';

describe('multi-attendee interval math', () => {
  describe('mergeIntervals', () => {
    it('returns empty for empty input', () => {
      expect(mergeIntervals([])).toEqual([]);
    });

    it('passes through non-overlapping intervals (sorted)', () => {
      expect(mergeIntervals([[0, 1], [2, 3], [4, 5]])).toEqual([[0, 1], [2, 3], [4, 5]]);
    });

    it('merges overlapping intervals', () => {
      expect(mergeIntervals([[0, 5], [3, 7], [6, 10]])).toEqual([[0, 10]]);
    });

    it('merges touching intervals', () => {
      expect(mergeIntervals([[0, 5], [5, 10]])).toEqual([[0, 10]]);
    });

    it('sorts unsorted input before merging', () => {
      expect(mergeIntervals([[5, 10], [0, 5], [12, 15]])).toEqual([[0, 10], [12, 15]]);
    });
  });

  describe('subtractIntervals', () => {
    it('returns full window when busy is empty', () => {
      expect(subtractIntervals([0, 100], [])).toEqual([[0, 100]]);
    });

    it('cuts a single busy interval out of the middle', () => {
      expect(subtractIntervals([0, 100], [[40, 60]])).toEqual([[0, 40], [60, 100]]);
    });

    it('removes leading window when busy starts at the window', () => {
      expect(subtractIntervals([0, 100], [[0, 30]])).toEqual([[30, 100]]);
    });

    it('removes trailing window when busy ends at the window', () => {
      expect(subtractIntervals([0, 100], [[70, 100]])).toEqual([[0, 70]]);
    });

    it('returns empty when busy fully covers the window', () => {
      expect(subtractIntervals([10, 90], [[0, 100]])).toEqual([]);
    });

    it('handles multiple busy intervals', () => {
      expect(subtractIntervals([0, 100], [[10, 20], [40, 50], [80, 90]])).toEqual([
        [0, 10], [20, 40], [50, 80], [90, 100],
      ]);
    });

    it('ignores busy intervals outside the window', () => {
      expect(subtractIntervals([10, 90], [[0, 5], [95, 100]])).toEqual([[10, 90]]);
    });
  });
});
