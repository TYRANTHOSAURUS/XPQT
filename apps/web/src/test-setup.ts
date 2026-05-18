import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement window.matchMedia — stub it so hooks like
// useIsMobile() don't throw in tests. Default: desktop (not mobile).
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom doesn't implement ResizeObserver — stub it so cmdk + Radix UI
// primitives that observe their popover/list dimensions don't throw.
class ResizeObserverStub implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub;
}

// jsdom doesn't implement Element.prototype.scrollIntoView — stub it
// so cmdk's auto-scroll-to-selected behavior doesn't throw.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView(): void {};
}
